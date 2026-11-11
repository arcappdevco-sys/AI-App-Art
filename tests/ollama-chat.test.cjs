/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { GET, POST } = require("../src/app/api/ollama-chat/route.ts");

const request = (body) => new Request("http://localhost/api/ollama-chat", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const tags = { models: [
  { name: "local:latest" },
  { name: "remote:cloud", remote_model: "remote" },
  { name: "other:latest", remote_host: "https://example.invalid" },
] };

test("lists only local models and sends bounded conversations to Ollama", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/api/tags") ? Response.json(tags)
      : Response.json({ message: { role: "assistant", content: " Hello! " } });
  };
  try {
    const list = await GET(new Request("http://localhost/api/ollama-chat"));
    assert.deepEqual(await list.json(), { models: ["local:latest"] });
    const messages = [{ role: "user", content: "Hello" }];
    const response = await POST(request({ model: "local:latest", messages }));
    assert.deepEqual(await response.json(), { content: "Hello!" });
    assert.equal(calls[2].url, "http://127.0.0.1:11434/api/chat");
    assert.deepEqual(JSON.parse(calls[2].options.body), { model: "local:latest", messages, stream: false });
    const remote = await POST(request({ model: "remote:cloud", messages }));
    assert.equal(remote.status, 400);
    assert.equal(calls.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects malformed, oversized and non-user-ending conversations without calling Ollama", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("Unexpected request"); };
  try {
    for (const messages of [[], [{ role: "system", content: "bad" }], [{ role: "assistant", content: "bad" }],
      [{ role: "user", content: "x".repeat(6001) }], Array(22).fill({ role: "user", content: "hi" }),
      Array(6).fill({ role: "user", content: "x".repeat(6000) })]) {
      assert.equal((await POST(request({ model: "local:latest", messages }))).status, 400);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("reports an unavailable Ollama server", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  global.fetch = async () => { throw new Error("Connection refused"); };
  console.error = () => {};
  try {
    const response = await GET(new Request("http://localhost/api/ollama-chat"));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Ollama.*running/);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});

test("surfaces Ollama errors and rejects empty responses", async () => {
  const originalFetch = global.fetch;
  let result = Response.json({ error: "Model cannot be loaded" }, { status: 500 });
  global.fetch = async (url) => url.endsWith("/api/tags") ? Response.json(tags) : result;
  try {
    const body = { model: "local:latest", messages: [{ role: "user", content: "Hi" }] };
    const failure = await POST(request(body));
    assert.equal(failure.status, 502);
    assert.deepEqual(await failure.json(), { error: "Model cannot be loaded" });
    result = Response.json({ message: { content: "" } });
    const empty = await POST(request(body));
    assert.equal(empty.status, 502);
    assert.match((await empty.json()).error, /empty/);
  } finally {
    global.fetch = originalFetch;
  }
});
