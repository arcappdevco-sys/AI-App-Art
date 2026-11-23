import { fal } from "@fal-ai/client";
import { compositorImageFit } from "./compositor";

export const SMART_MATTE_KIND = "smart-matte";
export const SMART_MATTE_MODEL = "lightricks/ltx-2.5/alpha-gen";
const MAX_SOURCE_BYTES = 200_000_000;
const hashes = new WeakMap<File, Promise<string>>();

export function smartMatteSourceHash(file: File): Promise<string> {
  let hash = hashes.get(file);
  if (!hash) {
    hash = file.arrayBuffer().then((bytes) => crypto.subtle.digest("SHA-256", bytes)).then(
      (digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
    hashes.set(file, hash);
  }
  return hash;
}

export function smartMatteCost(duration: number, width: number, height: number): number {
  if (![duration, width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("The video duration and dimensions must be available.");
  }
  const short = Math.min(width, height), long = Math.max(width, height);
  if (short > 2160 || long > 3840 || long / short > 32 / 9) {
    throw new Error("LTX Alpha Gen supports up to 3840 x 2160 and an aspect ratio of at most 32:9.");
  }
  return duration * (short <= 1080 ? 0.1 : short <= 1440 ? 0.25 : 1);
}

export function validateSmartMatteSource(file: File, duration: number, width: number, height: number): number {
  if (!file.type.startsWith("video/")) throw new Error("Connect a Media node containing a video.");
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error("LTX Alpha Gen requires a video no larger than 200 MB.");
  return smartMatteCost(duration, width, height);
}

export function applySmartMattePixels(source: Uint8ClampedArray, matte: Uint8ClampedArray): void {
  if (source.length !== matte.length || source.length % 4) throw new Error("The matte frame has an invalid size.");
  for (let index = 0; index < source.length; index += 4) {
    const luminance = 0.2126 * matte[index] + 0.7152 * matte[index + 1] + 0.0722 * matte[index + 2];
    source[index + 3] = Math.round(source[index + 3] * luminance / 255);
  }
}

export function applySmartMatte(source: HTMLCanvasElement, matte: HTMLVideoElement): HTMLCanvasElement {
  const result = document.createElement("canvas");
  result.width = source.width; result.height = source.height;
  const context = result.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas rendering is not available in this browser.");
  context.drawImage(source, 0, 0);
  const sourcePixels = context.getImageData(0, 0, result.width, result.height);
  context.clearRect(0, 0, result.width, result.height);
  const fit = compositorImageFit(matte.videoWidth, matte.videoHeight, result.width, result.height);
  context.drawImage(matte, fit.x, fit.y, fit.width, fit.height);
  const mattePixels = context.getImageData(0, 0, result.width, result.height);
  applySmartMattePixels(sourcePixels.data, mattePixels.data);
  context.putImageData(sourcePixels, 0, 0);
  return result;
}

export async function uploadSmartMatteSource(file: File): Promise<string> {
  fal.config({ proxyUrl: "/api/fal/proxy" });
  return fal.storage.upload(file);
}

export async function submitSmartMatte(url: string): Promise<string> {
  const response = await fetch("/api/fal/proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-fal-target-url": `https://queue.fal.run/${SMART_MATTE_MODEL}`,
    },
    body: JSON.stringify({ video_url: url }),
  });
  if (!response.ok) throw new Error(`fal.ai submission returned HTTP ${response.status}; its status may be uncertain.`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("request_id" in payload)
    || typeof payload.request_id !== "string" || !payload.request_id) {
    throw new Error("fal.ai did not return a request ID; submission status is uncertain.");
  }
  return payload.request_id;
}

export async function collectSmartMatte(requestId: string, log: (message: string) => void): Promise<File> {
  fal.config({ proxyUrl: "/api/fal/proxy" });
  await fal.queue.subscribeToStatus(SMART_MATTE_MODEL, {
    requestId,
    pollInterval: 3000,
    onQueueUpdate: (status) => log(`fal.ai: ${status.status.toLowerCase().replaceAll("_", " ")}`),
  });
  const result = await fal.queue.result(SMART_MATTE_MODEL, { requestId });
  const url = result.data?.matte_video?.url;
  if (typeof url !== "string" || !url) throw new Error("LTX Alpha Gen did not return a matte video.");
  const response = await fetch("/api/media/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(`Could not download the matte (HTTP ${response.status}). Resume the existing request.`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("The generated matte video is empty.");
  return new File([blob], "ltx-matte.mp4", { type: "video/mp4" });
}
