import { NextResponse } from "next/server";
import { validateWanRequestBody, validateWanUploadFile, validateWanImageMetadata } from "@/lib/wan";
import { validateMiniMaxRequestBody, validateMiniMaxUpload } from "@/lib/minimax";
import { FLUX3_MIN_SIDE_PX, FLUX3_SUBMIT_PATH, validateFlux3RequestBody, validateFlux3Upload } from "@/lib/flux3";
import { FLUX3_VIDEO_SUBMIT_PATH, validateFlux3VideoRequestBody, validateFlux3VideoUpload } from "@/lib/flux3-video";
const ATLAS_API = "https://api.atlascloud.ai/api/v1/model";
const PREDICTION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/bmp", "image/webp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageMetadata(bytes: Uint8Array, type: string) {
  if (type === "image/png" && bytes.length >= 26
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
    const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
    const colorType = bytes[25];
    let hasAlpha = colorType === 4 || colorType === 6;
    for (let offset = 8; !hasAlpha && offset + 12 <= bytes.length;) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const chunk = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (chunk === "tRNS") hasAlpha = true;
      if (length > bytes.length - offset - 12) break;
      offset += length + 12;
    }
    return { width, height, hasAlpha };
  }
  if (type === "image/bmp" && bytes.length >= 30 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true)),
      hasAlpha: view.getUint16(28, true) === 32,
    };
  }
  if (type === "image/webp" && bytes.length >= 25) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30) {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
        hasAlpha: (bytes[20] & 0x10) !== 0,
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      const width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      const height = 1 + ((bytes[22] >> 6) & 0x03) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return { width, height, hasAlpha: (bytes[24] & 0x10) !== 0 };
    }
    if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff, hasAlpha: false };
    }
  }
  if (type === "image/jpeg" && bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = view.getUint16(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return {
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
          hasAlpha: false,
        };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return null;
}

function atlasMessage(payload: unknown, fallback: string, apiKey: string) {
  let message = fallback;
  if (isRecord(payload)) {
    if (typeof payload.message === "string" && payload.message) message = payload.message;
    else if (typeof payload.error === "string" && payload.error) message = payload.error;
  }
  return message.replaceAll(apiKey, "[redacted]").replace(/authorization\s*[:=]\s*\S+/gi, "Authorization: [redacted]");
}

async function atlasJson(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    throw new Error("Atlas returned an invalid response.");
  }
}

function apiKeyMissing() {
  return NextResponse.json({ error: "Atlas API key is not configured on the server." }, { status: 500 });
}

function atlasAuthorization(apiKey: string) {
  const token = apiKey.trim().replace(/^Bearer\s+/i, "");
  return `Bearer ${token}`;
}

async function uploadMedia(request: Request, apiKey: string) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Upload must be a multipart form." }, { status: 400 });
  }
  if (form.get("action") === "minimax_upload") return uploadMiniMaxMedia(form, apiKey, request.signal);
  if (form.get("action") === "flux3_upload") return uploadFlux3Media(form, apiKey, request.signal);
  if (form.get("action") === "flux3_video_upload") return uploadFlux3VideoMedia(form, apiKey, request.signal);
  const keys = [...form.keys()];
  if (keys.some((key) => !["action", "kind", "file"].includes(key))
    || keys.filter((key) => key === "action").length !== 1
    || keys.filter((key) => key === "kind").length !== 1
    || form.get("action") !== "upload"
    || form.getAll("file").length !== 1) {
    return NextResponse.json({ error: "Upload accepts only one file and its media type." }, { status: 400 });
  }
  const kind = form.get("kind");
  const file = form.get("file");
  if (typeof kind !== "string" || !["image", "video", "audio", "document"].includes(kind)
    || !(file instanceof File)) {
    return NextResponse.json({ error: "Choose a supported media file." }, { status: 400 });
  }
  if (kind === "image" && !IMAGE_TYPES.has(file.type.toLowerCase())) {
    return NextResponse.json({ error: "Images must be JPEG, PNG, BMP, or WebP." }, { status: 400 });
  }
  const validationErrors = validateWanUploadFile(file, kind);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors[0] }, { status: 400 });

  if (kind === "image") {
    const metadata = imageMetadata(new Uint8Array(await file.arrayBuffer()), file.type.toLowerCase());
    if (!metadata) return NextResponse.json({ error: "Could not validate the image dimensions." }, { status: 400 });
    const imageErrors = validateWanImageMetadata({
      type: file.type,
      size: file.size,
      ...metadata,
    });
    if (imageErrors.length) return NextResponse.json({ error: imageErrors[0] }, { status: 400 });
  }
  if (kind === "document" && file.size > DOCUMENT_MAX_BYTES) {
    return NextResponse.json({ error: "Documents must be 100 MB or smaller." }, { status: 413 });
  }

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/uploadMedia`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey) },
      body: upstreamForm,
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not upload media to Atlas." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid upload response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas media upload failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  if (!isRecord(payload) || typeof payload.url !== "string" || !payload.url) {
    return NextResponse.json({ error: "Atlas upload did not return a media URL." }, { status: 502 });
  }
  return NextResponse.json({ url: payload.url });
}

async function uploadMiniMaxMedia(form: FormData, apiKey: string, signal: AbortSignal) {
  const keys = [...form.keys()];
  if (keys.some((key) => key !== "action" && key !== "file")
    || keys.filter((key) => key === "action").length !== 1
    || form.get("action") !== "minimax_upload"
    || form.getAll("file").length !== 1) {
    return NextResponse.json({ error: "MiniMax upload accepts only one file." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose a supported media file." }, { status: 400 });
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const kind = ["png", "jpg", "jpeg", "webp"].includes(extension)
    ? "image"
    : ["mp4", "mov"].includes(extension)
      ? "video"
      : ["mp3", "wav"].includes(extension)
        ? "audio"
        : "";
  const validationErrors = validateMiniMaxUpload(file, kind);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors[0] }, { status: 400 });

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/uploadMedia`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey) },
      body: upstreamForm,
      signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not upload media to Atlas." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid upload response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas media upload failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  if (!isRecord(payload) || typeof payload.url !== "string" || !/^https?:\/\/\S+$/i.test(payload.url)) {
    return NextResponse.json({ error: "Atlas upload did not return a public media URL." }, { status: 502 });
  }
  return NextResponse.json({ url: payload.url });
}

async function uploadFlux3Media(form: FormData, apiKey: string, signal: AbortSignal) {
  const keys = [...form.keys()];
  if (keys.some((key) => key !== "action" && key !== "file")
    || keys.filter((key) => key === "action").length !== 1
    || form.getAll("file").length !== 1) {
    return NextResponse.json({ error: "FLUX 3 upload accepts only one image file." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image file." }, { status: 400 });
  const validationErrors = validateFlux3Upload(file);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors[0] }, { status: 400 });
  const metadata = imageMetadata(new Uint8Array(await file.arrayBuffer()), file.type.toLowerCase());
  if (metadata && Math.min(metadata.width, metadata.height) < FLUX3_MIN_SIDE_PX) {
    return NextResponse.json({ error: `Each reference image must be at least ${FLUX3_MIN_SIDE_PX} px per side.` }, { status: 400 });
  }

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/uploadMedia`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey) },
      body: upstreamForm,
      signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not upload media to Atlas." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid upload response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas media upload failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  if (!isRecord(payload) || typeof payload.url !== "string" || !/^https?:\/\/\S+$/i.test(payload.url)) {
    return NextResponse.json({ error: "Atlas upload did not return a public media URL." }, { status: 502 });
  }
  return NextResponse.json({ url: payload.url });
}

async function generateFlux3(body: unknown, request: Request, apiKey: string) {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "action" && key !== "body")
    || body.action !== "flux3_generate") {
    return NextResponse.json({ error: "Request must contain only the FLUX 3 generate action and its body." }, { status: 400 });
  }
  const validationErrors = validateFlux3RequestBody(body.body);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors.join(" ") }, { status: 400 });

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/${FLUX3_SUBMIT_PATH}`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body.body),
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Atlas. The submit result could not be confirmed; do not retry automatically." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas generation request failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || typeof data.id !== "string" || !data.id || !PREDICTION_ID.test(data.id)) {
    return NextResponse.json({ error: "Atlas did not return a valid prediction ID." }, { status: 502 });
  }
  return NextResponse.json({
    predictionId: data.id,
    status: typeof data.status === "string" ? data.status : "created",
  });
}

async function uploadFlux3VideoMedia(form: FormData, apiKey: string, signal: AbortSignal) {
  const keys = [...form.keys()];
  if (keys.some((key) => key !== "action" && key !== "file")
    || keys.filter((key) => key === "action").length !== 1
    || form.getAll("file").length !== 1) {
    return NextResponse.json({ error: "FLUX 3 video upload accepts only one file." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image or MP4 file." }, { status: 400 });
  const validationErrors = validateFlux3VideoUpload(file);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors[0] }, { status: 400 });

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/uploadMedia`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey) },
      body: upstreamForm,
      signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not upload media to Atlas." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid upload response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas media upload failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  if (!isRecord(payload) || typeof payload.url !== "string" || !/^https?:\/\/\S+$/i.test(payload.url)) {
    return NextResponse.json({ error: "Atlas upload did not return a public media URL." }, { status: 502 });
  }
  return NextResponse.json({ url: payload.url });
}

async function generateFlux3Video(body: unknown, request: Request, apiKey: string) {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "action" && key !== "body")
    || body.action !== "flux3_video_generate") {
    return NextResponse.json({ error: "Request must contain only the FLUX 3 video generate action and its body." }, { status: 400 });
  }
  const validationErrors = validateFlux3VideoRequestBody(body.body);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors.join(" ") }, { status: 400 });

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/${FLUX3_VIDEO_SUBMIT_PATH}`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body.body),
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Atlas. The submit result could not be confirmed; do not retry automatically." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas generation request failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || typeof data.id !== "string" || !data.id || !PREDICTION_ID.test(data.id)) {
    return NextResponse.json({ error: "Atlas did not return a valid prediction ID." }, { status: 502 });
  }
  return NextResponse.json({
    predictionId: data.id,
    status: typeof data.status === "string" ? data.status : "created",
  });
}

// Read-only authenticated request; it never starts a generation or spends credits.
// Host and path follow Atlas's "Get account balance" docs (unverified on Atlas beyond that page).
async function checkFlux3Key(request: Request, apiKey: string) {
  try {
    const response = await fetch("https://api.atlascloud.ai/public/v1/balance", {
      headers: { Authorization: atlasAuthorization(apiKey) },
      signal: request.signal,
    });
    return NextResponse.json({
      result: response.ok ? "accepted" : response.status === 401 || response.status === 403 ? "rejected" : "unknown",
      status: response.status,
    });
  } catch {
    return NextResponse.json({ result: "unknown", status: 0 });
  }
}

async function generate(body: unknown, request: Request, apiKey: string) {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "action" && key !== "body")
    || body.action !== "generate") {
    return NextResponse.json({ error: "Request must contain only the generate action and its body." }, { status: 400 });
  }
  const validationErrors = validateWanRequestBody(body.body);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors.join(" ") }, { status: 400 });

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/generateVideo`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body.body),
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Atlas. The submit result could not be confirmed; do not retry automatically." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas generation request failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || typeof data.id !== "string" || !data.id || !PREDICTION_ID.test(data.id)) {
    return NextResponse.json({ error: "Atlas did not return a valid prediction ID." }, { status: 502 });
  }
  return NextResponse.json({
    predictionId: data.id,
    status: typeof data.status === "string" ? data.status : "created",
  });
}

async function generateMiniMax(body: unknown, request: Request, apiKey: string) {
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "action" && key !== "body")
    || body.action !== "minimax_generate") {
    return NextResponse.json({ error: "Request must contain only the MiniMax generate action and its body." }, { status: 400 });
  }
  const validationErrors = validateMiniMaxRequestBody(body.body);
  if (validationErrors.length) return NextResponse.json({ error: validationErrors.join(" ") }, { status: 400 });

  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/generateVideo`, {
      method: "POST",
      headers: { Authorization: atlasAuthorization(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body.body),
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach Atlas. The submit result could not be confirmed; do not retry automatically." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas generation request failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data || typeof data.id !== "string" || !data.id || !PREDICTION_ID.test(data.id)) {
    return NextResponse.json({ error: "Atlas did not return a valid prediction ID." }, { status: 502 });
  }
  return NextResponse.json({
    predictionId: data.id,
    status: typeof data.status === "string" ? data.status : "created",
  });
}

export async function POST(request: Request) {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) return apiKeyMissing();
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    return uploadMedia(request, apiKey);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (isRecord(body) && body.action === "minimax_generate") {
    return generateMiniMax(body, request, apiKey);
  }
  if (isRecord(body) && body.action === "flux3_generate") {
    return generateFlux3(body, request, apiKey);
  }
  if (isRecord(body) && body.action === "flux3_video_generate") {
    return generateFlux3Video(body, request, apiKey);
  }
  if (isRecord(body) && body.action === "flux3_check_key" && Object.keys(body).length === 1) {
    return checkFlux3Key(request, apiKey);
  }
  if (!isRecord(body) || body.action !== "generate") {
    return NextResponse.json({ error: "Only the generate action is supported." }, { status: 400 });
  }
  return generate(body, request, apiKey);
}

export async function GET(request: Request) {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) return apiKeyMissing();
  const predictionId = new URL(request.url).searchParams.get("prediction_id") ?? "";
  if (!PREDICTION_ID.test(predictionId)) {
    return NextResponse.json({ error: "A valid Atlas prediction ID is required." }, { status: 400 });
  }
  let response: Response;
  try {
    response = await fetch(`${ATLAS_API}/prediction/${encodeURIComponent(predictionId)}`, {
      headers: { Authorization: atlasAuthorization(apiKey) },
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not check the Atlas prediction." }, { status: 502 });
  }
  let payload: unknown;
  try {
    payload = await atlasJson(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Atlas returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({
      error: response.status === 401 || response.status === 403
        ? "Atlas rejected the API key."
        : atlasMessage(payload, `Atlas status check failed (${response.status}).`, apiKey),
    }, { status: response.status });
  }
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null;
  if (!data) return NextResponse.json({ error: "Atlas returned an invalid prediction status." }, { status: 502 });
  return NextResponse.json({ data });
}
