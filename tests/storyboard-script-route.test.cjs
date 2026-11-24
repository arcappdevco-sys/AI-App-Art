/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  const mappedRequest = request.startsWith("@/")
    ? path.join(__dirname, "..", "src", request.slice(2))
    : request;
  return originalResolve.call(this, mappedRequest, parent, isMain, options);
};
const { POST } = require(path.join(__dirname, "..", "src", "app", "api", "storyboard", "generate", "route.ts"));
Module._resolveFilename = originalResolve;

const storyboard = {
  scenes: [{
    title: "EXT. GARDEN - DAWN",
    shots: [{
      title: "The sprout",
      description: "A seed opens in the morning light.",
      shotType: "Close-up",
      cameraMove: "Static",
      durationSeconds: 5,
      notes: "",
    }],
  }],
};

function post(body, headers = {}) {
  return POST(new Request("http://localhost/api/storyboard/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

test("Gemini selection routes storyboard text to Gemini and normalizes its JSON result", async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  let requestUrl = "";
  let requestOptions;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return new Response(JSON.stringify({
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(storyboard) }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const response = await post({ script: "A seed opens.", provider: "gemini" });
    assert.equal(response.status, 200);
    assert.equal(requestUrl, "https://generativelanguage.googleapis.com/v1beta/interactions");
    assert.equal(new Headers(requestOptions.headers).get("x-goog-api-key"), "test-gemini-key");
    assert.equal(new Headers(requestOptions.headers).get("api-revision"), "2026-05-20");
    assert.equal(new Headers(requestOptions.headers).get("authorization"), null);
    const sentBody = JSON.parse(requestOptions.body);
    assert.equal(sentBody.model, "gemini-3.8-flash");
    assert.equal(sentBody.store, false);
    assert.deepEqual((await response.json()).scenes[0].shots[0].frame, null);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("omitting the script provider preserves the existing OpenAI route", async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalFetch = global.fetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  let requestUrl = "";
  let requestOptions;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(storyboard) }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const response = await post({ script: "A seed opens." });
    assert.equal(response.status, 200);
    assert.equal(requestUrl, "https://api.openai.com/v1/responses");
    assert.equal(new Headers(requestOptions.headers).get("authorization"), "Bearer test-openai-key");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("Atlas Cloud selection uses DeepSeek chat with the Atlas key", async () => {
  const originalKey = process.env.ATLASCLOUD_API_KEY;
  const originalFetch = global.fetch;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  let requestUrl = "";
  let requestOptions;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(storyboard) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const response = await post({ script: "A seed opens.", provider: "atlas" });
    assert.equal(response.status, 200);
    assert.equal(requestUrl, "https://api.atlascloud.ai/v1/chat/completions");
    assert.equal(new Headers(requestOptions.headers).get("authorization"), "Bearer test-atlas-key");
    const sentBody = JSON.parse(requestOptions.body);
    assert.equal(sentBody.model, "deepseek-ai/deepseek-v3.2");
    assert.equal(sentBody.messages[0].role, "system");
    assert.equal(sentBody.max_tokens, 8192);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = originalKey;
  }
});

test("Atlas Cloud errors expose the provider's validation message", async () => {
  const originalKey = process.env.ATLASCLOUD_API_KEY;
  const originalFetch = global.fetch;
  process.env.ATLASCLOUD_API_KEY = "test-atlas-key";
  global.fetch = async () => new Response(JSON.stringify({
    message: "Invalid model ID.",
  }), { status: 400, headers: { "Content-Type": "application/json" } });

  try {
    const response = await post({ script: "A seed opens.", provider: "atlas" });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid model ID." });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = originalKey;
  }
});

test("Topview GPT selection uses its chat API and forwards the idempotency key", async () => {
  const originalKey = process.env.TOPVIEW_API_KEY;
  const originalFetch = global.fetch;
  process.env.TOPVIEW_API_KEY = "test-topview-key";
  let requestUrl = "";
  let requestOptions;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(storyboard) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const response = await post(
      { script: "A seed opens.", provider: "topview-gpt" },
      { "Idempotency-Key": "storyboard-request-0001" },
    );
    assert.equal(response.status, 200);
    assert.equal(requestUrl, "https://platform-backend.topview.ai/v1/chat/completions");
    assert.equal(new Headers(requestOptions.headers).get("authorization"), "Bearer test-topview-key");
    assert.equal(new Headers(requestOptions.headers).get("idempotency-key"), "storyboard-request-0001");
    const sentBody = JSON.parse(requestOptions.body);
    assert.equal(sentBody.model, "gpt-5.5");
    assert.equal(sentBody.max_completion_tokens, 8192);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TOPVIEW_API_KEY;
    else process.env.TOPVIEW_API_KEY = originalKey;
  }
});

test("Topview Claude selection uses Messages API and rejects a missing idempotency key", async () => {
  const originalKey = process.env.TOPVIEW_API_KEY;
  const originalFetch = global.fetch;
  process.env.TOPVIEW_API_KEY = "test-topview-key";
  let requestUrl = "";
  let requestOptions;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return new Response(JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(storyboard) }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const missingKeyResponse = await post({ script: "A seed opens.", provider: "topview-claude" });
    assert.equal(missingKeyResponse.status, 400);
    const response = await post(
      { script: "A seed opens.", provider: "topview-claude" },
      { "Idempotency-Key": "storyboard-request-0002" },
    );
    assert.equal(response.status, 200);
    assert.equal(requestUrl, "https://platform-backend.topview.ai/v1/messages");
    assert.equal(new Headers(requestOptions.headers).get("authorization"), "Bearer test-topview-key");
    const sentBody = JSON.parse(requestOptions.body);
    assert.equal(sentBody.model, "claude-sonnet-5-5");
    assert.equal(sentBody.messages.length, 1);
    assert.equal(sentBody.max_tokens, 8192);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TOPVIEW_API_KEY;
    else process.env.TOPVIEW_API_KEY = originalKey;
  }
});

test("Topview reconciliation errors preserve the provider request ID", async () => {
  const originalKey = process.env.TOPVIEW_API_KEY;
  const originalFetch = global.fetch;
  process.env.TOPVIEW_API_KEY = "test-topview-key";
  global.fetch = async () => new Response(JSON.stringify({
    error: { message: "Text request outcome needs reconciliation; do not submit it again with a new idempotency key." },
  }), {
    status: 409,
    headers: {
      "Content-Type": "application/json",
      "X-Platform-Request-Id": "topview-request-123",
    },
  });

  try {
    const response = await post(
      { script: "A seed opens.", provider: "topview-gpt" },
      { "Idempotency-Key": "storyboard-request-0003" },
    );
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.match(result.error, /do not submit it again with a new idempotency key/);
    assert.equal(result.requestId, "topview-request-123");
    assert.equal(response.headers.get("X-Platform-Request-Id"), "topview-request-123");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TOPVIEW_API_KEY;
    else process.env.TOPVIEW_API_KEY = originalKey;
  }
});
