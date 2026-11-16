import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API_KEY_NAMES = ["OPENAI_API_KEY", "GEMINI_API_KEY", "ATLASCLOUD_API_KEY", "FAL_KEY"] as const;
type ApiKeyName = (typeof API_KEY_NAMES)[number];
type ApiKeyValues = Record<ApiKeyName, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function localHost(host: string | null) {
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

function isLocalSetupRequest(request: Request) {
  if (process.env.NODE_ENV !== "development") return false;
  const host = request.headers.get("host");
  if (!localHost(host)) return false;

  const origin = request.headers.get("origin");
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.protocol === "http:"
      && localHost(parsedOrigin.host)
      && parsedOrigin.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function configuredKeys(): Record<ApiKeyName, boolean> {
  return {
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY?.trim()),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY?.trim()),
    ATLASCLOUD_API_KEY: Boolean(process.env.ATLASCLOUD_API_KEY?.trim()),
    FAL_KEY: Boolean(process.env.FAL_KEY?.trim()),
  };
}

function escapeEnvValue(value: string) {
  return JSON.stringify(value).replace(/\$/g, "\\$");
}

function updateEnvFile(existing: string, values: ApiKeyValues) {
  const hasTrailingNewline = existing.endsWith("\n") || existing.endsWith("\r");
  const lines = existing ? existing.split(/\r?\n/) : [];
  if (hasTrailingNewline) lines.pop();

  const written = new Set<ApiKeyName>();
  const updatedLines: string[] = [];
  const keyPattern = /^\s*(OPENAI_API_KEY|GEMINI_API_KEY|ATLASCLOUD_API_KEY|FAL_KEY)\s*=/;

  for (const line of lines) {
    const match = line.match(keyPattern);
    if (!match) {
      updatedLines.push(line);
      continue;
    }

    const name = match[1] as ApiKeyName;
    if (!values[name]) {
      updatedLines.push(line);
    } else if (!written.has(name)) {
      updatedLines.push(`${name}=${escapeEnvValue(values[name])}`);
      written.add(name);
    }
  }

  for (const name of API_KEY_NAMES) {
    if (values[name] && !written.has(name)) updatedLines.push(`${name}=${escapeEnvValue(values[name])}`);
  }

  return `${updatedLines.join("\n")}\n`;
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return jsonResponse({ error: "Local API key setup is only available in development." }, 404);
  }
  if (!localHost(request.headers.get("host"))) {
    return jsonResponse({ error: "Open the app on this computer using localhost to manage API keys." }, 403);
  }

  const configured = configuredKeys();
  return jsonResponse({ configured, anyConfigured: Object.values(configured).some(Boolean) });
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return jsonResponse({ error: "Local API key setup is only available in development." }, 404);
  }
  if (!isLocalSetupRequest(request)) {
    return jsonResponse({ error: "Open the app on this computer using localhost to manage API keys." }, 403);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "The API key form data was not valid JSON." }, 400);
  }
  if (!isRecord(payload)) {
    return jsonResponse({ error: "The API key form data must be an object." }, 400);
  }

  const unexpectedName = Object.keys(payload).find((name) => !API_KEY_NAMES.includes(name as ApiKeyName));
  if (unexpectedName) {
    return jsonResponse({ error: `Unsupported API key name: ${unexpectedName}.` }, 400);
  }

  const values: ApiKeyValues = {
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    ATLASCLOUD_API_KEY: "",
    FAL_KEY: "",
  };
  for (const name of API_KEY_NAMES) {
    const value = payload[name] ?? "";
    if (typeof value !== "string") {
      return jsonResponse({ error: `${name} must be a string.` }, 400);
    }
    const trimmed = value.trim();
    if (trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return jsonResponse({ error: `${name} is too long or contains invalid characters.` }, 400);
    }
    values[name] = trimmed;
  }

  if (!API_KEY_NAMES.some((name) => values[name])) {
    return jsonResponse({ error: "Enter at least one API key before saving." }, 400);
  }

  const envFilePath = join(process.cwd(), ".env.local");
  let existing = "";
  try {
    existing = await readFile(envFilePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.error("Could not read the local API key file.", error);
      return jsonResponse({ error: "Could not read .env.local. Check file permissions and try again." }, 500);
    }
  }

  try {
    await writeFile(envFilePath, updateEnvFile(existing, values), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("Could not save local API key settings.", error);
    return jsonResponse({ error: "Could not save .env.local. Check file permissions and try again." }, 500);
  }

  return jsonResponse({
    saved: API_KEY_NAMES.filter((name) => Boolean(values[name])),
    configured: Object.fromEntries(API_KEY_NAMES.map((name) => [
      name,
      Boolean(values[name] || process.env[name]?.trim()),
    ])),
  });
}
