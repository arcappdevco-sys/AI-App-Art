import { NextResponse } from "next/server";
import {
  normalizeGeneratedStoryboard,
  STORYBOARD_SCRIPT_OUTPUT_SCHEMA,
} from "@/lib/StoryboardScript";
import { STORYBOARD_SCRIPT_MAX_CHARACTERS } from "@/lib/StoryboardData";
import {
  buildStoryboardChatMessages,
  buildGeminiStoryboardRequest,
  extractGeminiStoryboardText,
  isStoryboardScriptProvider,
  STORYBOARD_SCRIPT_PROVIDERS,
  STORYBOARD_SCRIPT_INSTRUCTIONS,
  type StoryboardScriptProvider,
} from "@/lib/storyboard-script-generation";

function providerErrorMessage(result: Record<string, unknown>, providerLabel: string, status: number) {
  const nestedError = result.error;
  if (typeof nestedError === "string" && nestedError.trim()) return nestedError.trim();
  if (typeof nestedError === "object" && nestedError !== null) {
    const error = nestedError as Record<string, unknown>;
    for (const key of ["message", "detail", "description"]) {
      if (typeof error[key] === "string" && error[key].trim()) return error[key].trim();
    }
  }
  for (const key of ["message", "detail", "error_description"]) {
    const value = result[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${providerLabel} request failed (${status}).`;
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }

  const body = payload as Record<string, unknown>;
  const script = body.script;
  if (typeof script !== "string" || !script.trim()) {
    return NextResponse.json({ error: "Paste or upload a script first." }, { status: 400 });
  }
  if (script.length > STORYBOARD_SCRIPT_MAX_CHARACTERS) {
    return NextResponse.json({
      error: `Scripts must be ${STORYBOARD_SCRIPT_MAX_CHARACTERS.toLocaleString()} characters or fewer.`,
    }, { status: 413 });
  }

  const requestedProvider = body.provider === undefined ? "openai" : body.provider;
  if (!isStoryboardScriptProvider(requestedProvider)) {
    return NextResponse.json({ error: "Choose a supported storyboard text API." }, { status: 400 });
  }
  const provider: StoryboardScriptProvider = requestedProvider;
  const providerOption = STORYBOARD_SCRIPT_PROVIDERS.find((option) => option.id === provider);
  if (!providerOption) {
    return NextResponse.json({ error: "Choose a supported storyboard text API." }, { status: 400 });
  }
  const apiKeyName = providerOption.apiKeyName;
  const apiKey = process.env[apiKeyName];
  if (!apiKey) {
    return NextResponse.json({ error: `${apiKeyName} is not set in .env.local.` }, { status: 500 });
  }

  const isTopview = provider === "topview-gpt" || provider === "topview-claude";
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (isTopview && (!idempotencyKey || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))) {
    return NextResponse.json({ error: "A valid idempotency key is required for Topview requests." }, { status: 400 });
  }

  const url = provider === "gemini"
    ? "https://generativelanguage.googleapis.com/v1beta/interactions"
    : provider === "openai"
      ? "https://api.openai.com/v1/responses"
      : provider === "atlas"
        ? "https://api.atlascloud.ai/v1/chat/completions"
        : provider === "topview-claude"
          ? "https://platform-backend.topview.ai/v1/messages"
          : "https://platform-backend.topview.ai/v1/chat/completions";
  const headers = new Headers({ "Content-Type": "application/json" });
  if (provider === "gemini") {
    headers.set("x-goog-api-key", apiKey);
    headers.set("Api-Revision", "2026-05-20");
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  if (isTopview && idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

  const messages = buildStoryboardChatMessages(script);
  const requestBody = provider === "gemini"
    ? buildGeminiStoryboardRequest(script)
    : provider === "openai"
      ? {
      model: "gpt-4o",
      instructions: STORYBOARD_SCRIPT_INSTRUCTIONS,
      input: [{
        role: "user",
        content: `Convert this screenplay into a storyboard:\n\n<screenplay>\n${script.trim()}\n</screenplay>`,
      }],
      text: {
        format: {
          type: "json_schema",
          name: "storyboard",
          strict: true,
          schema: STORYBOARD_SCRIPT_OUTPUT_SCHEMA,
        },
      },
      max_output_tokens: 12000,
      store: false,
      }
      : provider === "atlas"
        ? {
          model: "deepseek-ai/deepseek-v3.2",
          messages,
          max_tokens: 8192,
        }
        : provider === "topview-gpt"
          ? {
            model: "gpt-5.5",
            messages,
            max_completion_tokens: 8192,
          }
          : {
            model: "claude-sonnet-5-5",
            system: messages[0].content,
            messages: [messages[1]],
            max_tokens: 8192,
          };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(isTopview ? 180_000 : 120_000),
    });
  } catch {
    return NextResponse.json({
      error: `Could not reach ${providerOption.label}.${isTopview ? " The request may still be processing or billable; check Topview Usage before retrying." : ""}`,
    }, { status: 502 });
  }

  const providerRequestId = isTopview ? response.headers.get("X-Platform-Request-Id") : null;
  let result: Record<string, unknown>;
  try {
    result = await response.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({
      error: `${providerOption.label} returned an invalid response.`,
      ...(providerRequestId ? { requestId: providerRequestId } : {}),
    }, {
      status: 502,
      headers: providerRequestId ? { "X-Platform-Request-Id": providerRequestId } : undefined,
    });
  }
  if (!response.ok) {
    const providerError = providerErrorMessage(result, providerOption.label, response.status);
    return NextResponse.json({
      error: `${providerError}${isTopview && response.status >= 500
        ? " Check Topview Usage before retrying; the request may have been billed." : ""}`,
      ...(providerRequestId ? { requestId: providerRequestId } : {}),
    }, {
      status: response.status,
      headers: providerRequestId ? { "X-Platform-Request-Id": providerRequestId } : undefined,
    });
  }

  const content = provider === "gemini"
    ? extractGeminiStoryboardText(result)
    : provider === "openai"
      ? (() => {
      const output = result.output as Array<{
        type?: unknown;
        content?: Array<{ type?: unknown; text?: unknown }>;
      }> | undefined;
      return output
        ?.filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .find((item) => item.type === "output_text")?.text;
      })()
      : provider === "topview-claude"
        ? (() => {
          const blocks = result.content as Array<{ type?: unknown; text?: unknown }> | undefined;
          return blocks?.filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text).join("");
        })()
        : (() => {
          const choices = result.choices as Array<{
            message?: { content?: unknown };
          }> | undefined;
          return choices?.[0]?.message?.content;
        })();
  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({
      error: `${providerOption.label} did not return a storyboard. Please retry.`,
    }, { status: 502 });
  }

  let generated: unknown;
  try {
    const jsonText = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    generated = normalizeGeneratedStoryboard(JSON.parse(jsonText));
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "The generated storyboard was invalid. Please retry.",
    }, { status: 502 });
  }
  return NextResponse.json(generated, {
    headers: providerRequestId ? { "X-Platform-Request-Id": providerRequestId } : undefined,
  });
}
