const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const root = path.join(__dirname, "..", "src");
const { buildKlingRequest, normalizeKlingParams, KLING_DEFAULTS, KLING_MODELS, KLING_TASKS } =
  require(path.join(root, "lib", "kling.ts"));
const { POST } = require(path.join(root, "app", "api", "atlas", "kling", "route.ts"));
const { runGraph } = require(path.join(root, "lib", "executor.ts"));
const { validateWorkflow } = require(path.join(root, "lib", "workflow-validation.ts"));
const model = KLING_MODELS["Kling 2.6 Pro Motion Control"];
const params = { ...KLING_DEFAULTS, model, task: KLING_TASKS["Motion control"] };
const image = "https://example.com/image.jpg";
const video = "https://example.com/uploaded-video";

test("motion control builds exact Atlas payload and preserves saved settings", () => {
  const normalized = normalizeKlingParams({ ...params, character_orientation: "video", keep_original_audio: false });
  assert.equal(normalized.model, model);
  assert.equal(normalized.task, "motion-control");
  assert.equal(normalized.keep_original_audio, false);
  const request = buildKlingRequest({ params: normalized }, { image, video, motion_duration_seconds: 30 });
  assert.deepEqual(request.body, {
    model: `${model}/motion-control`, image, video, character_orientation: "video", keep_original_audio: false,
  });
  assert.throws(() => buildKlingRequest({ params }, { image, video, motion_duration_seconds: 10.1 }), /3 to 10/);
  assert.throws(() => buildKlingRequest({ params }, { image, video, motion_duration_seconds: 2 }), /3 to 10/);
  assert.throws(() => buildKlingRequest({ params }, { image }), /motion reference video/);
  assert.throws(() => buildKlingRequest({ params }, { image, video, prompt: "x".repeat(2501) }), /2,500/);
  assert.throws(() => buildKlingRequest({ params: { ...params, model: KLING_MODELS["Kling 4.0"] } }, { image, video }), /requires Kling/);
});

test("motion route submits only supported fields and rejects missing inputs", async () => {
  const oldKey = process.env.ATLASCLOUD_API_KEY;
  const oldFetch = global.fetch;
  let submitted;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    submitted = JSON.parse(options.body);
    return Response.json({ data: { id: "mock-id" } });
  };
  try {
    const body = buildKlingRequest({ params }, { image, video }).body;
    const post = (value) => POST(new Request("http://localhost/api/atlas/kling", {
      method: "POST", body: JSON.stringify(value),
    }));
    assert.equal((await post(body)).status, 200);
    assert.deepEqual(submitted, body);
    assert.equal((await post({ ...body, video: "" })).status, 400);
    assert.equal((await post({ ...body, character_orientation: "invalid" })).status, 400);
    assert.equal((await post({ ...body, prompt: "x".repeat(2501) })).status, 400);
  } finally {
    if (oldKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = oldKey;
    global.fetch = oldFetch;
  }
});

test("motion workflow permits an empty prompt and forwards completed video to Preview", async () => {
  const graph = {
    nodes: [
      { id: "prompt", type: "input/prompt", params: { text: "" } },
      { id: "image", type: "input/image", params: { url: image } },
      { id: "video", type: "input/video", params: { url: video, duration_seconds: 8 } },
      { id: "kling", type: "video/kling", params },
      { id: "preview", type: "output/preview", params: {} },
    ],
    edges: [
      { source: "prompt", sourceHandle: "text", target: "kling", targetHandle: "prompt" },
      { source: "image", sourceHandle: "image", target: "kling", targetHandle: "image" },
      { source: "video", sourceHandle: "video", target: "kling", targetHandle: "video" },
      { source: "kling", sourceHandle: "video", target: "preview", targetHandle: "media" },
    ],
  };
  assert.equal(validateWorkflow(graph).filter((issue) => issue.severity === "error").length, 0);
  const oldFetch = global.fetch, oldWindow = global.window;
  let submits = 0;
  global.window = { setTimeout: (callback) => setTimeout(callback, 0), clearTimeout };
  global.fetch = async (_url, options = {}) => {
    if (options.method === "POST") {
      submits++;
      assert.equal(JSON.parse(options.body).video, video);
      return Response.json({ predictionId: "mock-id" });
    }
    return Response.json({ data: { status: "completed", outputs: ["https://example.com/result.mp4"] } });
  };
  try {
    const outputs = {}, statuses = {};
    await runGraph(graph, {
      cache: new Map(), fresh: true,
      onStatus: (id, status, message) => { statuses[id] = [status, message]; },
      onOutput: (id, output) => { outputs[id] = output; },
    });
    assert.deepEqual(statuses.kling, ["done", ""]);
    assert.equal(outputs.preview.media, "https://example.com/result.mp4");
    assert.equal(submits, 1);
  } finally {
    global.fetch = oldFetch;
    if (oldWindow === undefined) delete global.window;
    else global.window = oldWindow;
  }
});
