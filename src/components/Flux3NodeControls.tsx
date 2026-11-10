"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, useEdges, useNodes, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { PORT_COLORS } from "@/lib/registry";
import {
  buildFlux3Request,
  FLUX3_CONFIRM_ABOVE_USD,
  FLUX3_FORMATS,
  FLUX3_MAX_REFERENCES,
  FLUX3_RATES,
  FLUX3_RATIOS,
  FLUX3_RESOLUTIONS,
  FLUX3_SAFETY_MAX,
  FLUX3_SAFETY_MIN,
  FLUX3_TASKS,
  normalizeFlux3Params,
  type Flux3ResolvedInputs,
  type Flux3Task,
} from "@/lib/flux3";
import {
  checkFlux3Key,
  getFlux3Prediction,
  submitFlux3Prediction,
  uploadFlux3Media,
} from "@/lib/flux3-api";
import { wanDataUrlToFile } from "@/lib/wan-api";

type Props = {
  nodeId: string;
  nodeData: Record<string, unknown>;
  workflowRunning: boolean;
};

type FlowNode = ReturnType<typeof useNodes>[number];

const REFERENCE_HANDLE = "reference_images";

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

function flux3LocalFile(value: unknown, fallbackName: string): File | null {
  let file: File | null = null;
  if (value instanceof File) file = value;
  else if (typeof value === "string" && value.startsWith("data:")) {
    file = wanDataUrlToFile(value, fallbackName, "");
  } else if (isRecord(value)) {
    if (value.file instanceof File) file = value.file;
    else if (typeof value.url === "string") return flux3LocalFile(value.url, stringValue(value.name) || fallbackName);
    else if (typeof value.dataUrl === "string") {
      file = wanDataUrlToFile(value.dataUrl, stringValue(value.name) || fallbackName, stringValue(value.type));
    } else if (typeof value.value === "string") {
      return flux3LocalFile(value.value, stringValue(value.name) || fallbackName);
    }
  }
  if (!file) return null;
  if (/\.[a-z0-9]{2,5}$/i.test(file.name)) return file;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  return new File([file], `${file.name}.${extension}`, { type: file.type });
}

function isLocalFlux3Media(value: unknown) {
  return typeof value === "string"
    ? value.startsWith("data:")
    : value instanceof File
      || (isRecord(value) && (value.local === true || typeof value.id === "string"
      || typeof value.dataUrl === "string" || value.file instanceof File
      || (typeof value.url === "string" && value.url.startsWith("data:"))));
}

function imageUrls(value: unknown): string[] {
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(imageUrls);
  if (isRecord(value)) {
    for (const key of ["url", "image", "images", "outputs", "output", "data"]) {
      const urls = imageUrls(value[key]);
      if (urls.length) return urls;
    }
  }
  return [];
}

function atlasError(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (isRecord(value) && typeof value.message === "string" && value.message) return value.message;
  return "Atlas reported that FLUX 3 generation failed.";
}

function Flux3InputPort({ id, label, type }: { id: string; label: string; type: "text" | "image" }) {
  return (
    <div className="ff-port ff-in ff-flux3-port">
      <Handle type="target" position={Position.Left} id={id} style={{ background: PORT_COLORS[type] }} />
      {label}
    </div>
  );
}

export default function Flux3NodeControls({ nodeId, nodeData, workflowRunning }: Props) {
  const nodes = useNodes();
  const edges = useEdges();
  const { addEdges, addNodes, deleteElements, getEdges, getNode, getNodes, updateNodeData } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBody, setPreviewBody] = useState("");
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [polling, setPolling] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [pollError, setPollError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [statusLine, setStatusLine] = useState("Idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [keyMessage, setKeyMessage] = useState("");
  const [checkingKey, setCheckingKey] = useState(false);
  const mounted = useRef(true);
  const seeded = useRef(false);
  const pollController = useRef<AbortController | null>(null);

  const params = useMemo(() => normalizeFlux3Params(record(nodeData.params)), [nodeData.params]);
  const task: Flux3Task = params.task;
  const edit = task === FLUX3_TASKS["Edit image"];
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const connectedEdges = useMemo(() => edges.filter((edge) => edge.target === nodeId), [edges, nodeId]);
  const promptEdge = connectedEdges.find((edge) => edge.targetHandle === "prompt");
  const referenceEdges = useMemo(
    () => connectedEdges.filter((edge) => edge.targetHandle === REFERENCE_HANDLE),
    [connectedEdges],
  );

  const setFlux3Params = (patch: Record<string, unknown>) => {
    if (!getNode(nodeId)) return;
    updateNodeData(nodeId, (current: { data: Record<string, unknown> }) => ({
      params: { ...normalizeFlux3Params(record(current.data.params)), ...patch },
    }));
  };

  const lastStatusRef = useRef("");

  const setFlux3State = (
    line: string,
    detail = "",
    status: "idle" | "running" | "done" | "error" = "idle",
  ) => {
    const node = getNode(nodeId);
    if (!mounted.current || !node) return;
    setStatusLine(line);
    setStatusDetail(detail);
    if (node.data.status !== status) {
      updateNodeData(nodeId, { status });
    }
  };

  const resolvedInputs = useMemo<Flux3ResolvedInputs>(() => ({
    prompt: promptEdge ? sourceValue(nodesById.get(promptEdge.source), promptEdge.sourceHandle ?? "text") : "",
    references: edit
      ? referenceEdges.map((edge) => sourceValue(nodesById.get(edge.source), edge.sourceHandle ?? "image"))
      : [],
  }), [edit, nodesById, promptEdge, referenceEdges]);

  const request = useMemo(() => buildFlux3Request({ params }, resolvedInputs), [params, resolvedInputs]);
  const promptText = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  const rate = FLUX3_RATES[task];
  const needConfirmation = rate > FLUX3_CONFIRM_ABOVE_USD;
  const urls = params.last_output_urls;

  const validHandles = useCallback(
    (nextTask: string) => new Set(["prompt", ...(nextTask === FLUX3_TASKS["Edit image"] ? [REFERENCE_HANDLE] : [])]),
    [],
  );

  // Removes auto-created image nodes that are no longer needed and any edge into a handle that no longer exists.
  const removeObsolete = useCallback(async (nextTask: string) => {
    const keep = validHandles(nextTask);
    const obsoleteNodes = nextTask === FLUX3_TASKS["Edit image"]
      ? []
      : getNodes().filter((candidate) => record(candidate.data).autoCreatedFor === nodeId);
    const obsoleteIds = new Set(obsoleteNodes.map((candidate) => candidate.id));
    const staleEdges = getEdges().filter((edge) =>
      (edge.target === nodeId && !keep.has(edge.targetHandle ?? "")) || obsoleteIds.has(edge.source));
    if (obsoleteNodes.length || staleEdges.length) {
      await deleteElements({ nodes: obsoleteNodes.map((candidate) => ({ id: candidate.id })), edges: staleEdges });
    }
  }, [deleteElements, getEdges, getNodes, nodeId, validHandles]);

  const addReferenceImage = useCallback((position: number) => {
    const target = getNode(nodeId);
    const imageId = `input/image-${crypto.randomUUID()}`;
    const label = `Image ${position}`;
    addNodes([{
      id: imageId,
      type: "workflow",
      position: { x: (target?.position.x ?? 400) - 360, y: (target?.position.y ?? 200) + (position - 1) * 230 },
      data: {
        type: "input/image",
        params: { url: "" },
        status: "idle",
        outputs: {},
        log: "",
        title: label,
        paramLabels: { url: `${label} (upload or paste URL)` },
        autoCreatedFor: nodeId,
        autoCreatedRole: `reference_image_${position}`,
      },
    }]);
    window.requestAnimationFrame(() => {
      updateNodeInternals(nodeId);
      window.requestAnimationFrame(() => {
        if (record(record(getNode(nodeId)?.data).params).task !== FLUX3_TASKS["Edit image"]) return;
        addEdges([{
          id: `${imageId}-${nodeId}-${position}`,
          source: imageId,
          sourceHandle: "image",
          target: nodeId,
          targetHandle: REFERENCE_HANDLE,
        }]);
      });
    });
  }, [addEdges, addNodes, getNode, nodeId, updateNodeInternals]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => updateNodeInternals(nodeId));
    void (async () => {
      try {
        await removeObsolete(task);
        if (task !== FLUX3_TASKS["Edit image"]) {
          seeded.current = false;
          if (params.references_initialized) setFlux3Params({ references_initialized: false });
          return;
        }
        if (seeded.current || params.references_initialized) return;
        seeded.current = true;
        setFlux3Params({ references_initialized: true });
        const hasImages = getEdges().some((edge) => edge.target === nodeId && edge.targetHandle === REFERENCE_HANDLE);
        if (!hasImages) addReferenceImage(1);
      } catch (error) {
        setSyncError(error instanceof Error ? error.message : "FLUX 3 inputs could not be synchronized.");
      }
    })();
    return () => window.cancelAnimationFrame(frame);
    // setFlux3Params only reads stable React Flow callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, nodeId]);

  // Keep auto-created labels and roles matching the order that will be sent.
  useEffect(() => {
    if (!edit) return;
    referenceEdges.forEach((edge, index) => {
      const data = record(nodesById.get(edge.source)?.data);
      if (data.autoCreatedFor !== nodeId) return;
      const role = `reference_image_${index + 1}`;
      const title = `Image ${index + 1}`;
      if (data.autoCreatedRole !== role || data.title !== title) {
        updateNodeData(edge.source, {
          autoCreatedRole: role,
          title,
          paramLabels: { url: `${title} (upload or paste URL)` },
        });
      }
    });
  }, [edit, nodeId, nodesById, referenceEdges, updateNodeData]);

  useEffect(() => {
    const first = urls[0];
    if (first && record(nodeData.outputs).image !== first) {
      updateNodeData(nodeId, { outputs: { image: first }, status: "done" });
    }
  }, [nodeData.outputs, nodeId, updateNodeData, urls]);

  const changeTask = async (nextTask: string) => {
    if (!Object.values(FLUX3_TASKS).includes(nextTask as Flux3Task)) return;
    setConfirmationOpen(false);
    setGenerationError("");
    setSyncError("");
    try {
      await removeObsolete(nextTask);
      setFlux3Params({ task: nextTask, model: `black-forest-labs/flux-3/${nextTask}` });
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "FLUX 3 connections could not be updated.");
    }
  };

  const uploadReferences = async (references: unknown[]) => {
    const local = references.map((value, index) => ({ value, index })).filter((entry) => isLocalFlux3Media(entry.value));
    const uploaded = new Map<number, string>();
    for (let position = 0; position < local.length; position++) {
      const entry = local[position];
      setUploadStatus(`Uploading ${position + 1} of ${local.length}`);
      const file = flux3LocalFile(entry.value, `image-${entry.index + 1}`);
      if (!file) throw new Error(`Could not read local image ${entry.index + 1}.`);
      uploaded.set(entry.index, await uploadFlux3Media(file));
    }
    return references.map((value, index) => uploaded.get(index) ?? (mediaUrl(value) || value));
  };

  const pollPrediction = async (predictionId: string) => {
    const controller = new AbortController();
    pollController.current = controller;
    setActive(true);
    setPolling(true);
    setPollError("");
    setGenerationError("");
    const startedAt = Date.now();
    setFlux3State("Submitted", "", "running");
    try {
      while (Date.now() - startedAt < 15 * 60 * 1000 && !controller.signal.aborted) {
        const elapsed = Date.now() - startedAt;
        const delay = elapsed < 60_000 ? 2000 : elapsed < 180_000 ? 4000 : 6000;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            window.clearTimeout(timer);
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
        const prediction = await getFlux3Prediction(predictionId, controller.signal);
        const status = prediction.status.toLowerCase();
        if (lastStatusRef.current !== status) {
          lastStatusRef.current = status;
          setFlux3Params({ last_status: status });
        }
        if (status === "completed" || status === "succeeded") {
          const outputs = imageUrls(prediction.outputs);
          if (!outputs.length) throw new Error("Atlas completed the generation without returning an image URL.");
          setFlux3Params({ last_status: status, last_output_urls: outputs });
          if (getNode(nodeId)) updateNodeData(nodeId, { outputs: { image: outputs[0] } });
          setFlux3State("Completed", "Download it if you want to keep it.", "done");
          return;
        }
        if (status === "failed") {
          const message = atlasError(prediction.error);
          setGenerationError(message);
          setFlux3State("Failed", message, "error");
          return;
        }
        setFlux3State(`Processing (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed)`, "", "running");
      }
      if (!controller.signal.aborted && mounted.current) {
        setFlux3State("Timed out waiting", "Still running on Atlas. Resume checking.", "idle");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Atlas status check failed.";
      setPollError(message);
      setFlux3State("Status check failed", message, "error");
    } finally {
      if (pollController.current === controller) pollController.current = null;
      setPolling(false);
      setActive(false);
    }
  };

  const stopWaiting = () => {
    pollController.current?.abort();
    pollController.current = null;
    setPolling(false);
    setActive(false);
    setFlux3State("Stopped waiting", "The job keeps running and is still billed on Atlas.");
  };

  const submitGeneration = async () => {
    setGenerationError("");
    setPollError("");
    if (request.errors.length) {
      setGenerationError(request.errors[0]);
      return;
    }
    setActive(true);
    try {
      const references = edit ? await uploadReferences(resolvedInputs.references ?? []) : [];
      if (!mounted.current || !getNode(nodeId)) return;
      const finalRequest = buildFlux3Request({ params }, { ...resolvedInputs, references });
      if (finalRequest.errors.length) throw new Error(finalRequest.errors[0]);
      setUploadStatus("");
      setFlux3State("Submitted", "", "running");
      const submitted = await submitFlux3Prediction(finalRequest.body);
      if (!mounted.current || !getNode(nodeId)) return;
      setFlux3Params({ prediction_id: submitted.predictionId, last_status: submitted.status, last_output_urls: [] });
      if (getNode(nodeId)) updateNodeData(nodeId, { outputs: {}, status: "running" });
      await pollPrediction(submitted.predictionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "FLUX 3 generation failed.";
      setGenerationError(message);
      setFlux3State("Failed", message, "error");
    } finally {
      setUploadStatus("");
      if (!pollController.current) setActive(false);
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

  const runKeyCheck = async () => {
    setCheckingKey(true);
    setKeyMessage("");
    try {
      setKeyMessage(await checkFlux3Key());
    } catch {
      setKeyMessage("Could not check the Atlas key.");
    } finally {
      setCheckingKey(false);
    }
  };

  const savedPredictionCanResume = Boolean(
    params.prediction_id && urls.length === 0 && !active && !pollError && params.last_status !== "failed",
  );

  return (
    <section className="ff-flux3-controls">
      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3-task`}>Task</label>
        <select
          id={`${nodeId}-flux3-task`}
          className="nodrag"
          value={task}
          onChange={(event) => void changeTask(event.target.value)}
        >
          {Object.entries(FLUX3_TASKS).map(([label, value]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <small>Edit makes local changes or combines up to 10 reference images.</small>
      </div>

      <Flux3InputPort id="prompt" label="Prompt" type="text" />
      {request.errors.includes("A non-empty prompt is required.") && (
        <div className="ff-flux3-warning">
          {promptEdge ? "The connected Prompt node is empty." : "Connect a Prompt node with prompt text."}
        </div>
      )}
      <div className="ff-flux3-note">Prompt: {promptText.length} characters.</div>
      <div className="ff-flux3-note">
        {edit
          ? "Short, direct instructions work best. Refer to your images as image 1, image 2 and so on, in the order they are connected."
          : "Describe the subject first, then the action, setting, composition and style. Put exact text in quotes."}
      </div>
      <div className="ff-flux3-note">You can describe what to avoid in the prompt.</div>

      {edit && (
        <>
          <Flux3InputPort id={REFERENCE_HANDLE} label="Reference images (image 1 to 10, in connection order)" type="image" />
          <button
            type="button"
            className="ff-flux3-add nodrag"
            disabled={referenceEdges.length >= FLUX3_MAX_REFERENCES}
            onClick={() => addReferenceImage(referenceEdges.length + 1)}
          >
            Add image ({referenceEdges.length} of {FLUX3_MAX_REFERENCES})
          </button>
          {referenceEdges.length === 0 && (
            <div className="ff-flux3-warning">Edit image needs at least one reference image.</div>
          )}
          {referenceEdges.length > FLUX3_MAX_REFERENCES && (
            <div className="ff-flux3-warning">Edit image accepts at most {FLUX3_MAX_REFERENCES} images. Remove the extra connections.</div>
          )}
          {referenceEdges.length > 0 && (
            <ol className="ff-flux3-list">
              {referenceEdges.map((edge, index) => {
                const title = stringValue(record(nodesById.get(edge.source)?.data).title) || "Image";
                return <li key={edge.id}>Image {index + 1}: {title}</li>;
              })}
            </ol>
          )}
          <div className="ff-flux3-note">
            At least 256 px per side. Images over 4 MP are downscaled. The first image controls the Auto aspect ratio.
          </div>
        </>
      )}

      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3-ratio`}>Aspect ratio</label>
        <select
          id={`${nodeId}-flux3-ratio`}
          className="nodrag"
          value={params.aspect_ratio}
          onChange={(event) => setFlux3Params({ aspect_ratio: event.target.value })}
        >
          {FLUX3_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio === "auto" ? "Auto" : ratio}</option>)}
        </select>
        <small>{edit ? "Auto matches image 1" : "Auto lets the model choose"}</small>
      </div>

      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3-resolution`}>Resolution</label>
        <select
          id={`${nodeId}-flux3-resolution`}
          className="nodrag"
          value={params.resolution}
          onChange={(event) => setFlux3Params({ resolution: event.target.value })}
        >
          {FLUX3_RESOLUTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
        </select>
        <small>Higher resolutions take longer; 4k can take several minutes. Price depends on the resolution.</small>
      </div>

      <label className="ff-flux3-toggle">
        <span>Prompt expansion</span>
        <input
          className="nodrag"
          type="checkbox"
          checked={params.enable_prompt_expansion}
          onChange={(event) => setFlux3Params({ enable_prompt_expansion: event.target.checked })}
        />
      </label>
      <div className="ff-flux3-note">
        {edit
          ? "Clarifies the prompt and makes each reference's role explicit"
          : "Rewrites a short prompt into a fuller description"}
      </div>

      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3-format`}>Output format</label>
        <select
          id={`${nodeId}-flux3-format`}
          className="nodrag"
          value={params.output_format}
          onChange={(event) => setFlux3Params({ output_format: event.target.value })}
        >
          {FLUX3_FORMATS.map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}
        </select>
      </div>

      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3-safety`}>
          Safety tolerance (0 strictest, 4 most permissive): {params.safety_tolerance}
        </label>
        <input
          id={`${nodeId}-flux3-safety`}
          className="nodrag"
          type="range"
          min={FLUX3_SAFETY_MIN}
          max={FLUX3_SAFETY_MAX}
          step={1}
          value={params.safety_tolerance}
          onChange={(event) => setFlux3Params({ safety_tolerance: Number(event.target.value) })}
        />
      </div>

      <div className="ff-flux3-cost">
        Estimated cost: from ~${rate.toFixed(2)} per image (higher resolutions cost more)
      </div>

      {request.warnings.map((warning) => (
        <div className="ff-flux3-note" key={warning}>{warning} <span className="ff-flux3-unverified">unverified on Atlas</span></div>
      ))}
      {request.errors
        .filter((error) => error !== "A non-empty prompt is required." && !(edit && error.startsWith("Edit image needs at least")))
        .map((error) => <div className="ff-flux3-warning" key={error}>{error}</div>)}
      {syncError && <div className="ff-flux3-warning">{syncError}</div>}
      {generationError && <div className="ff-flux3-warning">{generationError}</div>}

      <div className="ff-flux3-status" role="status" aria-live="polite">
        <strong>{active ? uploadStatus || statusLine : nodeData.status === "running" || nodeData.status === "queued" ? "Workflow running" : nodeData.status === "error" ? "Failed" : urls.length ? "Completed" : statusLine}</strong>
        {statusDetail && <span>{statusDetail}</span>}
      </div>

      {urls.length > 0 && (
        <div className="ff-flux3-output">
          {urls.slice(1).map((url, index) => (
            <div key={url}>
              <img src={url} alt={`FLUX 3 output ${index + 2}`} />
              <a className="ff-flux3-action" href={url} download target="_blank" rel="noreferrer">Download image {index + 2}</a>
            </div>
          ))}
          <small>
            Download it if you want to keep it <span className="ff-flux3-unverified">retention unverified on Atlas</span>.
          </small>
        </div>
      )}

      <div className="ff-flux3-actions">
        <button
          type="button"
          className="ff-flux3-action nodrag"
          disabled={active || workflowRunning || request.errors.length > 0}
          title={request.errors[0]}
          onClick={handleGenerate}
        >
          Generate
        </button>
        <button type="button" className="ff-flux3-action ff-flux3-secondary nodrag" onClick={previewRequest}>
          Preview request
        </button>
      </div>
      {polling && (
        <button type="button" className="ff-flux3-action nodrag" onClick={stopWaiting}>Stop waiting</button>
      )}

      {savedPredictionCanResume && (
        <button type="button" className="ff-flux3-action nodrag" disabled={workflowRunning} onClick={() => void pollPrediction(params.prediction_id)}>
          Resume checking
        </button>
      )}
      {pollError && params.prediction_id && (
        <div className="ff-flux3-poll-error">
          <span>{pollError}</span>
          <button type="button" className="ff-flux3-action nodrag" disabled={workflowRunning} onClick={() => void pollPrediction(params.prediction_id)}>
            Retry polling
          </button>
        </div>
      )}

      <button type="button" className="ff-flux3-action ff-flux3-secondary nodrag" disabled={checkingKey} onClick={() => void runKeyCheck()}>
        {checkingKey ? "Checking…" : "Check Atlas key"}
      </button>
      {keyMessage && <div className="ff-flux3-note" role="status">{keyMessage}</div>}

      {confirmationOpen && (
        <div className="ff-flux3-confirm">
          <span>This will spend about ${rate.toFixed(2)} or more. Continue?</span>
          <div>
            <button type="button" onClick={() => setConfirmationOpen(false)}>Back</button>
            <button type="button" disabled={workflowRunning} onClick={() => {
              setConfirmationOpen(false);
              void submitGeneration();
            }}>Continue</button>
          </div>
        </div>
      )}

      {previewOpen && (
        <div className="ff-flux3-preview">
          <strong>Request preview</strong>
          <pre>{previewBody}</pre>
          <button type="button" onClick={() => setPreviewOpen(false)}>Close preview</button>
        </div>
      )}
    </section>
  );
}
