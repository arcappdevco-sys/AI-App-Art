import { NextResponse } from "next/server";

const ATLAS_API = "https://api.atlascloud.ai/api/v1/model";
const MODEL_FIELDS: Record<string, { maxDuration: number; fields: string[]; promptRequired: boolean }> = {
  "kwaivgi/kling-v4.0/text-to-video": {
    maxDuration: 30,
    fields: ["prompt", "duration", "aspect_ratio", "resolution"],
    promptRequired: true,
  },
  "kwaivgi/kling-v4.0/image-to-video": {
    maxDuration: 30,
    fields: ["prompt", "image", "middle_images", "last_image", "duration", "resolution"],
    promptRequired: false,
  },
  "kwaivgi/kling-v4.0/reference-to-video": {
    maxDuration: 30,
    fields: [
      "prompt", "reference_images", "reference_videos", "elements", "voice_ids",
      "image", "middle_images", "last_image", "duration", "aspect_ratio", "resolution",
    ],
    promptRequired: true,
  },
  "kwaivgi/kling-v4.0/video-edit": {
    maxDuration: 30,
    fields: ["prompt", "video", "reference_images", "reference_videos", "elements", "voice_ids", "duration", "resolution"],
    promptRequired: true,
  },
  "kwaivgi/kling-v3.0-pro/text-to-video": {
    maxDuration: 15,
    fields: ["prompt", "duration", "aspect_ratio", "sound"],
    promptRequired: true,
  },
  "kwaivgi/kling-v3.0-pro/image-to-video": {
    maxDuration: 15,
    fields: ["prompt", "image", "end_image", "duration", "sound"],
    promptRequired: false,
  },
  "kwaivgi/kling-v3.0-std/text-to-video": {
    maxDuration: 15,
    fields: ["prompt", "duration", "aspect_ratio", "sound"],
    promptRequired: true,
  },
  "kwaivgi/kling-v3.0-std/image-to-video": {
    maxDuration: 15,
    fields: ["prompt", "image", "end_image", "duration", "sound"],
    promptRequired: false,
  },
};
const MAX_IMAGE_LENGTH = 42 * 1024 * 1024;
const MAX_VIDEO_LENGTH = 420 * 1024 * 1024;
const resolutions = new Set(["720p", "1080p", "1080p-esr", "2k-esr", "4k-esr"]);

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
  const modelConfig = MODEL_FIELDS[model];
  if (!modelConfig) {
    return NextResponse.json({ error: "Choose a supported Kling model and task." }, { status: 400 });
  }

  const isImageToVideo = model.endsWith("/image-to-video");
  const isVideoEdit = model.endsWith("/video-edit");
  if (modelConfig.promptRequired && (typeof body.prompt !== "string" || !body.prompt.trim())) {
    return NextResponse.json({ error: "This Kling task requires a prompt." }, { status: 400 });
  }
  if (body.prompt !== undefined) {
    const promptLimit = model.includes("/kling-v3.0-") ? 2500 : /[^\u0000-\u007f]/.test(String(body.prompt)) ? 11000 : 26000;
    if (typeof body.prompt !== "string" || body.prompt.length > promptLimit) {
      return NextResponse.json({ error: `Prompt must not exceed ${promptLimit.toLocaleString()} characters.` }, { status: 400 });
    }
  }
  if (isImageToVideo && (typeof body.image !== "string" || !body.image || body.image.length > MAX_IMAGE_LENGTH)) {
    return NextResponse.json({ error: "Image-to-Video requires a valid first-frame image." }, { status: 400 });
  }
  if (isVideoEdit && (typeof body.video !== "string" || !body.video || body.video.length > MAX_VIDEO_LENGTH)) {
    return NextResponse.json({ error: "Video Edit requires a valid source video." }, { status: 400 });
  }
  if (typeof body.duration !== "number" || !Number.isInteger(body.duration)
    || body.duration < 3 || body.duration > modelConfig.maxDuration) {
    return NextResponse.json({ error: `Duration must be a whole number from 3 to ${modelConfig.maxDuration} seconds.` }, { status: 400 });
  }
  if (body.resolution !== undefined && (typeof body.resolution !== "string" || !resolutions.has(body.resolution))) {
    return NextResponse.json({ error: "Choose a supported Kling 4.0 resolution." }, { status: 400 });
  }
  if (body.aspect_ratio !== undefined && !["auto", "16:9", "9:16", "1:1", "21:9"].includes(String(body.aspect_ratio))) {
    return NextResponse.json({ error: "Choose a supported Kling aspect ratio." }, { status: 400 });
  }
  if (body.sound !== undefined && typeof body.sound !== "boolean") {
    return NextResponse.json({ error: "The sound setting must be a boolean." }, { status: 400 });
  }
  if (body.elements !== undefined && (!Array.isArray(body.elements) || body.elements.length > 7)) {
    return NextResponse.json({ error: "Kling supports up to 7 subjects." }, { status: 400 });
  }
  if (body.voice_ids !== undefined && (!Array.isArray(body.voice_ids) || body.voice_ids.length > 3
    || body.voice_ids.some((voice) => typeof voice !== "string" || !voice.trim()))) {
    return NextResponse.json({ error: "Kling supports up to 3 non-empty Voice IDs." }, { status: 400 });
  }
  if (body.middle_images !== undefined && (!Array.isArray(body.middle_images)
    || body.middle_images.length > 8
    || body.middle_images.some((image) => typeof image !== "string" || image.length > MAX_IMAGE_LENGTH))) {
    return NextResponse.json({ error: "Kling supports up to 8 valid middle keyframes." }, { status: 400 });
  }
  for (const key of ["image", "end_image", "last_image"] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > MAX_IMAGE_LENGTH)) {
      return NextResponse.json({ error: `${key} must be a valid image URL or data URI.` }, { status: 400 });
    }
  }
  if (body.reference_images !== undefined && (!Array.isArray(body.reference_images)
    || body.reference_images.length > 10
    || body.reference_images.some((image) => typeof image !== "string" || image.length > MAX_IMAGE_LENGTH))) {
    return NextResponse.json({ error: "Kling supports up to 10 valid reference images." }, { status: 400 });
  }
  if (body.video !== undefined && (typeof body.video !== "string" || body.video.length > MAX_VIDEO_LENGTH)) {
    return NextResponse.json({ error: "Video must be a valid URL or data URI." }, { status: 400 });
  }
  if (body.reference_videos !== undefined && (!Array.isArray(body.reference_videos)
    || body.reference_videos.length > (isVideoEdit ? 4 : 5)
    || body.reference_videos.some((video) => typeof video !== "string" || video.length > MAX_VIDEO_LENGTH))) {
    return NextResponse.json({ error: "Kling received an invalid number or size of reference videos." }, { status: 400 });
  }

  const atlasBody: Record<string, unknown> = { model };
  for (const key of modelConfig.fields) {
    if (body[key] !== undefined) atlasBody[key] = body[key];
  }

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/generateVideo`, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
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
      headers: { Authorization: "Bearer " + apiKey },
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
