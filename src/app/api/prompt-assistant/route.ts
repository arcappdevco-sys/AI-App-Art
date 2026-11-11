import { NextResponse } from "next/server";
import {
  buildPromptAssistantSystemPrompt,
  PROMPT_ASSISTANT_MODELS,
  PROMPT_ASSISTANT_TARGETS,
  type PromptAssistantTarget,
} from "@/lib/prompt-assistant";
import { promptAssistantTargetContext, type PromptAssistantConnectedTarget } from "@/lib/prompt-assistant-profiles";

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
  let targets: PromptAssistantConnectedTarget[] = [];
  if (body.connectedTargets !== undefined) {
    if (!Array.isArray(body.connectedTargets) || body.connectedTargets.length > 32
      || body.connectedTargets.some((target: unknown) => !target || typeof target !== "object" || Array.isArray(target)
        || typeof (target as Record<string, unknown>).type !== "string"
        || typeof (target as Record<string, unknown>).model !== "string"
        || typeof (target as Record<string, unknown>).task !== "string"
        || typeof (target as Record<string, unknown>).promptExpansion !== "boolean"
        || ["type", "model", "task"].some((key) => String((target as Record<string, unknown>)[key]).length > 200))) {
      return NextResponse.json({ error: "Connected model context is invalid." }, { status: 400 });
    }
    targets = body.connectedTargets as PromptAssistantConnectedTarget[];
  }
  const context = promptAssistantTargetContext(targets);
  const historyMessageLimit = context ? 100000 : MAX_MESSAGE_LENGTH;
  const historyLimit = context ? 200000 : 30000;
  const history = body.history;
  if (!Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES
    || history.some((message) => typeof message !== "object" || message === null
      || !["user", "assistant"].includes(String((message as Record<string, unknown>).role))
      || typeof (message as Record<string, unknown>).content !== "string"
      || ((message as Record<string, unknown>).content as string).length > historyMessageLimit)) {
    return NextResponse.json({ error: "Conversation history is invalid or too long." }, { status: 400 });
  }
  const historyCharacters = history.reduce(
    (total, message) => total + ((message as ChatMessage).content as string).length,
    0,
  );
  if (historyCharacters > historyLimit) {
    return NextResponse.json({ error: `Conversation history must not exceed ${historyLimit.toLocaleString()} characters.` }, { status: 400 });
  }
  const imageSetup = body.imageSetup;
  if (!Array.isArray(imageSetup) || imageSetup.length > 3
    || imageSetup.some((item) => typeof item !== "string" || !IMAGE_SETUP_OPTIONS.has(item))) {
    return NextResponse.json({ error: "Image setup context is invalid." }, { status: 400 });
  }
  const briefLimit = context ? 100000 : MAX_MESSAGE_LENGTH;
  if (body.connectedBrief !== undefined
    && (typeof body.connectedBrief !== "string" || body.connectedBrief.length > briefLimit)) {
    return NextResponse.json({ error: `Connected draft must not exceed ${briefLimit} characters.` }, { status: 400 });
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
    context?.instructions,
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
  if (context) {
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch {
      return NextResponse.json({ error: "The assistant returned an invalid response. Please retry." }, { status: 502 });
    }
    if (!output || typeof output !== "object" || Array.isArray(output)
      || typeof (output as Record<string, unknown>).prompt !== "string"
      || typeof (output as Record<string, unknown>).notice !== "string") {
      return NextResponse.json({ error: "The assistant returned an invalid prompt and notice. Please retry." }, { status: 502 });
    }
    const prompt = String((output as Record<string, unknown>).prompt).trim();
    let notice = String((output as Record<string, unknown>).notice).trim();
    const promptLimit = /[^\u0000-\u007f]/.test(prompt) ? context.nonEnglishMaxLength : context.maxLength;
    if (!prompt || (promptLimit !== null && prompt.length > promptLimit)) {
      return NextResponse.json({ error: `The assistant returned an empty or over-limit prompt${promptLimit ? ` (maximum ${promptLimit} characters)` : ""}. Please retry.` }, { status: 502 });
    }
    const tags = (text: string): string[] => Array.from(text.matchAll(/@[a-zA-Z][a-zA-Z0-9_]*|<<<[a-zA-Z][a-zA-Z0-9_]*>>>/g), (match) => match[0]);
    const originalTags = tags([connectedBrief, body.message].join("\n"));
    const generatedTags = tags(prompt);
    if (generatedTags.some((tag) => !originalTags.includes(tag))
      || originalTags.some((tag) => !generatedTags.includes(tag))) {
      return NextResponse.json({ error: "The assistant changed or invented a reference tag. Please retry." }, { status: 502 });
    }
    const source = `${connectedBrief}\n${body.message}`;
    const inputLimit = /[^\u0000-\u007f]/.test(source) ? context.nonEnglishMaxLength : context.maxLength;
    if (inputLimit && (connectedBrief.length > inputLimit || String(body.message).length > inputLimit)) {
      notice = [notice, "The original text exceeded the target limit and was shortened."].filter(Boolean).join(" ");
    }
    return NextResponse.json({ content: prompt, notice });
  }
  return NextResponse.json({ content: content.trim() });
}
