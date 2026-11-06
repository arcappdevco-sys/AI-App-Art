import { NextResponse } from "next/server";

const ATLAS_API = "https://api.atlascloud.ai/api/v1/model";
const MAX_IMAGE_LENGTH = 42 * 1024 * 1024;
const MAX_VIDEO_LENGTH = 420 * 1024 * 1024;

const MODEL_FIELDS: Record<string, string[]> = {
  "google/veo3.1/text-to-video": ["prompt", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1/image-to-video": ["prompt", "image", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1/reference-to-video": ["prompt", "images", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1-fast/text-to-video": ["prompt", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1-fast/image-to-video": ["prompt", "image", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1-lite/text-to-video": ["prompt", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1-lite/image-to-video": ["prompt", "image", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/veo3.1-lite/start-end-frame-to-video": ["prompt", "image", "last_image", "duration", "resolution", "aspect_ratio", "generate_audio", "seed"],
  "google/gemini-omni-flash/text-to-video": ["prompt", "duration", "resolution", "aspect_ratio", "thinking_level", "seed"],
  "google/gemini-omni-flash/image-to-video": ["prompt", "image", "last_image", "duration", "resolution", "aspect_ratio", "thinking_level", "seed"],
  "google/gemini-omni-flash/reference-to-video": ["prompt", "images", "duration", "resolution", "aspect_ratio", "thinking_level", "seed"],
  "google/gemini-omni-flash/video-edit": ["prompt", "video", "images", "duration", "resolution", "thinking_level", "seed"],
};

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
  const model = typeof body.model === "string" ? body.model : "";
  const fields = MODEL_FIELDS[model];
  if (!fields) {
    return NextResponse.json({ error: "Choose a Veo 3.1 or Gemini Omni Flash model and supported task." }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 20000) {
    return NextResponse.json({ error: "A prompt of 20,000 characters or fewer is required." }, { status: 400 });
  }
  if (model.endsWith("/image-to-video") || model.endsWith("/start-end-frame-to-video")) {
    if (typeof body.image !== "string" || !body.image || body.image.length > MAX_IMAGE_LENGTH) {
      return NextResponse.json({ error: "Image-to-video requires a valid first-frame image." }, { status: 400 });
    }
  }
  if (model.endsWith("/reference-to-video")
    && (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 3
      || body.images.some((image) => typeof image !== "string" || image.length > MAX_IMAGE_LENGTH))) {
    return NextResponse.json({ error: "Reference-to-video requires one to three valid reference images." }, { status: 400 });
  }
  if (model.endsWith("/start-end-frame-to-video")
    && (typeof body.last_image !== "string" || !body.last_image || body.last_image.length > MAX_IMAGE_LENGTH)) {
    return NextResponse.json({ error: "Start-end-frame-to-video requires a valid last-frame image." }, { status: 400 });
  }
  if (model.endsWith("/video-edit")
    && (typeof body.video !== "string" || !body.video || body.video.length > MAX_VIDEO_LENGTH)) {
    return NextResponse.json({ error: "Video Edit requires a valid source video." }, { status: 400 });
  }
  for (const key of ["image", "last_image"] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > MAX_IMAGE_LENGTH)) {
      return NextResponse.json({ error: `${key} must be a valid image URL or data URI.` }, { status: 400 });
    }
  }
  if (body.images !== undefined && (!Array.isArray(body.images) || body.images.length > 10
    || body.images.some((image) => typeof image !== "string" || image.length > MAX_IMAGE_LENGTH))) {
    return NextResponse.json({ error: "Reference images must be valid image URLs or data URIs." }, { status: 400 });
  }
  if (body.video !== undefined && (typeof body.video !== "string" || body.video.length > MAX_VIDEO_LENGTH)) {
    return NextResponse.json({ error: "Video must be a valid URL or data URI." }, { status: 400 });
  }
  if (body.duration !== undefined && (typeof body.duration !== "number" || !Number.isInteger(body.duration)
    || body.duration < 3 || body.duration > 10)) {
    return NextResponse.json({ error: "Duration must be a whole number from 3 to 10 seconds." }, { status: 400 });
  }
  if (model.startsWith("google/veo3.1") && body.duration !== undefined
    && ![4, 6, 8].includes(Number(body.duration))) {
    return NextResponse.json({ error: "Veo duration must be 4, 6, or 8 seconds." }, { status: 400 });
  }
  if (model.startsWith("google/veo3.1") && body.duration !== undefined
    && body.resolution !== undefined && Number(body.duration) !== 8
    && ["1080p", "4k"].includes(String(body.resolution))) {
    return NextResponse.json({ error: "Veo 1080p and 4K generations require an 8-second duration." }, { status: 400 });
  }
  if (body.resolution !== undefined && !["360p", "720p", "1080p", "4k"].includes(String(body.resolution))) {
    return NextResponse.json({ error: "Choose a supported resolution." }, { status: 400 });
  }
  if (model.includes("veo3.1-lite") && body.resolution === "4k") {
    return NextResponse.json({ error: "Veo 3.1 Lite does not support 4K resolution." }, { status: 400 });
  }
  if (model.includes("gemini-omni-flash") && body.resolution !== undefined && body.resolution !== "720p") {
    return NextResponse.json({ error: "Gemini Omni Flash supports 720p resolution only." }, { status: 400 });
  }
  if (body.aspect_ratio !== undefined && !["16:9", "9:16"].includes(String(body.aspect_ratio))) {
    return NextResponse.json({ error: "Choose a supported aspect ratio." }, { status: 400 });
  }
  if (body.seed !== undefined && (!Number.isInteger(body.seed) || Number(body.seed) < -1)) {
    return NextResponse.json({ error: "Seed must be an integer or -1 for random." }, { status: 400 });
  }
  if (body.thinking_level !== undefined && !["low", "default", "high"].includes(String(body.thinking_level))) {
    return NextResponse.json({ error: "Choose a supported thinking level." }, { status: 400 });
  }
  if (body.generate_audio !== undefined && typeof body.generate_audio !== "boolean") {
    return NextResponse.json({ error: "Generate audio must be a boolean." }, { status: 400 });
  }

  const atlasBody: Record<string, unknown> = { model };
  for (const field of fields) {
    if (body[field] !== undefined) atlasBody[field] = body[field];
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
