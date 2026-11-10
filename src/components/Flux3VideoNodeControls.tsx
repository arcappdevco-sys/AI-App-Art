"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, useEdges, useNodes, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { PORT_COLORS } from "@/lib/registry";
import {
  buildFlux3VideoRequest,
  FLUX3_VIDEO_CONFIRM_ABOVE_USD,
  FLUX3_VIDEO_DURATIONS,
  FLUX3_VIDEO_FPS,
  FLUX3_VIDEO_MAX_KEYFRAMES,
  FLUX3_VIDEO_RATES,
  FLUX3_VIDEO_RATIOS,
  FLUX3_VIDEO_RESOLUTIONS,
  FLUX3_VIDEO_SAFETY_MAX,
  FLUX3_VIDEO_SAFETY_MIN,
  FLUX3_VIDEO_TASKS,
  normalizeFlux3VideoParams,
  type Flux3Keyframe,
  type Flux3VideoResolvedInputs,
  type Flux3VideoTask,
} from "@/lib/flux3-video";
import {
  checkFlux3Key,
  getFlux3Prediction,
  submitFlux3VideoPrediction,
  uploadFlux3VideoMedia,
} from "@/lib/flux3-api";
import { wanDataUrlToFile } from "@/lib/wan-api";
import { usePlayableVideo } from "@/lib/use-playable-video";

type Props = {
  nodeId: string;
  nodeData: Record<string, unknown>;
  workflowRunning: boolean;
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
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value.trim()) ? value.trim() : "";
  if (!isRecord(value)) return "";
  if (typeof value.url === "string") return mediaUrl(value.url);
  if (typeof value.value === "string") return mediaUrl(value.value);
  return "";
}

function isLocalMedia(value: unknown) {
  return typeof value === "string"
    ? value.startsWith("data:")
    : value instanceof File
      || (isRecord(value) && (value.local === true || typeof value.id === "string"
      || typeof value.dataUrl === "string" || value.file instanceof File
      || (typeof value.url === "string" && value.url.startsWith("data:"))));
}

function localFile(value: unknown, fallbackName: string): File | null {
  let file: File | null = null;
  if (value instanceof File) file = value;
  else if (typeof value === "string" && value.startsWith("data:")) {
    file = wanDataUrlToFile(value, fallbackName, "");
  } else if (isRecord(value)) {
    if (value.file instanceof File) file = value.file;
    else if (typeof value.url === "string") return localFile(value.url, stringValue(value.name) || fallbackName);
    else if (typeof value.dataUrl === "string") {
      file = wanDataUrlToFile(value.dataUrl, stringValue(value.name) || fallbackName, stringValue(value.type));
    } else if (typeof value.value === "string") {
      return localFile(value.value, stringValue(value.name) || fallbackName);
    }
  }
  if (!file) return null;
  if (/\.[a-z0-9]{2,5}$/i.test(file.name)) return file;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  return new File([file], `${file.name}.${extension}`, { type: file.type });
}

function videoUrls(value: unknown): string[] {
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(videoUrls);
  if (isRecord(value)) {
    for (const key of ["url", "video", "videos", "outputs", "output", "data"]) {
      const urls = videoUrls(value[key]);
      if (urls.length) return urls;
    }
  }
  return [];
}

function atlasError(value: unknown) {
  if (typeof value === "string" && value) return value;
  if (isRecord(value) && typeof value.message === "string" && value.message) return value.message;
  return "Atlas reported that FLUX 3 video generation failed.";
}

function Port({ id, label, type }: { id: string; label: string; type: "text" | "image" | "video" }) {
  return (
    <div className="ff-port ff-in ff-flux3-port">
      <Handle type="target" position={Position.Left} id={id} style={{ background: PORT_COLORS[type] }} />
      {label}
    </div>
  );
}

const VIDEO_HANDLE: Partial<Record<Flux3VideoTask, string>> = {
  "extend-video": "extend_video",
  "edit-video": "edit_video",
};

const TASK_HELP: Record<Flux3VideoTask, string> = {
  "text-to-video": "Describe the subject first, then the motion, setting and camera. Audio is generated with the video.",
  "image-to-video": "The video starts exactly on your image. Describe the motion in the prompt.",
  "first-last-frame-to-video": "The clip begins on the start image and ends on the end image. Describe what happens between them.",
  "keyframes-to-video": "Pin up to 10 images to exact frames of the 24 fps clip. Frames must be unique and at most duration × 24.",
  "extend-video": "Continues the source clip from its final frames. Describe how the action continues.",
  "edit-video": "Describe the change in one sentence. Motion, timing and framing of the source clip are kept; length follows the source.",
};

function validHandles(task: string, keyframeCount: number) {
  const handles = new Set(["prompt"]);
  if (task === "image-to-video") handles.add("image");
  if (task === "first-last-frame-to-video") {
    handles.add("start_image");
    handles.add("end_image");
  }
  if (task === "keyframes-to-video") {
    for (let index = 1; index <= keyframeCount; index++) handles.add(`keyframe_${index}`);
  }
  const video = VIDEO_HANDLE[task as Flux3VideoTask];
  if (video) handles.add(video);
  return handles;
}

export default function Flux3VideoNodeControls({ nodeId, nodeData, workflowRunning }: Props) {
  const nodes = useNodes();
  const edges = useEdges();
  const { deleteElements, getEdges, getNode, updateNodeData } = useReactFlow();
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
  const pollController = useRef<AbortController | null>(null);

  const params = useMemo(() => normalizeFlux3VideoParams(record(nodeData.params)), [nodeData.params]);
  const task: Flux3VideoTask = params.task;
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const connectedEdges = useMemo(() => edges.filter((edge) => edge.target === nodeId), [edges, nodeId]);
  const edgeFor = useCallback(
    (handle: string) => connectedEdges.find((edge) => edge.targetHandle === handle),
    [connectedEdges],
  );
  const edgeValue = useCallback((handle: string, fallbackSource: string) => {
    const edge = edgeFor(handle);
    return edge ? sourceValue(nodesById.get(edge.source), edge.sourceHandle ?? fallbackSource) : undefined;
  }, [edgeFor, nodesById]);

  const setVideoParams = (patch: Record<string, unknown>) => {
    if (!getNode(nodeId)) return;
    updateNodeData(nodeId, (current: { data: Record<string, unknown> }) => ({
      params: { ...normalizeFlux3VideoParams(record(current.data.params)), ...patch },
    }));
  };

  const lastStatusRef = useRef("");

  const setVideoState = (
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

  const promptEdge = edgeFor("prompt");
  const promptValue = edgeValue("prompt", "text");
  const videoHandle = VIDEO_HANDLE[task];

  const resolvedInputs = useMemo<Flux3VideoResolvedInputs>(() => {
    const inline = (handle: string, value: string) => edgeFor(handle) ? edgeValue(handle, "image") : value;
    return {
      prompt: promptValue,
      image: inline("image", params.image_url),
      start_image: inline("start_image", params.start_image_url),
      end_image: inline("end_image", params.end_image_url),
      video: videoHandle ? (edgeFor(videoHandle) ? edgeValue(videoHandle, "video") : params.video_url) : undefined,
      keyframes: params.keyframes.map((frame, index) => ({
        value: inline(`keyframe_${index + 1}`, frame.image_url),
        frame_index: frame.frame_index,
      })),
    };
  }, [edgeFor, edgeValue, params, promptValue, videoHandle]);

  const request = useMemo(() => buildFlux3VideoRequest({ params }, resolvedInputs), [params, resolvedInputs]);
  const promptText = typeof promptValue === "string" ? promptValue : "";
  const rate = FLUX3_VIDEO_RATES[task];
  const editing = task === "edit-video";
  const estimate = editing ? null : rate * params.duration;
  const needConfirmation = (estimate ?? rate * 15) > FLUX3_VIDEO_CONFIRM_ABOVE_USD;
  const urls = params.last_output_urls;
  const playable = usePlayableVideo(urls[0]);
  const keyframeCount = task === "keyframes-to-video" ? params.keyframes.length : 0;

  const removeObsolete = useCallback(async (nextTask: string, count: number) => {
    const keep = validHandles(nextTask, count);
    const staleEdges = getEdges().filter((edge) => edge.target === nodeId && !keep.has(edge.targetHandle ?? ""));
    if (staleEdges.length) await deleteElements({ edges: staleEdges });
  }, [deleteElements, getEdges, nodeId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => updateNodeInternals(nodeId));
    void removeObsolete(task, keyframeCount).catch((error) => {
      setSyncError(error instanceof Error ? error.message : "FLUX 3 inputs could not be synchronized.");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [keyframeCount, nodeId, removeObsolete, task, updateNodeInternals]);

  useEffect(() => {
    const first = urls[0];
    if (first && record(nodeData.outputs).video !== first) {
      updateNodeData(nodeId, { outputs: { video: first }, status: "done" });
    }
  }, [nodeData.outputs, nodeId, updateNodeData, urls]);

  const changeTask = async (nextTask: string) => {
    if (!Object.values(FLUX3_VIDEO_TASKS).includes(nextTask as Flux3VideoTask)) return;
    setConfirmationOpen(false);
    setGenerationError("");
    setSyncError("");
    try {
      await removeObsolete(nextTask, nextTask === "keyframes-to-video" ? params.keyframes.length : 0);
      setVideoParams({ task: nextTask, model: `black-forest-labs/flux-3/${nextTask}` });
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "FLUX 3 connections could not be updated.");
    }
  };

  const setKeyframes = (next: Flux3Keyframe[]) => setVideoParams({ keyframes: next });
  const addKeyframe = () => {
    const last = params.keyframes.at(-1);
    const nextFrame = last ? Math.min(last.frame_index + FLUX3_VIDEO_FPS, params.duration * FLUX3_VIDEO_FPS) : 0;
    setKeyframes([...params.keyframes, { image_url: "", frame_index: nextFrame }]);
  };
  const removeLastKeyframe = () => setKeyframes(params.keyframes.slice(0, -1));
  const updateKeyframe = (index: number, patch: Partial<Flux3Keyframe>) =>
    setKeyframes(params.keyframes.map((frame, position) => position === index ? { ...frame, ...patch } : frame));

  const uploadInline = async (file: File | undefined, apply: (url: string) => void) => {
    if (!file) return;
    setGenerationError("");
    setUploadStatus(`Uploading ${file.name}`);
    try {
      apply(await uploadFlux3VideoMedia(file));
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploadStatus("");
    }
  };

  const uploadLocalInputs = async (inputs: Flux3VideoResolvedInputs): Promise<Flux3VideoResolvedInputs> => {
    let count = 0;
    const total = [inputs.image, inputs.start_image, inputs.end_image, inputs.video, ...(inputs.keyframes ?? []).map((frame) => frame.value)]
      .filter(isLocalMedia).length;
    const resolve = async (value: unknown, name: string) => {
      if (!isLocalMedia(value)) return mediaUrl(value) || value;
      count += 1;
      setUploadStatus(`Uploading ${count} of ${total}`);
      const file = localFile(value, name);
      if (!file) throw new Error(`Could not read local ${name}.`);
      return uploadFlux3VideoMedia(file);
    };
    return {
      ...inputs,
      image: await resolve(inputs.image, "image"),
      start_image: await resolve(inputs.start_image, "start-image"),
      end_image: await resolve(inputs.end_image, "end-image"),
      video: await resolve(inputs.video, "video"),
      keyframes: await Promise.all((inputs.keyframes ?? []).map(async (frame, index) => ({
        ...frame,
        value: await resolve(frame.value, `keyframe-${index + 1}`),
      }))),
    };
  };

  const pollPrediction = async (predictionId: string) => {
    const controller = new AbortController();
    pollController.current = controller;
    setActive(true);
    setPolling(true);
    setPollError("");
    setGenerationError("");
    const startedAt = Date.now();
    setVideoState("Submitted", "", "running");
    try {
      while (Date.now() - startedAt < 30 * 60 * 1000 && !controller.signal.aborted) {
        const elapsed = Date.now() - startedAt;
        const delay = elapsed < 60_000 ? 3000 : elapsed < 300_000 ? 5000 : 8000;
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
          setVideoParams({ last_status: status });
        }
        if (status === "completed" || status === "succeeded") {
          const outputs = videoUrls(prediction.outputs);
          if (!outputs.length) throw new Error("Atlas completed the generation without returning a video URL.");
          setVideoParams({ last_status: status, last_output_urls: outputs });
          if (getNode(nodeId)) updateNodeData(nodeId, { outputs: { video: outputs[0] } });
          setVideoState("Completed", "Download it if you want to keep it.", "done");
          return;
        }
        if (status === "failed") {
          const message = atlasError(prediction.error);
          setGenerationError(message);
          setVideoState("Failed", message, "error");
          return;
        }
        setVideoState(`Processing (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed)`, "", "running");
      }
      if (!controller.signal.aborted && mounted.current) {
        setVideoState("Timed out waiting", "Still running on Atlas. Resume checking.", "idle");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Atlas status check failed.";
      setPollError(message);
      setVideoState("Status check failed", message, "error");
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
    setVideoState("Stopped waiting", "The job keeps running and is still billed on Atlas. Use Resume checking.", "idle");
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
      const uploaded = await uploadLocalInputs(resolvedInputs);
      if (!mounted.current || !getNode(nodeId)) return;
      const finalRequest = buildFlux3VideoRequest({ params }, uploaded);
      if (finalRequest.errors.length) throw new Error(finalRequest.errors[0]);
      setUploadStatus("");
      setVideoState("Submitted", "", "running");
      const submitted = await submitFlux3VideoPrediction(finalRequest.body);
      if (!mounted.current || !getNode(nodeId)) return;
      setVideoParams({ prediction_id: submitted.predictionId, last_status: submitted.status, last_output_urls: [] });
      if (getNode(nodeId)) updateNodeData(nodeId, { outputs: {}, status: "running" });
      await pollPrediction(submitted.predictionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "FLUX 3 video generation failed.";
      setGenerationError(message);
      setVideoState("Failed", message, "error");
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

  const canResume = Boolean(
    params.prediction_id && urls.length === 0 && !active && !pollError && params.last_status !== "failed",
  );

  const slot = (handle: string, label: string, type: "image" | "video", value: string, onValue: (url: string) => void) => {
    const connected = Boolean(edgeFor(handle));
    return (
      <div className="ff-flux3-field" key={handle}>
        <Port id={handle} label={label} type={type} />
        {connected ? (
          <small>Using the connected node.</small>
        ) : (
          <>
            <input
              className="nodrag"
              type="url"
              placeholder={`${type === "video" ? "Video" : "Image"} URL`}
              value={value}
              onChange={(event) => onValue(event.target.value)}
            />
            <input
              className="nodrag"
              type="file"
              accept={type === "video" ? "video/mp4" : "image/png,image/jpeg,image/webp"}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                void uploadInline(file, onValue);
              }}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <section className="ff-flux3-controls">
      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3v-task`}>Task</label>
        <select
          id={`${nodeId}-flux3v-task`}
          className="nodrag"
          value={task}
          onChange={(event) => void changeTask(event.target.value)}
        >
          {Object.entries(FLUX3_VIDEO_TASKS).map(([label, value]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <small>{TASK_HELP[task]}</small>
      </div>

      <Port id="prompt" label={task === "text-to-video" || editing ? "Prompt" : "Prompt (optional)"} type="text" />
      {request.errors.includes("A non-empty prompt is required.") && (
        <div className="ff-flux3-warning">
          {promptEdge ? "The connected Prompt node is empty." : "Connect a Prompt node with prompt text."}
        </div>
      )}
      <div className="ff-flux3-note">Prompt: {promptText.length} characters.</div>

      {task === "image-to-video" && slot("image", "Start image", "image", params.image_url, (url) => setVideoParams({ image_url: url }))}
      {task === "first-last-frame-to-video" && (
        <>
          {slot("start_image", "Start image", "image", params.start_image_url, (url) => setVideoParams({ start_image_url: url }))}
          {slot("end_image", "End image", "image", params.end_image_url, (url) => setVideoParams({ end_image_url: url }))}
        </>
      )}
      {videoHandle && slot(videoHandle, "Source video", "video", params.video_url, (url) => setVideoParams({ video_url: url }))}
      {task === "keyframes-to-video" && (
        <>
          {params.keyframes.map((frame, index) => (
            <div className="ff-flux3-field" key={index}>
              {slot(`keyframe_${index + 1}`, `Keyframe ${index + 1}`, "image", frame.image_url,
                (url) => updateKeyframe(index, { image_url: url }))}
              <label htmlFor={`${nodeId}-flux3v-frame-${index}`}>
                Frame (0 to {params.duration * FLUX3_VIDEO_FPS})
              </label>
              <input
                id={`${nodeId}-flux3v-frame-${index}`}
                className="nodrag"
                type="number"
                min={0}
                max={params.duration * FLUX3_VIDEO_FPS}
                step={1}
                value={frame.frame_index}
                onChange={(event) => updateKeyframe(index, { frame_index: Math.trunc(Number(event.target.value)) })}
              />
            </div>
          ))}
          <div className="ff-flux3-actions">
            <button
              type="button"
              className="ff-flux3-add nodrag"
              disabled={params.keyframes.length >= FLUX3_VIDEO_MAX_KEYFRAMES}
              onClick={addKeyframe}
            >
              Add keyframe ({params.keyframes.length} of {FLUX3_VIDEO_MAX_KEYFRAMES})
            </button>
            <button
              type="button"
              className="ff-flux3-add nodrag"
              disabled={params.keyframes.length === 0}
              onClick={removeLastKeyframe}
            >
              Remove last
            </button>
          </div>
        </>
      )}

      {!editing && (
        <>
          <div className="ff-flux3-field">
            <label htmlFor={`${nodeId}-flux3v-ratio`}>Aspect ratio</label>
            <select
              id={`${nodeId}-flux3v-ratio`}
              className="nodrag"
              value={params.aspect_ratio}
              onChange={(event) => setVideoParams({ aspect_ratio: event.target.value })}
            >
              {FLUX3_VIDEO_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio === "auto" ? "Auto" : ratio}</option>)}
            </select>
          </div>
          <div className="ff-flux3-field">
            <label htmlFor={`${nodeId}-flux3v-resolution`}>Resolution</label>
            <select
              id={`${nodeId}-flux3v-resolution`}
              className="nodrag"
              value={params.resolution}
              onChange={(event) => setVideoParams({ resolution: event.target.value })}
            >
              {FLUX3_VIDEO_RESOLUTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
            </select>
          </div>
          <div className="ff-flux3-field">
            <label htmlFor={`${nodeId}-flux3v-duration`}>Duration</label>
            <select
              id={`${nodeId}-flux3v-duration`}
              className="nodrag"
              value={params.duration}
              onChange={(event) => setVideoParams({ duration: Number(event.target.value) })}
            >
              {FLUX3_VIDEO_DURATIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
            </select>
          </div>
          <label className="ff-flux3-toggle">
            <span>Generate audio</span>
            <input
              className="nodrag"
              type="checkbox"
              checked={params.generate_audio}
              onChange={(event) => setVideoParams({ generate_audio: event.target.checked })}
            />
          </label>
          <div className="ff-flux3-field">
            <label htmlFor={`${nodeId}-flux3v-seed`}>Seed (optional)</label>
            <input
              id={`${nodeId}-flux3v-seed`}
              className="nodrag"
              type="number"
              min={0}
              step={1}
              placeholder="Random"
              value={params.seed}
              onChange={(event) => setVideoParams({ seed: event.target.value })}
            />
          </div>
        </>
      )}

      <div className="ff-flux3-field">
        <label htmlFor={`${nodeId}-flux3v-safety`}>
          Safety tolerance (0 strictest, 4 most permissive): {params.safety_tolerance}
        </label>
        <input
          id={`${nodeId}-flux3v-safety`}
          className="nodrag"
          type="range"
          min={FLUX3_VIDEO_SAFETY_MIN}
          max={FLUX3_VIDEO_SAFETY_MAX}
          step={1}
          value={params.safety_tolerance}
          onChange={(event) => setVideoParams({ safety_tolerance: Number(event.target.value) })}
        />
      </div>

      <div className="ff-flux3-cost">
        {estimate !== null
          ? `Estimated cost: ~$${estimate.toFixed(2)} (${params.duration} s at $${rate.toFixed(2)}/s)`
          : `Estimated cost: $${rate.toFixed(2)} per second of the source video`}
      </div>

      {request.warnings.map((warning) => (
        <div className="ff-flux3-note" key={warning}>{warning} <span className="ff-flux3-unverified">unverified on Atlas</span></div>
      ))}
      {request.errors.filter((message) => message !== "A non-empty prompt is required.").map((message) => (
        <div className="ff-flux3-warning" key={message}>{message}</div>
      ))}
      {syncError && <div className="ff-flux3-warning">{syncError}</div>}
      {generationError && <div className="ff-flux3-warning">{generationError}</div>}
      {uploadStatus && <div className="ff-flux3-note">{uploadStatus}</div>}

      {confirmationOpen && (
        <div className="ff-flux3-confirm">
          <div>This will spend about {estimate !== null ? `$${estimate.toFixed(2)}` : `$${rate.toFixed(2)} per source second`} on Atlas.</div>
          <div>
            <button type="button" className="nodrag" disabled={workflowRunning} onClick={() => { setConfirmationOpen(false); void submitGeneration(); }}>
              Confirm and generate
            </button>
            <button type="button" className="nodrag" onClick={() => setConfirmationOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="ff-flux3-actions">
        <button type="button" className="ff-flux3-action nodrag" disabled={active || workflowRunning} onClick={handleGenerate}>
          Generate
        </button>
        <button
          type="button"
          className="ff-flux3-action ff-flux3-secondary nodrag"
          onClick={() => {
            setPreviewBody(JSON.stringify(request.body, null, 2));
            setPreviewOpen((open) => !open);
          }}
        >
          Preview request
        </button>
        {polling && (
          <button type="button" className="ff-flux3-action ff-flux3-secondary nodrag" onClick={stopWaiting}>
            Stop waiting
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="ff-flux3-action ff-flux3-secondary nodrag"
            disabled={workflowRunning}
            onClick={() => void pollPrediction(params.prediction_id)}
          >
            Resume checking
          </button>
        )}
        {pollError && (
          <button
            type="button"
            className="ff-flux3-action ff-flux3-secondary nodrag"
            disabled={workflowRunning}
            onClick={() => void pollPrediction(params.prediction_id)}
          >
            Retry polling
          </button>
        )}
        <button
          type="button"
          className="ff-flux3-action ff-flux3-secondary nodrag"
          disabled={checkingKey}
          onClick={() => void runKeyCheck()}
        >
          {checkingKey ? "Checking…" : "Check Atlas key"}
        </button>
      </div>
      {keyMessage && <div className="ff-flux3-note">{keyMessage}</div>}

      {previewOpen && (
        <div className="ff-flux3-preview">
          <div>POST /{request.submitPath} — {request.endpoint}</div>
          <pre>{previewBody}</pre>
        </div>
      )}

      {urls[0] && (
        <div className="ff-flux3-output">
          {playable.src ? (
            <video className="nodrag" controls preload="metadata" src={playable.src} style={{ width: "100%", borderRadius: 6 }} />
          ) : (
            <div className="ff-flux3-note">{playable.error ? `Could not load the preview (${playable.error}). Use Download.` : "Loading preview…"}</div>
          )}
          <a className="ff-flux3-action ff-flux3-secondary" href={urls[0]} download target="_blank" rel="noreferrer">Download</a>
        </div>
      )}

      <div className="ff-flux3-status">
        <strong>{active ? statusLine : nodeData.status === "running" || nodeData.status === "queued" ? "Workflow running" : nodeData.status === "error" ? "Failed" : urls.length ? "Completed" : statusLine}</strong>
        {statusDetail && <small> {statusDetail}</small>}
      </div>
    </section>
  );
}
