import { NextResponse } from "next/server";

const OLLAMA_URL = "http://127.0.0.1:11434";
const MAX_MESSAGES = 21;
const MAX_MESSAGE_LENGTH = 6000;
const MAX_TOTAL_LENGTH = 30000;

type ChatMessage = { role: "user" | "assistant"; content: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function localModels(signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Ollama model list failed (${response.status}).`);
  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.models)) throw new Error("Ollama returned an invalid model list.");
  return data.models.flatMap((model: unknown) =>
    isRecord(model) && typeof model.name === "string" && model.name
      && !model.remote_model && !model.remote_host && !model.name.endsWith(":cloud")
      ? [model.name] : []);
}

export async function GET(request: Request) {
  try {
    return NextResponse.json({ models: await localModels(request.signal) });
  } catch (error) {
    console.error("Could not load Ollama models:", error);
    return NextResponse.json({ error: "Could not load local Ollama models. Make sure Ollama is running on this computer." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!isRecord(payload) || typeof payload.model !== "string" || !payload.model.trim()
    || !Array.isArray(payload.messages) || payload.messages.length < 1 || payload.messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "Choose a model and provide a valid conversation." }, { status: 400 });
  }
  const messages: ChatMessage[] = [];
  let total = 0;
  for (const message of payload.messages) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")
      || typeof message.content !== "string" || !message.content.trim() || message.content.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: `Messages must contain 1 to ${MAX_MESSAGE_LENGTH} characters.` }, { status: 400 });
    }
    total += message.content.length;
    messages.push({ role: message.role, content: message.content });
  }
  if (total > MAX_TOTAL_LENGTH || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Conversation is too long or does not end with a user message." }, { status: 400 });
  }

  let models: string[];
  try {
    models = await localModels(request.signal);
  } catch (error) {
    console.error("Could not load Ollama models:", error);
    return NextResponse.json({ error: "Could not reach Ollama. Make sure it is running on this computer." }, { status: 502 });
  }
  if (!models.includes(payload.model)) {
    return NextResponse.json({ error: "That local model is not installed. Refresh the model list." }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: payload.model, messages, stream: false }),
      signal: request.signal,
    });
  } catch (error) {
    console.error("Ollama chat request failed:", error);
    return NextResponse.json({ error: "Could not reach Ollama. Make sure it is running on this computer." }, { status: 502 });
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return NextResponse.json({ error: "Ollama returned an invalid response." }, { status: 502 });
  }
  if (!response.ok) {
    const message = isRecord(result) && typeof result.error === "string" ? result.error : `Ollama request failed (${response.status}).`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
  if (!isRecord(result) || !isRecord(result.message)
    || typeof result.message.content !== "string" || !result.message.content.trim()) {
    return NextResponse.json({ error: "Ollama returned an empty chat response." }, { status: 502 });
  }
  return NextResponse.json({ content: result.message.content.trim() });
}
