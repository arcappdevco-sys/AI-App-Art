import { NextResponse } from "next/server";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff",
  "image/gif", "image/heic", "image/heif",
]);

export async function POST(request: Request) {
  const apiKey = process.env.ATLASCLOUD_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ATLASCLOUD_API_KEY is not set in .env.local." }, { status: 500 });
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: "Seedance image uploads must be 30 MB or smaller." }, { status: 413 });
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
    return NextResponse.json({ error: "Seedance images must be JPEG, PNG, WebP, BMP, TIFF, GIF, or HEIC." }, { status: 400 });
  }
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Seedance images must be 30 MB or smaller." }, { status: 400 });
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
  const data = result.data as Record<string, unknown> | undefined;
  const url = typeof result.url === "string" ? result.url : typeof data?.url === "string" ? data.url : "";
  if (!url) {
    return NextResponse.json({ error: "Atlas Cloud did not return an uploaded media URL." }, { status: 502 });
  }
  return NextResponse.json({ url });
}
