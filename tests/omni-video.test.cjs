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
const { OMNI_DEFAULTS, OMNI_MODELS, OMNI_TASKS, normalizeOmniParams, buildOmniRequest } =
  require(path.join(root, "lib", "omni.ts"));
const { POST } = require(path.join(root, "app", "api", "atlas", "google-video", "route.ts"));
const { runGraph } = require(path.join(root, "lib", "executor.ts"));
const { validateWorkflow } = require(path.join(root, "lib", "workflow-validation.ts"));
const image = "https://example.com/image.png";
const video = "https://example.com/video.mp4";
const models = [OMNI_MODELS["Gemini Omni 1.1 Flash"], OMNI_MODELS["Gemini Omni 1.2 Flash"]];
const inputs = {
  "text-to-video": { prompt: "A scene" },
  "image-to-video": { prompt: "A scene", image, last_image: image },
  "reference-to-video": { prompt: "A scene", reference_images: [image], reference_video_1: video },
  "video-edit": { prompt: "A scene", video, reference_images: [image] },
  "video-extend": { prompt: "A scene", video, reference_images: [image] },
};

test("each modern Omni task builds and forwards its documented request", async () => {
  const previousKey = process.env.ATLASCLOUD_API_KEY;
  const previousFetch = global.fetch;
  let submitted;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  global.fetch = async (_url, options) => {
    submitted = JSON.parse(options.body);
    return Response.json({ data: { id: "mock-prediction" } });
  };
  try {
    for (const model of models) {
      assert.equal(normalizeOmniParams({ model }).model, model);
      for (const task of Object.values(OMNI_TASKS)) {
        const request = buildOmniRequest({ params: { ...OMNI_DEFAULTS, model, task } }, inputs[task]);
        const { variations, ...body } = request.body;
        const response = await POST(new Request("http://localhost/api/atlas/google-video", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: request.model, ...body }),
        }));
        assert.equal(response.status, 200, `${model}/${task}: ${JSON.stringify(await response.clone().json())}`);
        assert.equal((await response.json()).predictionId, "mock-prediction");
        assert.deepEqual(submitted, { model: `${model}/${task}`, ...body });
        assert.equal(variations, 1);
        if (task === "video-edit") {
          assert.equal("duration" in submitted, false);
          assert.equal("resolution" in submitted, false);
        }
      }
    }
  } finally {
    if (previousKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = previousKey;
    global.fetch = previousFetch;
  }
});

test("model and task duration limits reject unsupported combinations", () => {
  const build = (model, task, duration, input = inputs[task]) =>
    buildOmniRequest({ params: { ...OMNI_DEFAULTS, model, task, duration: String(duration) } }, input);
  assert.equal(build(models[1], "text-to-video", 15).body.duration, 15);
  assert.throws(() => build(models[0], "text-to-video", 11), /3 to 10/);
  assert.throws(() => build(models[1], "video-extend", 11), /3 to 10/);
  assert.throws(() => build(models[1], "image-to-video", 11), /last frame/);
  assert.throws(() => build(models[1], "reference-to-video", 11, {
    prompt: "A scene", reference_video_1: video, reference_video_2: video,
  }), /at most one/);
  assert.equal(build(models[1], "reference-to-video", 15, {
    prompt: "A scene", reference_video_1: video,
  }).body.duration, 15);
  assert.throws(() => build(OMNI_MODELS["Gemini Omni Flash (original)"], "video-extend", 10), /does not support/);
  assert.equal(normalizeOmniParams({ model: models[1], duration: "15" }).duration, "15");
});

test("server rejects invalid 1.2 constraints without contacting Atlas", async () => {
  const previousKey = process.env.ATLASCLOUD_API_KEY;
  const previousFetch = global.fetch;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  global.fetch = async () => { throw new Error("Unexpected Atlas request"); };
  try {
    for (const payload of [
      { model: `${models[1]}/image-to-video`, prompt: "A scene", image, last_image: image, duration: 11 },
      { model: `${models[1]}/reference-to-video`, prompt: "A scene", reference_videos: [video, video], duration: 11 },
      { model: `${models[1]}/video-extend`, prompt: "A scene", video, duration: 11 },
      { model: `${models[1]}/reference-to-video`, prompt: "A scene" },
    ]) {
      const response = await POST(new Request("http://localhost/api/atlas/google-video", {
        method: "POST", body: JSON.stringify(payload),
      }));
      assert.equal(response.status, 400, JSON.stringify(payload));
    }
  } finally {
    if (previousKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = previousKey;
    global.fetch = previousFetch;
  }
});

test("workflow generates a fresh Omni clip and passes it to Preview with an empty optional last frame", async () => {
  const previousFetch = global.fetch;
  const previousWindow = global.window;
  let submissions = 0;
  global.window = { setTimeout: (callback) => setTimeout(callback, 0), clearTimeout };
  global.fetch = async (_url, options = {}) => {
    if (options.method === "POST") {
      submissions++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, `${models[1]}/image-to-video`);
      assert.equal(body.image, image);
      assert.equal("last_image" in body, false);
      return Response.json({ predictionId: `mock-${submissions}` });
    }
    return Response.json({ data: { status: "completed", outputs: [`https://example.com/output-${submissions}`] } });
  };
  try {
    const graph = {
      nodes: [
        { id: "prompt", type: "input/prompt", params: { text: "A scene" } },
        { id: "first", type: "input/image", params: { url: image } },
        { id: "last", type: "input/image", params: { url: "" } },
        { id: "omni", type: "video/google-omni", params: { ...OMNI_DEFAULTS, model: models[1], task: "image-to-video" } },
        { id: "preview", type: "output/preview", params: {} },
      ],
      edges: [
        { source: "prompt", sourceHandle: "text", target: "omni", targetHandle: "prompt" },
        { source: "first", sourceHandle: "image", target: "omni", targetHandle: "image" },
        { source: "last", sourceHandle: "image", target: "omni", targetHandle: "last_image" },
        { source: "omni", sourceHandle: "video", target: "preview", targetHandle: "media" },
      ],
    };
    assert.equal(validateWorkflow(graph).filter((issue) => issue.severity === "error").length, 0);
    const outputs = {}, statuses = {};
    const options = {
      cache: new Map(), fresh: true,
      onStatus: (id, status, message) => { statuses[id] = [status, message]; },
      onOutput: (id, value) => { outputs[id] = value; },
    };
    await runGraph(graph, options);
    assert.equal(statuses.omni[0], "done");
    assert.equal(statuses.preview[0], "done");
    assert.equal(outputs.preview.media, "https://example.com/output-1");
    await runGraph(graph, options);
    assert.equal(outputs.preview.media, "https://example.com/output-2");
    assert.equal(submissions, 2);
    assert.ok(validateWorkflow(graph, ["last"]).some((issue) => issue.severity === "error"));
    const refGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === "omni"
        ? { ...node, params: { ...node.params, task: "reference-to-video" } }
        : node),
      edges: graph.edges.map((edge) => edge.targetHandle === "image" || edge.targetHandle === "last_image"
        ? { ...edge, targetHandle: "reference_images" }
        : edge),
    };
    assert.equal(validateWorkflow(refGraph).filter((issue) => issue.severity === "error").length, 0);
    const noReferences = {
      ...refGraph,
      nodes: refGraph.nodes.map((node) => node.id === "first" ? { ...node, params: { url: "" } } : node),
    };
    assert.ok(validateWorkflow(noReferences).some((issue) => /at least one reference/.test(issue.message)));
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});
