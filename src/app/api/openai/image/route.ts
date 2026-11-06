import { NextResponse } from "next/server";

const MODELS = new Set(["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]);
const SIZES = new Set(["1024x1024", "1536x1024", "1024x1536"]);
const QUALITIES = new Set(["low", "medium", "high", "xhigh", "max"]);
const COMPLEXITIES = new Set(["low", "medium", "high"]);
const MAX_PROMPT_LENGTH = 20_000;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not set in .env.local." }, { status: 500 });
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
    return NextResponse.json({ error: "Choose a supported GPT Image model." }, { status: 400 });
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json({ error: `Prompt must contain 1 to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.` }, { status: 400 });
  }
  if (body.size !== undefined && body.size !== "auto" && (typeof body.size !== "string" || !SIZES.has(body.size))) {
    return NextResponse.json({ error: "Choose a supported image size." }, { status: 400 });
  }
  if (body.quality !== undefined && body.quality !== "auto"
    && (typeof body.quality !== "string" || !QUALITIES.has(body.quality))) {
    return NextResponse.json({ error: "Choose a supported image quality." }, { status: 400 });
  }
  if (body.complexity !== undefined
    && (typeof body.complexity !== "string" || !COMPLEXITIES.has(body.complexity))) {
    return NextResponse.json({ error: "Choose a supported image complexity." }, { status: 400 });
  }

  const openAiBody: Record<string, unknown> = {
    model: body.model,
    prompt: body.prompt,
  };
  if (body.size && body.size !== "auto") openAiBody.size = body.size;
  if (body.quality && body.quality !== "auto") openAiBody.quality = body.quality;
  if (body.complexity) openAiBody.complexity = body.complexity;

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(openAiBody),
      signal: request.signal,
    });
  } catch {
    return NextResponse.json({ error: "Could not reach OpenAI." }, { status: 502 });
  }

  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "OpenAI returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    const error = result.error as Record<string, unknown> | undefined;
    return NextResponse.json({
      error: typeof error?.message === "string" ? error.message : `OpenAI request failed (${response.status}).`,
    }, { status: response.status });
  }

  const images = result.data as Array<{ b64_json?: unknown }> | undefined;
  const image = images?.[0]?.b64_json;
  if (typeof image !== "string" || !image) {
    return NextResponse.json({ error: "OpenAI did not return an image." }, { status: 502 });
  }
  return NextResponse.json({ image: `data:image/png;base64,${image}` });
}
