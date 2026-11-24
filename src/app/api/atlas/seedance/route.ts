import { NextResponse } from "next/server";
import { findAtlasUploadUrl } from "@/lib/atlas-upload";
import { wanDataUrlToFile } from "@/lib/wan-api";

const ATLAS_API = "https://api.atlascloud.ai/api/v1/model";
const MODELS = new Set([
  "bytedance/seedance-2.5/text-to-video",
  "bytedance/seedance-2.5/image-to-video",
]);
const MAX_IMAGE_LENGTH = 42 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff",
  "image/gif", "image/heic", "image/heif",
]);
const resolutions = new Set([
  "480p", "720p", "720p-sr", "720p-esr", "1080p", "1080p-sr", "1080p-esr",
  "1080p-esr-60fps", "1440p-sr", "1440p-esr", "4k-esr",
]);

function atlasError(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message) return record.message;
  if (typeof record.error === "string" && record.error) return record.error;
  return fallback;
}

async function readAtlasResponse(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new Error("Atlas Cloud returned an invalid response.");
  }
}

class AtlasImageError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function resolveAtlasImage(value: unknown, name: string, apiKey: string, signal: AbortSignal) {
  if (typeof value !== "string" || !value) {
    throw new AtlasImageError(`A valid ${name} image URL or data URI is required.`, 400);
  }
  if (/^https?:\/\/\S+$/i.test(value)) return value;

  let file: File;
  try {
    file = wanDataUrlToFile(value, name, "image/png");
  } catch {
    throw new AtlasImageError(`${name} must be an image URL or valid image data URI.`, 400);
  }
  if (!IMAGE_TYPES.has(file.type.toLowerCase())) {
    throw new AtlasImageError(`${name} must be a supported image type.`, 400);
  }
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    throw new AtlasImageError(`${name} image must be 30 MB or smaller.`, 400);
  }

  const form = new FormData();
  form.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/uploadMedia`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch {
    throw new AtlasImageError(`Could not upload the ${name} image to Atlas Cloud.`, 502);
  }

  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    throw new AtlasImageError("Atlas Cloud returned an invalid image upload response.", 502);
  }
  if (!response.ok) {
    throw new AtlasImageError(atlasError(result, `Atlas Cloud image upload failed (${response.status}).`), response.status);
  }
  const url = findAtlasUploadUrl(result, 0, true);
  if (!url) {
    throw new AtlasImageError("Atlas Cloud did not return a URL for the uploaded image.", 502);
  }
  return url;
}

export async function POST(request: Request) {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ATLASCLOUD_API_KEY is not set in .env.local." }, { status: 500 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  if (typeof body.model !== "string" || !MODELS.has(body.model)) {
    return NextResponse.json({ error: "Only Seedance 2.5 Text-to-Video and Image-to-Video are available through this route." }, { status: 400 });
  }
  const isImageToVideo = body.model.endsWith("/image-to-video");
  if (isImageToVideo && (typeof body.image !== "string" || !body.image || body.image.length > MAX_IMAGE_LENGTH)) {
    return NextResponse.json({ error: "A valid first-frame image URL or data URI is required." }, { status: 400 });
  }
  if (isImageToVideo && body.last_image !== undefined
    && (typeof body.last_image !== "string" || body.last_image.length > MAX_IMAGE_LENGTH)) {
    return NextResponse.json({ error: "Last-frame image must be a valid URL or data URI." }, { status: 400 });
  }
  if (body.model.endsWith("/text-to-video") && (typeof body.prompt !== "string" || !body.prompt.trim())) {
    return NextResponse.json({ error: "Text-to-Video requires a prompt." }, { status: 400 });
  }
  if (body.prompt !== undefined && (typeof body.prompt !== "string" || body.prompt.length > 26000)) {
    return NextResponse.json({ error: "Prompt must not exceed 26,000 characters." }, { status: 400 });
  }
  if (typeof body.duration !== "number"
    || !(body.duration === -1 || (Number.isInteger(body.duration) && body.duration >= 4 && body.duration <= 30))) {
    return NextResponse.json({ error: "Duration must be Auto or a whole number from 4 to 30 seconds." }, { status: 400 });
  }
  if (typeof body.resolution !== "string" || !resolutions.has(body.resolution)) {
    return NextResponse.json({ error: "Choose a supported Seedance 2.5 resolution." }, { status: 400 });
  }
  const validRatios = isImageToVideo
    ? new Set(["adaptive"])
    : new Set(["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
  if (typeof body.ratio !== "string" || !validRatios.has(body.ratio)) {
    return NextResponse.json({
      error: isImageToVideo
        ? "Seedance 2.5 Image-to-Video uses the source image aspect ratio."
        : "Choose a supported aspect ratio for Seedance 2.5 Text-to-Video.",
    }, { status: 400 });
  }
  let firstFrameUrl: string | undefined;
  let lastFrameUrl: string | undefined;
  if (isImageToVideo) {
    try {
      firstFrameUrl = await resolveAtlasImage(body.image, "first-frame", apiKey, request.signal);
      if (body.last_image !== undefined) {
        lastFrameUrl = await resolveAtlasImage(body.last_image, "last-frame", apiKey, request.signal);
      }
    } catch (error) {
      const status = error instanceof AtlasImageError ? error.status : 502;
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Could not upload the storyboard frame to Atlas Cloud.",
      }, { status });
    }
  }
  const atlasBody: Record<string, unknown> = {
    model: body.model,
    prompt: body.prompt,
    duration: body.duration,
    resolution: body.resolution,
    ratio: body.ratio,
    output_format: body.output_format,
    generate_audio: body.generate_audio,
    watermark: body.watermark,
    return_last_frame: body.return_last_frame,
    draft: body.draft,
  };
  if (isImageToVideo) {
    atlasBody.image = firstFrameUrl;
    if (lastFrameUrl !== undefined) atlasBody.last_image = lastFrameUrl;
  }

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/generateVideo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(atlasBody),
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Atlas Cloud." }, { status: 502 });
  }

  let result: Record<string, unknown>;
  try {
    result = await readAtlasResponse(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas Cloud returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({ error: atlasError(result, `Atlas Cloud request failed (${response.status}).`) }, { status: response.status });
  }
  const data = result.data as Record<string, unknown> | undefined;
  if (typeof data?.id !== "string" || !data.id) {
    return NextResponse.json({ error: "Atlas Cloud did not return a prediction ID." }, { status: 502 });
  }
  return NextResponse.json({ predictionId: data.id });
}

export async function GET(request: Request) {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ATLASCLOUD_API_KEY is not set in .env.local." }, { status: 500 });
  }

  const predictionId = new URL(request.url).searchParams.get("prediction_id") ?? "";
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(predictionId)) {
    return NextResponse.json({ error: "A valid Atlas Cloud prediction ID is required." }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/prediction/${encodeURIComponent(predictionId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not check the Atlas Cloud prediction." }, { status: 502 });
  }

  let result: Record<string, unknown>;
  try {
    result = await readAtlasResponse(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas Cloud returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({ error: atlasError(result, `Atlas Cloud status check failed (${response.status}).`) }, { status: response.status });
  }
  return NextResponse.json({ data: result.data });
}
