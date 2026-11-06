import { NextResponse } from "next/server";
import {
  buildPromptAssistantSystemPrompt,
  PROMPT_ASSISTANT_MODELS,
  PROMPT_ASSISTANT_TARGETS,
  type PromptAssistantTarget,
} from "@/lib/prompt-assistant";

const MAX_MESSAGE_LENGTH = 6000;
const MAX_HISTORY_MESSAGES = 20;
const IMAGE_SETUP_OPTIONS = new Set(["First frame", "Last frame", "Reference images"]);

type ChatMessage = { role: "user" | "assistant"; content: string };

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
  const models = Object.values(PROMPT_ASSISTANT_MODELS);
  if (typeof body.model !== "string" || !models.includes(body.model as (typeof models)[number])) {
    return NextResponse.json({ error: "Choose a supported Prompt Assistant LLM." }, { status: 400 });
  }
  if (typeof body.target !== "string" || !Object.prototype.hasOwnProperty.call(PROMPT_ASSISTANT_TARGETS, body.target)) {
    return NextResponse.json({ error: "Choose a supported target media model." }, { status: 400 });
  }
  if (typeof body.message !== "string" || !body.message.trim() || body.message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters.` }, { status: 400 });
  }
  const history = body.history;
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES
    || history.some((message) => typeof message !== "object" || message === null
      || !["user", "assistant"].includes(String((message as Record<string, unknown>).role))
      || typeof (message as Record<string, unknown>).content !== "string"
      || ((message as Record<string, unknown>).content as string).length > MAX_MESSAGE_LENGTH)) {
    return NextResponse.json({ error: "Conversation history is invalid or too long." }, { status: 400 });
  }
  const historyCharacters = history.reduce(
    (total, message) => total + ((message as ChatMessage).content as string).length,
    0,
  );
  if (historyCharacters > 30000) {
    return NextResponse.json({ error: "Conversation history must not exceed 30,000 characters." }, { status: 400 });
  }
  const imageSetup = body.imageSetup;
  if (!Array.isArray(imageSetup) || imageSetup.length > 3
    || imageSetup.some((item) => typeof item !== "string" || !IMAGE_SETUP_OPTIONS.has(item))) {
    return NextResponse.json({ error: "Image setup context is invalid." }, { status: 400 });
  }
  if (body.connectedBrief !== undefined
    && (typeof body.connectedBrief !== "string" || body.connectedBrief.length > MAX_MESSAGE_LENGTH)) {
    return NextResponse.json({ error: `Connected draft must not exceed ${MAX_MESSAGE_LENGTH} characters.` }, { status: 400 });
  }
  const connectedBrief = typeof body.connectedBrief === "string" ? body.connectedBrief : "";

  const messages: ChatMessage[] = history.map((message) => ({
    role: (message as ChatMessage).role,
    content: (message as ChatMessage).content,
  }));
  messages.push({ role: "user", content: body.message });
  const systemPrompt = buildPromptAssistantSystemPrompt(
    body.target as PromptAssistantTarget,
    imageSetup as string[],
    connectedBrief,
  );

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: body.model,
        instructions: systemPrompt,
        input: messages,
        max_output_tokens: 1200,
        store: true,
      }),
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
    const message = typeof error?.message === "string" ? error.message : `OpenAI request failed (${response.status}).`;
    return NextResponse.json({ error: message }, { status: response.status });
  }

  const output = result.output as Array<{
    type?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  }> | undefined;
  const content = output
    ?.filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .find((item) => item.type === "output_text")?.text;
  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "OpenAI did not return a prompt or assistant message." }, { status: 502 });
  }
  return NextResponse.json({ content: content.trim() });
}
