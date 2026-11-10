"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, useEdges, useNodes, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { PORT_COLORS } from "@/lib/registry";
import { usePlayableVideo } from "@/lib/use-playable-video";
import {
  buildMiniMaxRequest,
  MINIMAX_CONFIRM_ABOVE_USD,
  MINIMAX_DEFAULTS,
  MINIMAX_MODELS,
  MINIMAX_RATES,
  MINIMAX_RATIOS,
  MINIMAX_TASKS,
  MINIMAX_VARIANTS,
  minimaxDefaultRatio,
  minimaxDefaultResolution,
  minimaxResolutions,
  minimaxTaskSupported,
  normalizeMiniMaxParams,
  type MiniMaxReference,
  type MiniMaxResolvedInputs,
} from "@/lib/minimax";
import {
  getMiniMaxPrediction,
  submitMiniMaxPrediction,
  uploadMiniMaxMedia,
  wanDataUrlToFile,
} from "@/lib/wan-api";

type Props = {
  nodeId: string;
  nodeData: Record<string, unknown>;
};

type FlowNode = ReturnType<typeof useNodes>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown) {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function sourceValue(node: FlowNode | undefined, handle: string) {
  const data = record(node?.data);
  const params = record(data.params);
  const outputs = record(data.outputs);
  if (data.type === "input/image" && handle === "image") return params.url;
  if (data.type === "input/prompt" && handle === "text") {
    return params.assistant_enabled === true
      ? params.refined_prompt || params.text || outputs.text
      : params.text || outputs.text;
  }
  if (handle in outputs) return outputs[handle];
  return undefined;
}

function mediaUrl(value: unknown): string {
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? value : "";
  if (!isRecord(value)) return "";
  if (typeof value.url === "string") return mediaUrl(value.url);
  if (typeof value.value === "string") return mediaUrl(value.value);
  return "";
}

function miniMaxLocalFile(value: unknown, fallbackName: string): File | null {
  if (value instanceof File) return value;
  if (typeof value === "string" && value.startsWith("data:")) {
    return wanDataUrlToFile(value, fallbackName, "");
  }
  if (!isRecord(value)) return null;
  if (value.file instanceof File) return value.file;
  if (typeof value.url === "string") return miniMaxLocalFile(value.url, stringValue(value.name) || fallbackName);
  if (typeof value.dataUrl === "string") {
    return wanDataUrlToFile(value.dataUrl, stringValue(value.name) || fallbackName, stringValue(value.type));
  }
  if (typeof value.value === "string") return miniMaxLocalFile(value.value, stringValue(value.name) || fallbackName);
  return null;
}

function isLocalMiniMaxMedia(value: unknown) {
  return typeof value === "string"
    ? value.startsWith("data:")
    : value instanceof File
      || (isRecord(value) && (value.local === true || typeof value.id === "string"
      || typeof value.dataUrl === "string" || value.file instanceof File
      || (typeof value.url === "string" && value.url.startsWith("data:"))));
}

function inputHandle(edge: ReturnType<typeof useEdges>[number]) {
  const handle = edge.targetHandle ?? "";
  if (handle === "references") return "image";
  if (/^reference_video_\d+$/.test(handle)) return "video";
  if (/^reference_audio_\d+$/.test(handle)) return "audio";
  return null;
}

function videoUrl(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = videoUrl(item);
      if (url) return url;
    }
  } else if (isRecord(value)) {
    for (const key of ["url", "video", "outputs", "output", "data"]) {
      const url = videoUrl(value[key]);
      if (url) return url;
    }
  }
  return "";
}

function atlasError(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (isRecord(value) && typeof value.message === "string" && value.message) return value.message;
  return "Atlas reported that MiniMax generation failed.";
}

function MiniMaxInputPort({
  id,
  label,
  type,
  disabled = false,
  title,
}: {
  id: string;
  label: string;
  type: "text" | "image" | "video" | "audio";
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="ff-port ff-in ff-minimax-port" title={title}>
      <Handle
        type="target"
        position={Position.Left}
        id={id}
        isConnectable={!disabled}
        style={{ background: PORT_COLORS[type], opacity: disabled ? 0.4 : 1 }}
      />
      {label}
    </div>
  );
}

export default function MiniMaxNodeControls({ nodeId, nodeData }: Props) {
  const nodes = useNodes();
  const edges = useEdges();
  const { addEdges, addNodes, deleteElements, getEdges, getNode, getNodes, updateNodeData } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBody, setPreviewBody] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [pollError, setPollError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [statusLine, setStatusLine] = useState("Idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const mounted = useRef(true);
  const pollController = useRef<AbortController | null>(null);

  const params = useMemo(() => normalizeMiniMaxParams(record(nodeData.params)), [nodeData.params]);
  const playable = usePlayableVideo(params.last_output_url || undefined);
  const connectedEdges = useMemo(() => edges.filter((edge) => edge.target === nodeId), [edges, nodeId]);
  const incomingByHandle = useMemo(
    () => new Map(connectedEdges.map((edge) => [edge.targetHandle ?? "", edge])),
    [connectedEdges],
  );

  const setMiniMaxParams = (patch: Record<string, unknown>) => {
    if (!getNode(nodeId)) return;
    updateNodeData(nodeId, (current: { data: Record<string, unknown> }) => ({
      params: {
        ...normalizeMiniMaxParams(record(current.data.params)),
        ...patch,
      },
    }));
  };

  const setMiniMaxState = (
    line: string,
    detail = "",
    status: "idle" | "running" | "done" | "error" = "idle",
  ) => {
    if (!mounted.current || !getNode(nodeId)) return;
    setStatusLine(line);
    setStatusDetail(detail);
    updateNodeData(nodeId, { status });
  };

  const resolvedInputs = useMemo<MiniMaxResolvedInputs>(() => {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const promptEdge = incomingByHandle.get("prompt");
    const imageEdge = incomingByHandle.get("image");
    const endImageEdge = incomingByHandle.get("end_image");
    const references: MiniMaxReference[] = connectedEdges.flatMap((edge) => {
      const type = inputHandle(edge);
      if (!type) return [];
      return [{
        type,
        value: sourceValue(nodesById.get(edge.source), edge.sourceHandle ?? ""),
      }];
    });
    return {
      prompt: promptEdge
        ? sourceValue(nodesById.get(promptEdge.source), promptEdge.sourceHandle ?? "text")
        : "",
      image: imageEdge ? sourceValue(nodesById.get(imageEdge.source), imageEdge.sourceHandle ?? "image") : undefined,
      end_image: endImageEdge
        ? sourceValue(nodesById.get(endImageEdge.source), endImageEdge.sourceHandle ?? "image")
        : undefined,
      refers: references,
    };
  }, [connectedEdges, incomingByHandle, nodes]);

  const request = useMemo(
    () => buildMiniMaxRequest({ params }, resolvedInputs),
    [params, resolvedInputs],
  );
  const promptText = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  const imageEdges = connectedEdges.filter((edge) => edge.targetHandle === "references");
  const videoEdges = connectedEdges.filter((edge) => /^reference_video_\d+$/.test(edge.targetHandle ?? ""));
  const audioEdges = connectedEdges.filter((edge) => /^reference_audio_\d+$/.test(edge.targetHandle ?? ""));
  const referenceCount = imageEdges.length + videoEdges.length + audioEdges.length;
  const videoReferenceConnected = videoEdges.length > 0;
  const modelRate = MINIMAX_RATES[params.model] ?? MINIMAX_RATES[MINIMAX_DEFAULTS.model];
  const estimatedMinimum = Number(params.duration) * modelRate;
  const estimatedCost = `from ~$${estimatedMinimum.toFixed(3)} (base rate; higher resolutions and enhanced tiers may cost more)`;
  const needConfirmation = estimatedMinimum > MINIMAX_CONFIRM_ABOVE_USD;
  const task = params.task;
  const model = params.model;

  const validHandles = useCallback((nextTask: string) => new Set([
    "prompt",
    ...(nextTask === MINIMAX_TASKS["Image to video"] ? ["image", "end_image"] : []),
    ...(nextTask === MINIMAX_TASKS["Reference to video"]
      ? ["references", ...Array.from({ length: 5 }, (_, index) => `reference_video_${index + 1}`),
        ...Array.from({ length: 5 }, (_, index) => `reference_audio_${index + 1}`)]
      : []),
  ]), []);

  const syncInputs = useCallback(async (nextTask: string, requestedCount: number) => {
    const wantedRoles = new Set(
      nextTask === MINIMAX_TASKS["Image to video"]
        ? ["first_frame", "last_frame"]
        : nextTask === MINIMAX_TASKS["Reference to video"]
          ? Array.from({ length: requestedCount }, (_, index) => `reference_image_${index + 1}`)
          : [],
    );
    const autoInputs = getNodes().filter((candidate) => {
      const data = record(candidate.data);
      return data.autoCreatedFor === nodeId;
    });
    const obsolete = autoInputs.filter((candidate) =>
      !wantedRoles.has(stringValue(record(candidate.data).autoCreatedRole)),
    );
    const obsoleteIds = new Set(obsolete.map((candidate) => candidate.id));
    const keepHandles = validHandles(nextTask);
    const staleEdges = getEdges().filter((edge) =>
      (edge.target === nodeId && !keepHandles.has(edge.targetHandle ?? ""))
      || obsoleteIds.has(edge.source),
    );
    if (obsolete.length || staleEdges.length) {
      await deleteElements({
        nodes: obsolete.map((candidate) => ({ id: candidate.id })),
        edges: staleEdges,
      });
    }

    const retained = autoInputs.filter((candidate) => !obsoleteIds.has(candidate.id));
    const presentRoles = new Set(retained.map((candidate) => stringValue(record(candidate.data).autoCreatedRole)));
    const requested = [...wantedRoles].filter((role) => !presentRoles.has(role)).map((role) => {
      const index = Number(role.split("_").at(-1)) || 1;
      const frame = role === "first_frame" || role === "last_frame";
      const label = role === "first_frame" ? "First frame"
        : role === "last_frame" ? "Last frame"
          : `Reference ${index}`;
      const targetHandle = role === "first_frame" ? "image"
        : role === "last_frame" ? "end_image" : "references";
      const target = getNode(nodeId);
      const imageId = `input/image-${crypto.randomUUID()}`;
      const y = role === "first_frame" ? -100
        : role === "last_frame" ? 110
          : (index - Math.max(1, requestedCount) / 2) * 105;
      return {
        node: {
          id: imageId,
          type: "workflow",
          position: { x: (target?.position.x ?? 400) - 360, y: (target?.position.y ?? 200) + y },
          data: {
            type: "input/image",
            params: { url: "" },
            status: "idle",
            outputs: {},
            log: "",
            title: label,
            paramLabels: { url: `${label} image (upload or paste URL)` },
            autoCreatedFor: nodeId,
            autoCreatedRole: role,
          },
        },
        edge: {
          id: `${imageId}-${nodeId}-${role}`,
          source: imageId,
          sourceHandle: "image",
          target: nodeId,
          targetHandle,
        },
        frame,
      };
    });
    if (!requested.length) return;
    addNodes(requested.map(({ node }) => node));
    window.requestAnimationFrame(() => {
      updateNodeInternals(nodeId);
      window.requestAnimationFrame(() => {
        const currentParams = record(record(getNode(nodeId)?.data).params);
        if (currentParams.task === nextTask) addEdges(requested.map(({ edge }) => edge));
      });
    });
  }, [addEdges, addNodes, deleteElements, getEdges, getNode, getNodes, nodeId, updateNodeInternals, validHandles]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => updateNodeInternals(nodeId));
    void syncInputs(task, params.reference_image_count).catch((error: unknown) => {
      setSyncError(error instanceof Error ? error.message : "MiniMax inputs could not be synchronized.");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodeId, params.reference_image_count, syncInputs, task, updateNodeInternals]);

  useEffect(() => {
    if (params.last_output_url && record(nodeData.outputs).video !== params.last_output_url) {
      updateNodeData(nodeId, { outputs: { video: params.last_output_url }, status: "done" });
    }
  }, [nodeData.outputs, nodeId, params.last_output_url, updateNodeData]);

  const changeTask = async (nextTask: string) => {
    if (!minimaxTaskSupported(model, nextTask)) return;
    setConfirmationOpen(false);
    setGenerationError("");
    setSyncError("");
    const keepHandles = validHandles(nextTask);
    const staleEdges = getEdges().filter((edge) =>
      edge.target === nodeId && !keepHandles.has(edge.targetHandle ?? ""),
    );
    try {
      if (staleEdges.length) await deleteElements({ edges: staleEdges });
      const resolutions = minimaxResolutions(model, nextTask);
      setMiniMaxParams({
        task: nextTask,
        resolution: resolutions.includes(params.resolution)
          ? params.resolution
          : resolutions.includes(minimaxDefaultResolution(model))
            ? minimaxDefaultResolution(model)
            : resolutions[0],
        ratio: minimaxDefaultRatio(model, nextTask),
      });
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "MiniMax connections could not be updated.");
    }
  };

  const changeModel = async (nextModel: string) => {
    if (!Object.values(MINIMAX_MODELS).includes(nextModel as (typeof MINIMAX_MODELS)[keyof typeof MINIMAX_MODELS])) return;
    const nextTask = minimaxTaskSupported(nextModel, task)
      ? task
      : MINIMAX_TASKS["Text to video"];
    const nextResolutions = minimaxResolutions(nextModel, nextTask);
    const minDuration = MINIMAX_VARIANTS[nextModel as keyof typeof MINIMAX_VARIANTS].minDuration;
    const nextDuration = params.duration >= minDuration && params.duration <= 15 ? params.duration : 8;
    const nextResolution = nextResolutions.includes(params.resolution)
      ? params.resolution
      : nextResolutions.includes(minimaxDefaultResolution(nextModel))
        ? minimaxDefaultResolution(nextModel)
        : nextResolutions[0];
    const nextRatioOptions = nextTask === MINIMAX_TASKS["Text to video"]
      ? [...MINIMAX_RATIOS]
      : nextTask === MINIMAX_TASKS["Image to video"]
        ? ["adaptive"]
        : nextModel === MINIMAX_MODELS["MiniMax H3 Fast"]
          ? [...MINIMAX_RATIOS]
          : ["adaptive", ...MINIMAX_RATIOS];
    const nextRatio = nextRatioOptions.includes(params.ratio)
      ? params.ratio
      : minimaxDefaultRatio(nextModel, nextTask);
    if (nextTask !== task) {
      const keepHandles = validHandles(nextTask);
      const staleEdges = getEdges().filter((edge) =>
        edge.target === nodeId && !keepHandles.has(edge.targetHandle ?? ""),
      );
      try {
        if (staleEdges.length) await deleteElements({ edges: staleEdges });
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : "MiniMax connections could not be updated.");
        return;
      }
    }
    setConfirmationOpen(false);
    setMiniMaxParams({
      model: nextModel,
      task: nextTask,
      duration: nextDuration,
      resolution: nextResolution,
      ratio: nextRatio,
      prompt_expansion: nextModel === MINIMAX_MODELS["MiniMax H3 Max Turbo"] ? false : params.prompt_expansion,
    });
  };

  const addReferenceImage = () => {
    if (task !== MINIMAX_TASKS["Reference to video"]) return;
    setMiniMaxParams({ reference_image_count: params.reference_image_count + 1 });
  };

  const uploadInputs = async (inputs: MiniMaxResolvedInputs) => {
    const media: Array<{ key: string; value: unknown; name: string }> = [];
    if (isLocalMiniMaxMedia(inputs.image)) media.push({ key: "image", value: inputs.image, name: "first-frame" });
    if (isLocalMiniMaxMedia(inputs.end_image)) media.push({ key: "end_image", value: inputs.end_image, name: "end-frame" });
    (inputs.refers ?? []).forEach((reference, index) => {
      if (isLocalMiniMaxMedia(reference.value)) {
        media.push({ key: `refers:${index}`, value: reference.value, name: `reference-${index + 1}` });
      }
    });
    const urls = new Map<string, string>();
    for (let index = 0; index < media.length; index++) {
      const entry = media[index];
      setUploadStatus(`Uploading ${index + 1} of ${media.length}`);
      const file = miniMaxLocalFile(entry.value, entry.name);
      if (!file) throw new Error(`Could not read local ${entry.name} media.`);
      urls.set(entry.key, await uploadMiniMaxMedia(file));
    }
    return {
      ...inputs,
      ...(inputs.image !== undefined
        ? { image: urls.get("image") ?? (mediaUrl(inputs.image) || inputs.image) }
        : {}),
      ...(inputs.end_image !== undefined
        ? { end_image: urls.get("end_image") ?? (mediaUrl(inputs.end_image) || inputs.end_image) }
        : {}),
      refers: (inputs.refers ?? []).map((reference, index) => ({
        ...reference,
        value: urls.get(`refers:${index}`) ?? (mediaUrl(reference.value) || reference.value),
      })),
    };
  };

  const pollPrediction = async (predictionId: string) => {
    const controller = new AbortController();
    pollController.current = controller;
    setActive(true);
    setPollError("");
    setGenerationError("");
    setElapsedSeconds(0);
    const startedAt = Date.now();
    setMiniMaxState("Submitted", "", "running");
    try {
      while (Date.now() - startedAt < 15 * 60 * 1000 && !controller.signal.aborted) {
        const elapsed = Date.now() - startedAt;
        const delay = elapsed < 90_000 ? 3000 : 8000;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            window.clearTimeout(timer);
            controller.signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Polling stopped.", "AbortError"));
          };
          const timer = window.setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve();
          }, delay);
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        if (controller.signal.aborted) break;
        const prediction = await getMiniMaxPrediction(predictionId, controller.signal);
        const status = prediction.status.toLowerCase();
        setMiniMaxParams({ last_status: status });
        if (status === "completed" || status === "succeeded") {
          const outputUrl = videoUrl(prediction.outputs);
          if (!outputUrl) throw new Error("Atlas completed the generation without returning a video URL.");
          setMiniMaxParams({ last_status: status, last_output_url: outputUrl });
          if (getNode(nodeId)) updateNodeData(nodeId, { outputs: { video: outputUrl } });
          setMiniMaxState("Completed", "Download it if you want to keep it (retention unverified on Atlas).", "done");
          return;
        }
        if (status === "failed") {
          const message = atlasError(prediction.error);
          setMiniMaxParams({ last_status: status });
          setGenerationError(message);
          setMiniMaxState("Failed", message, "error");
          return;
        }
        const elapsedSecondsNow = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds(elapsedSecondsNow);
        setMiniMaxState(`Processing (${elapsedSecondsNow}s elapsed)`, "", "running");
      }
      if (!controller.signal.aborted && mounted.current) {
        setMiniMaxState("Timed out waiting", "Still running on Atlas. Resume checking.", "idle");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Atlas status check failed.";
      setPollError(message);
      setMiniMaxState("Status check failed", message, "error");
    } finally {
      if (pollController.current === controller) pollController.current = null;
      setActive(false);
    }
  };

  const stopWaiting = () => {
    pollController.current?.abort();
    pollController.current = null;
    setActive(false);
    setMiniMaxState("Stopped waiting", "The job keeps running and is still billed on Atlas.");
  };

  const submitGeneration = async () => {
    setGenerationError("");
    setPollError("");
    const initialRequest = buildMiniMaxRequest({ params }, resolvedInputs);
    if (initialRequest.errors.length) {
      setGenerationError(initialRequest.errors[0]);
      return;
    }
    setActive(true);
    try {
      const uploadedInputs = await uploadInputs(resolvedInputs);
      if (!mounted.current || !getNode(nodeId)) return;
      const finalRequest = buildMiniMaxRequest({ params }, uploadedInputs);
      if (finalRequest.errors.length) throw new Error(finalRequest.errors[0]);
      setUploadStatus("");
      setMiniMaxState("Submitted", "", "running");
      const submitted = await submitMiniMaxPrediction(finalRequest.body);
      if (!mounted.current || !getNode(nodeId)) return;
      setMiniMaxParams({
        prediction_id: submitted.predictionId,
        last_status: submitted.status,
        last_output_url: "",
      });
      if (getNode(nodeId)) updateNodeData(nodeId, { outputs: {}, status: "running" });
      await pollPrediction(submitted.predictionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "MiniMax generation failed.";
      setGenerationError(message);
      setMiniMaxState("Failed", message, "error");
    } finally {
      setUploadStatus("");
      setActive(false);
    }
  };

  const handleGenerate = () => {
    setGenerationError("");
    setPollError("");
    if (request.errors.length) {
      setGenerationError(request.errors[0]);
      return;
    }
    if (needConfirmation) {
      setConfirmationOpen(true);
      return;
    }
    void submitGeneration();
  };

  const previewRequest = () => {
    setPreviewBody(JSON.stringify(request.body, null, 2));
    setPreviewOpen((open) => !open);
  };

  const currentResolutionOptions = minimaxResolutions(model, task);
  const resolutionUnverified = (model === MINIMAX_MODELS["MiniMax H3 Fast"] && task === MINIMAX_TASKS["Image to video"])
    || (model === MINIMAX_MODELS["MiniMax H3 Max"] && task !== MINIMAX_TASKS["Text to video"])
    || (model === MINIMAX_MODELS["MiniMax H3 Max Turbo"] && task === MINIMAX_TASKS["Image to video"]);
  // H3 Max reference-ratio availability is unverified on Atlas.
  const ratioOptions = task === MINIMAX_TASKS["Reference to video"] && model === MINIMAX_MODELS["MiniMax H3 Fast"]
    ? [...MINIMAX_RATIOS]
    : ["adaptive", ...MINIMAX_RATIOS];
  const referenceRatioUnverified = task === MINIMAX_TASKS["Reference to video"]
    && model !== MINIMAX_MODELS["MiniMax H3"] && model !== MINIMAX_MODELS["MiniMax H3 Fast"];
  const missingFirstFrame = task === MINIMAX_TASKS["Image to video"] && !incomingByHandle.has("image");
  const savedPredictionCanResume = Boolean(params.prediction_id && !params.last_output_url && !active && !pollError);

  return (
    <section className="ff-minimax-controls">
      <div className="ff-minimax-field">
        <label htmlFor={`${nodeId}-minimax-model`}>Variant</label>
        <select
          id={`${nodeId}-minimax-model`}
          className="nodrag"
          value={model}
          onChange={(event) => void changeModel(event.target.value)}
        >
          {Object.entries(MINIMAX_VARIANTS).map(([id, variant]) => (
            <option key={id} value={id}>{variant.label}</option>
          ))}
        </select>
        <small>
          From ${modelRate.toFixed(3)}/s
          {model === MINIMAX_MODELS["MiniMax H3 Fast"] && <> <span className="ff-minimax-unverified">rate unverified on Atlas</span></>}
        </small>
      </div>

      <div className="ff-minimax-field">
        <label htmlFor={`${nodeId}-minimax-task`}>Task</label>
        <select
          id={`${nodeId}-minimax-task`}
          className="nodrag"
          value={task}
          onChange={(event) => void changeTask(event.target.value)}
        >
          {Object.entries(MINIMAX_TASKS).map(([label, value]) => {
            const disabled = !minimaxTaskSupported(model, value);
            return (
              <option key={value} value={value} disabled={disabled}
                title={disabled ? "Not confirmed on Atlas" : undefined}>
                {label}{disabled ? " (not confirmed on Atlas)" : ""}
              </option>
            );
          })}
        </select>
        {model === MINIMAX_MODELS["MiniMax H3 Max Turbo"] && (
          <small>Reference to video is not confirmed on Atlas.</small>
        )}
      </div>

      <MiniMaxInputPort id="prompt" label="Prompt" type="text" />
      {(!incomingByHandle.has("prompt") || !promptText.trim()) && (
        <div className="ff-minimax-warning">
          {incomingByHandle.has("prompt") ? "The connected Prompt node is empty." : "Connect a Prompt node with prompt text."}
        </div>
      )}
      <div className="ff-minimax-note">Prompt: {promptText.length} characters.</div>
      {/* Native audio is not confirmed for every H3 variant on Atlas. */}
      <div className="ff-minimax-note">
        Native audio is generated with each clip <span className="ff-minimax-unverified">unverified on Atlas for all variants</span>.
      </div>

      {task === MINIMAX_TASKS["Image to video"] && (
        <>
          <MiniMaxInputPort id="image" label="First frame (required by docs table)" type="image" />
          <MiniMaxInputPort id="end_image" label="End frame (optional)" type="image" />
          {missingFirstFrame && <div className="ff-minimax-warning">Image to video requires a connected first frame.</div>}
          <div className="ff-minimax-note">Images: PNG, JPEG, JPG, or WebP. File-size and dimension limits are not documented by Atlas.</div>
        </>
      )}

      {task === MINIMAX_TASKS["Reference to video"] && (
        <>
          <MiniMaxInputPort id="references" label="Reference images" type="image" />
          {Array.from({ length: 5 }, (_, index) => (
            <MiniMaxInputPort
              key={`video-${index + 1}`}
              id={`reference_video_${index + 1}`}
              label={`Reference video ${index + 1} (optional)`}
              type="video"
            />
          ))}
          {Array.from({ length: 5 }, (_, index) => (
            <MiniMaxInputPort
              key={`audio-${index + 1}`}
              id={`reference_audio_${index + 1}`}
              label={`Reference audio ${index + 1} (optional)`}
              type="audio"
            />
          ))}
          <button type="button" className="ff-minimax-add nodrag" onClick={addReferenceImage}>
            Add reference image
          </button>
          <div className="ff-minimax-note">References: {referenceCount}</div>
          <div className="ff-minimax-note">Reference limits are not documented by Atlas <span className="ff-minimax-unverified">unverified</span>.</div>
          {!resolvedInputs.refers?.some((reference) => reference.type === "image" || reference.type === "video") && (
            <div className="ff-minimax-warning">At least one image or video reference is required; audio alone is not allowed.</div>
          )}
          <div className="ff-minimax-note">
            Images: PNG, JPEG, JPG, or WebP. Videos: MP4 or MOV. Audio: MP3 or WAV.
            File-size and dimension limits are not documented by Atlas.
          </div>
          <div className="ff-minimax-note">
            Describe how each reference should be used. <span className="ff-minimax-unverified">unverified on Atlas</span>
          </div>
        </>
      )}

      <div className="ff-minimax-field">
        <label htmlFor={`${nodeId}-minimax-duration`}>Duration</label>
        <select
          id={`${nodeId}-minimax-duration`}
          className="nodrag"
          value={String(params.duration)}
          onChange={(event) => setMiniMaxParams({ duration: Number(event.target.value) })}
        >
          {Array.from(
            { length: 16 - MINIMAX_VARIANTS[model as keyof typeof MINIMAX_VARIANTS].minDuration },
            (_, index) => MINIMAX_VARIANTS[model as keyof typeof MINIMAX_VARIANTS].minDuration + index,
          ).map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
        </select>
      </div>

      <div className="ff-minimax-field">
        <label htmlFor={`${nodeId}-minimax-resolution`}>Resolution</label>
        <select
          id={`${nodeId}-minimax-resolution`}
          className="nodrag"
          value={params.resolution}
          onChange={(event) => setMiniMaxParams({ resolution: event.target.value })}
        >
          {currentResolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
        </select>
        {resolutionUnverified && <small><span className="ff-minimax-unverified">Resolution schema unverified on Atlas</span></small>}
      </div>

      {task !== MINIMAX_TASKS["Image to video"] && (
        <div className="ff-minimax-field">
          <label htmlFor={`${nodeId}-minimax-ratio`}>Aspect ratio</label>
          <select
            id={`${nodeId}-minimax-ratio`}
            className="nodrag"
            value={params.ratio}
            onChange={(event) => setMiniMaxParams({ ratio: event.target.value })}
          >
            {ratioOptions.map((ratio) => <option key={ratio} value={ratio}>{ratio === "adaptive" ? "Adaptive" : ratio}</option>)}
          </select>
          {referenceRatioUnverified && <small><span className="ff-minimax-unverified">Options unverified on Atlas</span></small>}
        </div>
      )}

      {model !== MINIMAX_MODELS["MiniMax H3 Max Turbo"] && (
        <label className="ff-minimax-toggle">
          <span>Prompt expansion</span>
          <input
            className="nodrag"
            type="checkbox"
            checked={params.prompt_expansion}
            onChange={(event) => setMiniMaxParams({ prompt_expansion: event.target.checked })}
          />
        </label>
      )}

      <div className="ff-minimax-cost">
        Estimated cost: {estimatedCost}
      </div>
      {params.prompt_expansion && <div className="ff-minimax-note">Prompt expansion adds a per-token fee.</div>}
      {videoReferenceConnected && (
        <div className="ff-minimax-note">Input video seconds may be billed too <span className="ff-minimax-unverified">unverified on Atlas</span>.</div>
      )}

      {request.warnings.map((warning) => (
        <div className="ff-minimax-note" key={warning}>{warning} <span className="ff-minimax-unverified">unverified on Atlas</span></div>
      ))}
      {request.errors.map((error) => <div className="ff-minimax-warning" key={error}>{error}</div>)}
      {syncError && <div className="ff-minimax-warning">{syncError}</div>}
      {generationError && <div className="ff-minimax-warning">{generationError}</div>}

      <div className="ff-minimax-status" role="status" aria-live="polite">
        <strong>{uploadStatus || (statusLine === "Idle" && params.last_output_url ? "Completed" : statusLine)}</strong>
        {statusDetail && <span>{statusDetail}</span>}
        {elapsedSeconds > 0 && active && <span>{elapsedSeconds}s elapsed</span>}
      </div>

      {params.last_output_url && (
        <div className="ff-minimax-output">
          <video controls preload="metadata" src={playable.src} />
          <a className="ff-minimax-action" href={params.last_output_url} download target="_blank" rel="noreferrer">Download</a>
          <small>Download it if you want to keep it <span className="ff-minimax-unverified">retention unverified on Atlas</span>.</small>
        </div>
      )}

      {active ? (
        <button type="button" className="ff-minimax-action nodrag" onClick={stopWaiting}>Stop waiting</button>
      ) : (
        <div className="ff-minimax-actions">
          <button
            type="button"
            className="ff-minimax-action nodrag"
            disabled={request.errors.length > 0}
            onClick={handleGenerate}
          >
            Generate
          </button>
          <button type="button" className="ff-minimax-action ff-minimax-secondary nodrag" onClick={previewRequest}>
            Preview request
          </button>
        </div>
      )}

      {savedPredictionCanResume && (
        <button type="button" className="ff-minimax-action nodrag" onClick={() => void pollPrediction(params.prediction_id)}>
          Resume checking
        </button>
      )}
      {pollError && params.prediction_id && (
        <div className="ff-minimax-poll-error">
          {pollError && <span>{pollError}</span>}
          <button type="button" className="ff-minimax-action nodrag" onClick={() => void pollPrediction(params.prediction_id)}>
            Retry polling
          </button>
        </div>
      )}

      {confirmationOpen && (
        <div className="ff-minimax-confirm">
          <span>This will spend about ${estimatedMinimum.toFixed(2)} or more. Continue?</span>
          <div>
            <button type="button" onClick={() => setConfirmationOpen(false)}>Back</button>
            <button type="button" onClick={() => {
              setConfirmationOpen(false);
              void submitGeneration();
            }}>Continue</button>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className="ff-minimax-preview">
          <strong>Request preview</strong>
          <pre>{previewBody}</pre>
          <button type="button" onClick={() => setPreviewOpen(false)}>Close preview</button>
        </div>
      )}
    </section>
  );
}
