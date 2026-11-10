import { buildWanRequest, type WanReferenceInput, type WanResolvedInputs } from "./wan";
import { buildMiniMaxRequest, type MiniMaxReference, type MiniMaxResolvedInputs } from "./minimax";
import { buildFlux3Request, type Flux3ResolvedInputs } from "./flux3";
import { buildFlux3VideoRequest, normalizeFlux3VideoParams, type Flux3VideoResolvedInputs } from "./flux3-video";
import {
  getWanPrediction, submitWanPrediction, submitMiniMaxPrediction,
  uploadWanMedia, uploadMiniMaxMedia, wanDataUrlToFile, type WanUploadKind,
} from "./wan-api";
import {
  submitFlux3Prediction, submitFlux3VideoPrediction, uploadFlux3Media, uploadFlux3VideoMedia,
} from "./flux3-api";
import { loadWanDocument } from "./wan-storage";
import { inspectWanImage } from "./wan-image";
import type { ExecCtx } from "./types";

type Kind = "wan" | "minimax" | "flux-image" | "flux-video";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputUrls(value: unknown, kind: "image" | "video"): string[] {
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => outputUrls(item, kind));
  if (isRecord(value)) {
    for (const key of ["url", kind, `${kind}s`, "outputs", "output", "data"]) {
      const urls = outputUrls(value[key], kind);
      if (urls.length) return urls;
    }
  }
  return [];
}

async function mediaValue(
  value: unknown, name: string, mediaKind: WanUploadKind, kind: Kind, signal?: AbortSignal,
): Promise<unknown> {
  if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value)) return value;
  if (value === undefined || value === null || value === "") return value;
  let file: File | undefined;
  if (value instanceof File) file = value;
  else if (typeof value === "string" && value.startsWith("data:")) file = wanDataUrlToFile(value, name, "");
  else if (isRecord(value)) {
    if (value.file instanceof File) file = value.file;
    else if (typeof value.dataUrl === "string") file = wanDataUrlToFile(value.dataUrl, String(value.name || name), String(value.type || ""));
    else if (typeof value.url === "string") return mediaValue(value.url, name, mediaKind, kind, signal);
    else if (typeof value.value === "string") return mediaValue(value.value, name, mediaKind, kind, signal);
    else if (kind === "wan" && mediaKind === "document" && typeof value.id === "string") file = await loadWanDocument(value.id);
  }
  if (!file) throw new Error(`Could not read ${name} as a URL or local file.`);
  if (kind === "wan" && mediaKind === "image") {
    const metadata = await inspectWanImage(file);
    if (metadata.errors.length) throw new Error(`${name}: ${metadata.errors.join(" ")}`);
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(file.name)) {
    const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
    file = new File([file], `${file.name}.${extension}`, { type: file.type });
  }
  signal?.throwIfAborted();
  if (kind === "wan") return uploadWanMedia(file, mediaKind, signal);
  if (kind === "minimax") return uploadMiniMaxMedia(file, signal);
  if (kind === "flux-image") return uploadFlux3Media(file, signal);
  return uploadFlux3VideoMedia(file, signal);
}

function references(inputs: Record<string, unknown>, miniMax: boolean): WanReferenceInput[] {
  return Object.entries(inputs).flatMap(([handle, value]) => {
    const match = /^reference_(image|video|audio)_(\d+)$/.exec(handle);
    if (match) return [{ type: match[1] as WanReferenceInput["type"], value }];
    if (miniMax && handle === "references") {
      return (Array.isArray(value) ? value : [value]).map((item) => ({ type: "image" as const, value: item }));
    }
    return [];
  });
}

function checkRequest(request: { body: Record<string, unknown>; errors: string[] }) {
  if (request.errors.length) throw new Error(request.errors.join(" "));
  return request.body;
}

async function requestBody(kind: Kind, ctx: ExecCtx): Promise<Record<string, unknown>> {
  const { inputs, params, signal, log } = ctx;
  const upload = (value: unknown, name: string, mediaKind: WanUploadKind) =>
    mediaValue(value, name, mediaKind, kind, signal);
  if (kind === "wan" || kind === "minimax") {
    const refs = references(inputs, kind === "minimax");
    const base = {
      prompt: inputs.prompt, image: inputs.image, last_image: inputs.last_image,
      end_image: inputs.end_image, references: refs, refers: refs,
      file: params.task === "reference-to-video" ? params.file : undefined,
    };
    if (kind === "wan") checkRequest(buildWanRequest({ params }, base));
    else checkRequest(buildMiniMaxRequest({ params }, base));
    log("Uploading local inputs");
    const uploadedRefs = await Promise.all(refs.map(async (ref, index) => ({
      ...ref, value: await upload(ref.value, `reference-${index + 1}`, ref.type),
    })));
    if (kind === "wan") {
      const resolved: WanResolvedInputs = {
        ...base,
        image: await upload(base.image, "first-frame", "image"),
        last_image: await upload(base.last_image, "last-frame", "image"),
        file: await upload(base.file, "document", "document"),
        references: uploadedRefs,
      };
      return checkRequest(buildWanRequest({ params }, resolved));
    }
    const resolved: MiniMaxResolvedInputs = {
      prompt: inputs.prompt,
      image: await upload(base.image, "first-frame", "image"),
      end_image: await upload(base.end_image, "end-frame", "image"),
      refers: uploadedRefs as MiniMaxReference[],
    };
    return checkRequest(buildMiniMaxRequest({ params }, resolved));
  }
  if (kind === "flux-image") {
    const refs = params.task === "edit" && Array.isArray(inputs.reference_images) ? inputs.reference_images : [];
    const base: Flux3ResolvedInputs = { prompt: inputs.prompt, references: refs };
    checkRequest(buildFlux3Request({ params }, base));
    log("Uploading local inputs");
    const uploaded = await Promise.all(refs.map((ref, index) => upload(ref, `image-${index + 1}`, "image")));
    return checkRequest(buildFlux3Request({ params }, { ...base, references: uploaded }));
  }
  const normalized = normalizeFlux3VideoParams(params);
  const videoHandle = normalized.task === "extend-video" ? "extend_video" : "edit_video";
  const connectedOrInline = (handle: string, inline: string) => handle in inputs ? inputs[handle] : inline;
  const base: Flux3VideoResolvedInputs = {
    prompt: inputs.prompt,
    image: normalized.task === "image-to-video" ? connectedOrInline("image", normalized.image_url) : undefined,
    start_image: normalized.task === "first-last-frame-to-video" ? connectedOrInline("start_image", normalized.start_image_url) : undefined,
    end_image: normalized.task === "first-last-frame-to-video" ? connectedOrInline("end_image", normalized.end_image_url) : undefined,
    video: ["extend-video", "edit-video"].includes(normalized.task) ? connectedOrInline(videoHandle, normalized.video_url) : undefined,
    keyframes: normalized.task !== "keyframes-to-video" ? [] : normalized.keyframes.map((frame, index) => ({
      value: connectedOrInline(`keyframe_${index + 1}`, frame.image_url), frame_index: frame.frame_index,
    })),
  };
  checkRequest(buildFlux3VideoRequest({ params }, base));
  log("Uploading local inputs");
  const resolved: Flux3VideoResolvedInputs = {
    ...base,
    image: await upload(base.image, "image", "image"),
    start_image: await upload(base.start_image, "start-image", "image"),
    end_image: await upload(base.end_image, "end-image", "image"),
    video: await upload(base.video, "video", "video"),
    keyframes: await Promise.all((base.keyframes ?? []).map(async (frame, index) => ({
      ...frame, value: await upload(frame.value, `keyframe-${index + 1}`, "image"),
    }))),
  };
  return checkRequest(buildFlux3VideoRequest({ params }, resolved));
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function executeWorkflowAtlas(kind: Kind, ctx: ExecCtx) {
  const body = await requestBody(kind, ctx);
  ctx.signal?.throwIfAborted();
  ctx.log("Submitting generation");
  const submit = kind === "wan" ? submitWanPrediction
    : kind === "minimax" ? submitMiniMaxPrediction
      : kind === "flux-image" ? submitFlux3Prediction : submitFlux3VideoPrediction;
  // Once submitted, retain the prediction ID even if the user stops waiting.
  const submitted = await submit(body);
  const image = kind === "flux-image";
  const arrayOutput = kind === "flux-image" || kind === "flux-video";
  const outputKey = arrayOutput ? "last_output_urls" : "last_output_url";
  ctx.updateParams?.({ prediction_id: submitted.predictionId, last_status: submitted.status, [outputKey]: arrayOutput ? [] : "" });
  const started = Date.now();
  const timeout = kind === "flux-video" ? 30 * 60_000 : 15 * 60_000;
  while (Date.now() - started < timeout) {
    try {
      await wait(3000, ctx.signal);
    } catch (error) {
      if (ctx.signal?.aborted) throw new Error("Stopped waiting. The Atlas job may still be billed; use Resume checking.");
      throw error;
    }
    let prediction;
    try {
      prediction = await getWanPrediction(submitted.predictionId, ctx.signal);
    } catch (error) {
      if (ctx.signal?.aborted) throw new Error("Stopped waiting. The Atlas job may still be billed; use Resume checking.");
      throw error;
    }
    const status = prediction.status.toLowerCase();
    ctx.log(`Atlas status: ${status || "processing"}`);
    if (["completed", "succeeded", "success"].includes(status)) {
      const urls = outputUrls(prediction.outputs, image ? "image" : "video");
      if (!urls.length) throw new Error(`Atlas completed without returning an ${image ? "image" : "video"} URL.`);
      ctx.updateParams?.({ last_status: status, [outputKey]: arrayOutput ? urls : urls[0] });
      return { [image ? "image" : "video"]: urls[0] };
    }
    if (["failed", "error", "cancelled"].includes(status)) {
      ctx.updateParams?.({ last_status: status });
      const error = prediction.error;
      throw new Error(typeof error === "string" ? error : isRecord(error) && typeof error.message === "string" ? error.message : "Atlas generation failed.");
    }
  }
  throw new Error("Atlas generation is still running. Use Resume checking on the node.");
}
