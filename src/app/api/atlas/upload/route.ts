import { NextResponse } from "next/server";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff",
  "image/gif", "image/heic", "image/heif",
]);

function findMediaUrl(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findMediaUrl(item, depth + 1);
      if (url) return url;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  for (const key of ["url", "file_url", "fileUrl", "media_url", "mediaUrl", "image_url", "imageUrl"]) {
    const url = findMediaUrl(record[key], depth + 1);
    if (url) return url;
  }
  for (const key of ["data", "result", "file", "media", "output"]) {
    const url = findMediaUrl(record[key], depth + 1);
    if (url) return url;
  }
  for (const value of Object.values(record)) {
    const url = findMediaUrl(value, depth + 1);
    if (url) return url;
  }
  return "";
}

export async function POST(request: Request) {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ATLASCLOUD_API_KEY is not set in .env.local." }, { status: 500 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "Image uploads must be 30 MB or smaller." }, { status: 413 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Upload must be a multipart form." }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose an image file to upload." }, { status: 400 });
  }
  if (!IMAGE_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Images must be JPEG, PNG, WebP, BMP, TIFF, GIF, or HEIC." }, { status: 400 });
  }
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Images must be 30 MB or smaller." }, { status: 400 });
  }

  const atlasForm = new FormData();
  atlasForm.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetch("https://api.atlascloud.ai/api/v1/model/uploadMedia", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: atlasForm,
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not upload the image to Atlas Cloud." }, { status: 502 });
  }

  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Atlas Cloud returned an invalid upload response." }, { status: 502 });
  }
  if (!response.ok) {
    const message = typeof result.message === "string" ? result.message : `Atlas Cloud upload failed (${response.status}).`;
    return NextResponse.json({ error: message }, { status: response.status });
  }
  const url = findMediaUrl(result);
  if (!url) {
    const responseKeys = Object.keys(result).join(", ");
    const code = result.code === undefined ? "" : ` (code: ${String(result.code)})`;
    const message = typeof result.message === "string" && result.message
      ? ` Atlas Cloud message: ${result.message}`
      : "";
    return NextResponse.json({
      error: `Atlas Cloud upload response did not include a media URL${code}${responseKeys ? ` (response fields: ${responseKeys}).` : "."}${message}`,
    }, { status: 502 });
  }
  return NextResponse.json({ url });
}
