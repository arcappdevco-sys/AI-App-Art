import type { Edge, Node } from "@xyflow/react";
import type { NodeDef } from "./types";

export const VFX_EXTRACT_FRAME_NODE_TYPE = "vfx/extract-frame";
export const VFX_LIGHTING_REFERENCE_NODE_TYPE = "vfx/lighting-reference";
export const VFX_VIDEO_REFINE_NODE_TYPE = "video/vfx-relight";
export const VFX_FRAME_MAX_EDGE = 2048;
export const VFX_FRAME_MAX_BYTES = 512 * 1024 * 1024;
export const VFX_REFERENCE_PROVIDERS = ["Atlas Cloud", "fal.ai", "Google Gemini"] as const;
export type VfxReferenceProvider = (typeof VFX_REFERENCE_PROVIDERS)[number];

export function normalizeVfxFrameTime(value: unknown) {
  const seconds = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
    throw new Error("Frame time must be between 0 and 3600 seconds.");
  }
  return Math.round(seconds * 1000) / 1000;
}

function abortError(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new Error("Frame extraction was cancelled.");
}

function waitForVideoEvent(video: HTMLVideoElement, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadeddata", loaded);
      video.removeEventListener("error", failed);
      video.removeEventListener("abort", aborted);
      signal?.removeEventListener("abort", aborted);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Could not decode the source video.")); };
    const aborted = () => { cleanup(); reject(new Error("Frame extraction was cancelled.")); };
    video.addEventListener("loadeddata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.addEventListener("abort", aborted, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function waitForSeek(video: HTMLVideoElement, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", seeked);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const seeked = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("Could not seek to the requested video frame.")); };
    const aborted = () => { cleanup(); reject(new Error("Frame extraction was cancelled.")); };
    video.addEventListener("seeked", seeked, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function blobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Could not encode the extracted frame."));
    reader.onerror = () => reject(new Error("Could not encode the extracted frame."));
    reader.readAsDataURL(blob);
  });
}

async function loadVfxVideoBlob(source: string, signal?: AbortSignal) {
  let response: Response;
  if (source.startsWith("data:")) {
    response = await fetch(source, { signal });
  } else {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("Connect a video URL or upload a video before extracting a frame.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("The source video must be an HTTP(S) URL or an uploaded video.");
    }
    response = await fetch("/api/media/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.href }),
      signal,
    });
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(typeof result.error === "string"
      ? result.error
      : `Could not load the source video (${response.status}).`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > VFX_FRAME_MAX_BYTES) {
    throw new Error("Videos must be 512 MB or smaller to extract a frame.");
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("The source video is empty.");
  if (blob.size > VFX_FRAME_MAX_BYTES) throw new Error("Videos must be 512 MB or smaller to extract a frame.");
  return blob;
}

export async function extractVfxFrame(videoSource: unknown, requestedTime: unknown, signal?: AbortSignal) {
  if (typeof videoSource !== "string" || !videoSource.trim()) {
    throw new Error("Connect a video before extracting a frame.");
  }
  const time = normalizeVfxFrameTime(requestedTime);
  abortError(signal);
  const blob = await loadVfxVideoBlob(videoSource.trim(), signal);
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;
  try {
    const metadata = waitForVideoEvent(video, signal);
    video.load();
    await metadata;
    abortError(signal);
    if (!Number.isFinite(video.duration) || video.videoWidth < 1 || video.videoHeight < 1) {
      throw new Error("The source does not contain a readable video stream.");
    }
    if (time >= video.duration) {
      throw new Error(`Frame time must be before the source duration of ${video.duration.toFixed(3)} s.`);
    }
    if (time > 0) {
      const seeked = waitForSeek(video, signal);
      video.currentTime = time;
      await seeked;
    }
    abortError(signal);
    const scale = Math.min(1, VFX_FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create an image canvas for the extracted frame.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!frame) throw new Error("Could not encode the extracted frame.");
    return await blobAsDataUrl(frame);
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

function createVfxWorkflowNode(definition: NodeDef, position: { x: number; y: number }): Node {
  return {
    id: `${definition.type}-${crypto.randomUUID()}`,
    type: "workflow",
    position,
    data: {
      type: definition.type,
      params: Object.fromEntries(definition.params.map((param) => [param.key, param.default ?? ""])),
      status: "idle",
      outputs: {},
      log: "",
    },
  };
}

function vfxEdge(source: Node, sourceHandle: string, target: Node, targetHandle: string): Edge {
  return {
    id: `${source.id}-${target.id}-${targetHandle}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
  };
}

export function createVfxRelightWorkflow(
  definitions: Record<string, NodeDef>,
  position: { x: number; y: number },
) {
  const videoDefinition = definitions["input/video"];
  const frameDefinition = definitions[VFX_EXTRACT_FRAME_NODE_TYPE];
  const lightingDefinition = definitions[VFX_LIGHTING_REFERENCE_NODE_TYPE];
  const refineDefinition = definitions[VFX_VIDEO_REFINE_NODE_TYPE];
  const promptDefinition = definitions["input/prompt"];
  const previewDefinition = definitions["output/preview"];
  if (!videoDefinition || !frameDefinition || !lightingDefinition || !refineDefinition || !promptDefinition || !previewDefinition) {
    throw new Error("The VFX relighting workflow is missing a required node definition.");
  }

  const video = createVfxWorkflowNode(videoDefinition, position);
  const extract = createVfxWorkflowNode(frameDefinition, { x: position.x + 280, y: position.y });
  const lighting = createVfxWorkflowNode(lightingDefinition, { x: position.x + 560, y: position.y + 180 });
  const prompt = createVfxWorkflowNode(promptDefinition, { x: position.x + 560, y: position.y - 180 });
  const refine = createVfxWorkflowNode(refineDefinition, { x: position.x + 860, y: position.y });
  const preview = createVfxWorkflowNode(previewDefinition, { x: position.x + 1180, y: position.y });
  const nodes = [video, extract, lighting, prompt, refine, preview];
  const edges = [
    vfxEdge(video, "video", extract, "video"),
    vfxEdge(video, "video", refine, "video"),
    vfxEdge(extract, "image", lighting, "image"),
    vfxEdge(prompt, "text", lighting, "prompt"),
    vfxEdge(prompt, "text", refine, "prompt"),
    vfxEdge(lighting, "image", refine, "reference_image"),
    vfxEdge(refine, "video", preview, "media"),
  ];
  return { nodes, edges };
}
