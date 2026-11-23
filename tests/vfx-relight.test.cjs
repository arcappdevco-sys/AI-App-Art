/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
const {
  createVfxRelightWorkflow,
  normalizeVfxFrameTime,
  VFX_EXTRACT_FRAME_NODE_TYPE,
  VFX_LIGHTING_REFERENCE_NODE_TYPE,
  VFX_VIDEO_REFINE_NODE_TYPE,
} = require(path.join(__dirname, "..", "src", "lib", "vfx-relight.ts"));
const { runGraph } = require(path.join(__dirname, "..", "src", "lib", "executor.ts"));
const { registry } = require(path.join(__dirname, "..", "src", "lib", "registry.ts"));
const {
  createWorkflowNodes,
  getFirstLastFrameModelOptions,
  getImageToVideoModelOptions,
} = require(path.join(__dirname, "..", "src", "lib", "workflow-node-factory.ts"));

function definition(type, inputs, outputs, params = []) {
  return { type, label: type, category: "Input", inputs, outputs, params, execute: async () => ({}) };
}

test("normalizes frame times and reports invalid or negative values", () => {
  assert.equal(normalizeVfxFrameTime(3.14159), 3.142);
  assert.equal(normalizeVfxFrameTime("2.5"), 2.5);
  assert.throws(() => normalizeVfxFrameTime(-1), /between 0 and 3600 seconds/);
  assert.throws(() => normalizeVfxFrameTime("not a time"), /between 0 and 3600 seconds/);
});

test("builds a typed, connected VFX relighting workflow without storing credentials", () => {
  const definitions = {
    "input/video": definition("input/video", {}, { video: "video" }, [{ key: "url", default: "" }]),
    "input/prompt": definition("input/prompt", {}, { text: "text" }, [{ key: "text", default: "" }]),
    "output/preview": definition("output/preview", { media: "any" }, {}),
    [VFX_EXTRACT_FRAME_NODE_TYPE]: definition(
      VFX_EXTRACT_FRAME_NODE_TYPE, { video: "video" }, { image: "image" }, [{ key: "time_seconds", default: 0 }],
    ),
    [VFX_LIGHTING_REFERENCE_NODE_TYPE]: definition(
      VFX_LIGHTING_REFERENCE_NODE_TYPE,
      { prompt: "text", image: "image" },
      { image: "image" },
      [
        { key: "provider", default: "atlas" },
        { key: "model", default: "flux-3-image-edit" },
      ],
    ),
    [VFX_VIDEO_REFINE_NODE_TYPE]: definition(
      VFX_VIDEO_REFINE_NODE_TYPE,
      { prompt: "text", video: "video", reference_image: "image" },
      { video: "video" },
      [{ key: "model", default: "omni-video-edit" }],
    ),
  };
  const { nodes, edges } = createVfxRelightWorkflow(definitions, { x: 10, y: 20 });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nodeTypes = nodes.map((node) => node.data.type);

  assert.deepEqual(nodeTypes, [
    "input/video",
    VFX_EXTRACT_FRAME_NODE_TYPE,
    VFX_LIGHTING_REFERENCE_NODE_TYPE,
    "input/prompt",
    VFX_VIDEO_REFINE_NODE_TYPE,
    "output/preview",
  ]);
  for (const edge of edges) {
    const source = definitions[byId.get(edge.source).data.type];
    const target = definitions[byId.get(edge.target).data.type];
    const sourceType = source.outputs[edge.sourceHandle];
    const targetType = target.inputs[edge.targetHandle];
    assert.ok(sourceType && targetType);
    assert.ok(sourceType === targetType || targetType === "any");
  }
  assert.equal(nodes.some((node) => Object.keys(node.data.params).some((key) => /api.?key|token|secret/i.test(key))), false);
});

test("manual VFX edit nodes receive a prompt and video preview without entering generation templates", () => {
  const graph = createWorkflowNodes(VFX_VIDEO_REFINE_NODE_TYPE, registry, { x: 10, y: 20 });
  assert.deepEqual(graph.nodes.map((node) => node.data.type), [
    "input/prompt",
    VFX_VIDEO_REFINE_NODE_TYPE,
    "output/preview",
  ]);
  assert.deepEqual(graph.edges.map(({ sourceHandle, targetHandle }) => ({ sourceHandle, targetHandle })), [
    { sourceHandle: "text", targetHandle: "prompt" },
    { sourceHandle: "video", targetHandle: "media" },
  ]);
  assert.equal(getImageToVideoModelOptions(registry).some((option) => option.type === VFX_VIDEO_REFINE_NODE_TYPE), false);
  assert.equal(getFirstLastFrameModelOptions(registry).some((option) => option.type === VFX_VIDEO_REFINE_NODE_TYPE), false);
});

test("Google Gemini image-edit choices receive the extracted frame and prompt", async () => {
  const lightingReference = registry[VFX_LIGHTING_REFERENCE_NODE_TYPE];
  const providerParam = lightingReference.params.find((param) => param.key === "provider");
  const modelParam = lightingReference.params.find((param) => param.key === "model");
  assert.deepEqual(providerParam.options, ["atlas", "fal", "google"]);
  assert.deepEqual(modelParam.optionsByParam.values.google, ["Nano Banana", "Nano Banana 2"]);

  const originalFetch = global.fetch;
  let submittedUrl;
  let submittedBody;
  global.fetch = async (url, options = {}) => {
    submittedUrl = url;
    submittedBody = JSON.parse(options.body);
    return Response.json({ image: "data:image/png;base64,ZWQ=" });
  };
  try {
    const result = await lightingReference.execute({
      inputs: {
        prompt: "Add a warm key light from camera-left.",
        image: "data:image/png;base64,Zm9v",
      },
      params: { provider: "google", model: "Nano Banana 2" },
      log: () => {},
      signal: new AbortController().signal,
    });
    assert.equal(submittedUrl, "/api/gemini");
    assert.deepEqual(submittedBody, {
      model: "gemini-3.1-flash-image-preview",
      prompt: "Add a warm key light from camera-left.",
      images: ["data:image/png;base64,Zm9v"],
      aspectRatio: "auto",
    });
    assert.equal(result.image, "data:image/png;base64,ZWQ=");
  } finally {
    global.fetch = originalFetch;
  }
});

test("passes uploaded source duration to the VFX edit preflight", async () => {
  const originalExecute = registry[VFX_VIDEO_REFINE_NODE_TYPE].execute;
  let receivedInputs;
  registry[VFX_VIDEO_REFINE_NODE_TYPE].execute = async ({ inputs }) => {
    receivedInputs = inputs;
    return { video: "https://example.com/refined.mp4" };
  };
  try {
    await runGraph({
      nodes: [
        { id: "video", type: "input/video", params: { url: "https://example.com/source.mp4", duration_seconds: 12 } },
        { id: "refine", type: VFX_VIDEO_REFINE_NODE_TYPE, params: {} },
      ],
      edges: [{
        source: "video",
        sourceHandle: "video",
        target: "refine",
        targetHandle: "video",
      }],
    }, {
      cache: new Map(),
      fresh: true,
      targetIds: ["refine"],
      onStatus: () => {},
      onOutput: () => {},
    });
    assert.equal(receivedInputs.video, "https://example.com/source.mp4");
    assert.equal(receivedInputs.source_duration_seconds, 12);
  } finally {
    registry[VFX_VIDEO_REFINE_NODE_TYPE].execute = originalExecute;
  }
});
