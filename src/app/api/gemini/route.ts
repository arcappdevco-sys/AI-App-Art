import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse } from "next/server";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] >= 224;
  }

  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1"
    || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("::ffff:");
}

async function imagePart(url: string): Promise<{ inline_data: { mime_type: string; data: string } }> {
  let mime: string;
  let data: Buffer;

  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new Error("Reference image must be a base64 image data URL");
    mime = match[1].toLowerCase();
    data = Buffer.from(match[2], "base64");
  } else {
    let imageUrl: URL;
    try {
      imageUrl = new URL(url);
    } catch {
      throw new Error("Reference image URL is invalid");
    }

    if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password)
      throw new Error("Reference image URL must use HTTPS");
    if (imageUrl.hostname === "localhost" || imageUrl.hostname.endsWith(".localhost"))
      throw new Error("Reference image URL host is not allowed");

    const addresses = isIP(imageUrl.hostname)
      ? [{ address: imageUrl.hostname }]
      : await lookup(imageUrl.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address)))
      throw new Error("Reference image URL host is not allowed");

    const response = await fetch(imageUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Could not fetch a reference image (${response.status})`);
    mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!IMAGE_MIME_TYPES.has(mime)) throw new Error("Reference URL did not return a supported image");

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES)
      throw new Error("Reference image exceeds the 10 MB limit");

    if (!response.body) throw new Error("Reference image response was empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Reference image exceeds the 10 MB limit");
      }
      chunks.push(value);
    }
    data = Buffer.concat(chunks);
  }

  if (!IMAGE_MIME_TYPES.has(mime)) throw new Error("Reference image type is not supported");
  if (!data.length || data.length > MAX_IMAGE_BYTES)
    throw new Error("Reference image must be between 1 byte and 10 MB");

  return { inline_data: { mime_type: mime, data: data.toString("base64") } };
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key)
    return NextResponse.json({ error: "GEMINI_API_KEY is not set in .env.local" }, { status: 500 });

  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES)
    return NextResponse.json({ error: "Request exceeds the 32 MB limit" }, { status: 413 });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null)
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });

  const { model, prompt, images = [], aspectRatio } = payload as Record<string, unknown>;
  if (typeof model !== "string" || !/^[a-zA-Z0-9._-]+$/.test(model))
    return NextResponse.json({ error: "A valid Gemini model is required" }, { status: 400 });
  if (typeof prompt !== "string" || !prompt.trim())
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (!Array.isArray(images) || images.length > 3 || images.some((image) => typeof image !== "string"))
    return NextResponse.json({ error: "Images must be an array of up to three image URLs" }, { status: 400 });
  if (aspectRatio !== undefined && aspectRatio !== "auto"
    && !["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"].includes(String(aspectRatio)))
    return NextResponse.json({ error: "Aspect ratio is not supported" }, { status: 400 });

  let parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>;
  try {
    parts = [{ text: prompt }];
    for (const url of images) parts.push(await imagePart(url as string));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not process reference image" },
      { status: 400 },
    );
  }

  const body: {
    contents: Array<{ parts: typeof parts }>;
    generationConfig: { responseModalities: string[]; imageConfig?: { aspectRatio: string } };
  } = { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } };
  if (aspectRatio && aspectRatio !== "auto")
    body.generationConfig.imageConfig = { aspectRatio: String(aspectRatio) };

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      },
    );
  } catch {
    return NextResponse.json({ error: "Could not reach the Gemini API" }, { status: 502 });
  }

  let json: Record<string, unknown>;
  try {
    json = await response.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Gemini returned an invalid response" }, { status: 502 });
  }
  if (!response.ok) {
    const apiError = json.error as { message?: unknown } | undefined;
    return NextResponse.json(
      { error: typeof apiError?.message === "string" ? apiError.message : `Gemini error ${response.status}` },
      { status: response.status },
    );
  }

  const candidates = json.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined;
  const outParts = candidates?.[0]?.content?.parts ?? [];
  const image = outParts.find((part) => part.inlineData || part.inline_data);
  const imageData = (image?.inlineData ?? image?.inline_data) as
    { mimeType?: string; mime_type?: string; data?: string } | undefined;
  if (!imageData?.data) {
    const text = outParts.map((part) => part.text).filter((value): value is string => typeof value === "string").join(" ");
    return NextResponse.json(
      { error: text || "No image returned. The prompt may have been blocked." },
      { status: 422 },
    );
  }

  return NextResponse.json({
    image: `data:${imageData.mimeType ?? imageData.mime_type ?? "image/png"};base64,${imageData.data}`,
  });
}
