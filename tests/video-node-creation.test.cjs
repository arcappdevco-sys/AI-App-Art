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
const lib = (name) => require(path.join(__dirname, "..", "src", "lib", `${name}.ts`));
const { registry } = lib("registry");
const {
  createFirstLastFrameWorkflowNodes,
  createImageToVideoWorkflowNodes,
  createWorkflowNodes,
  getFirstLastFrameModelOptions,
  getImageToVideoModelOptions,
  getStoryboardVideoParamOverrides,
  videoModelTypes,
} = lib("workflow-node-factory");

test("every video model creates connected prompt and preview nodes", () => {
  assert.equal(videoModelTypes.length, 7);
  for (const type of videoModelTypes) {
    const result = createWorkflowNodes(type, registry, { x: 100, y: 200 });
    const [prompt, model, preview] = result.nodes;
    assert.deepEqual(result.nodes.map((node) => node.data.type), ["input/prompt", type, "output/preview"]);
    assert.deepEqual(result.nodes.map((node) => node.position), [
      { x: 100, y: 200 }, { x: 460, y: 200 }, { x: 820, y: 200 },
    ]);
    assert.deepEqual(result.edges.map(({ source, sourceHandle, target, targetHandle }) => ({
      source, sourceHandle, target, targetHandle,
    })), [
      { source: prompt.id, sourceHandle: "text", target: model.id, targetHandle: "prompt" },
      { source: model.id, sourceHandle: "video", target: preview.id, targetHandle: "media" },
    ]);
    assert.equal(registry[type].inputs.prompt, "text");
    assert.equal(registry[type].outputs.video, "video");
  }
});

test("non-video node creation retains its prior behavior", () => {
  const image = createWorkflowNodes("image/flux-3", registry, { x: 0, y: 0 });
  assert.deepEqual(image.nodes.map((node) => node.data.type), ["input/prompt", "image/flux-3"]);
  assert.equal(image.edges.length, 1);
  const preview = createWorkflowNodes("output/preview", registry, { x: 0, y: 0 });
  assert.equal(preview.nodes.length, 1);
  assert.equal(preview.edges.length, 0);
});

test("every video model can create a connected image-to-video workflow", () => {
  const options = getImageToVideoModelOptions(registry);
  assert.deepEqual(options.map((option) => option.type), videoModelTypes);

  const expectedImageHandles = {
    "video/wan-3.0": "image",
    "video/minimax-h3": "image",
    "video/flux-3": "image",
    "video/seedance": "image",
    "video/kling": "image",
    "video/veo": "first_frame",
    "video/google-omni": "image",
  };
  for (const option of options) {
    assert.equal(option.task, "image-to-video");
    assert.equal(option.imageHandle, expectedImageHandles[option.type]);
    const result = createImageToVideoWorkflowNodes(option.type, registry, { x: 100, y: 200 });
    const model = result.nodes.find((node) => node.data.type === option.type);
    assert.equal(model.data.params.task, "image-to-video");
    if (option.type === "video/flux-3") {
      assert.equal(model.data.params.model, "black-forest-labs/flux-3/image-to-video");
    }
    assert.deepEqual(result.nodes.map((node) => node.data.type), [
      "input/prompt", option.type, "output/preview",
    ]);
    assert.deepEqual(result.edges.map(({ sourceHandle, targetHandle }) => ({ sourceHandle, targetHandle })), [
      { sourceHandle: "text", targetHandle: "prompt" },
      { sourceHandle: "video", targetHandle: "media" },
    ]);
  }
});

test("every video model can create a connected first-and-last-frame workflow", () => {
  const options = getFirstLastFrameModelOptions(registry);
  assert.deepEqual(options.map((option) => option.type), videoModelTypes);

  const expectedFrameHandles = {
    "video/wan-3.0": ["image", "last_image"],
    "video/minimax-h3": ["image", "end_image"],
    "video/flux-3": ["start_image", "end_image"],
    "video/seedance": ["image", "last_image"],
    "video/kling": ["image", "last_image"],
    "video/veo": ["first_frame", "last_frame"],
    "video/google-omni": ["image", "last_image"],
  };
  for (const option of options) {
    assert.deepEqual([option.firstFrameHandle, option.lastFrameHandle], expectedFrameHandles[option.type]);
    const result = createFirstLastFrameWorkflowNodes(option.type, registry, { x: 100, y: 200 });
    const model = result.nodes.find((node) => node.data.type === option.type);
    assert.equal(model.data.params.task, option.type === "video/flux-3"
      ? "first-last-frame-to-video"
      : "image-to-video");
    assert.deepEqual(result.nodes.map((node) => node.data.type), [
      "input/prompt", option.type, "output/preview",
    ]);
  }
  assert.equal(
    createFirstLastFrameWorkflowNodes("video/veo", registry, { x: 0, y: 0 })
      .nodes.find((node) => node.data.type === "video/veo").data.params.model,
    "google/veo3.1-lite",
  );
  assert.equal(
    createFirstLastFrameWorkflowNodes("video/google-omni", registry, { x: 0, y: 0 })
      .nodes.find((node) => node.data.type === "video/google-omni").data.params.model,
    "google/gemini-omni-1.2-flash",
  );
});

test("storyboard duration and aspect ratio map to supported video-model settings", () => {
  const options = getFirstLastFrameModelOptions(registry);
  const settings = { aspectRatio: "4:3", durationSeconds: 7, hasLastFrame: true };
  const expectedDurations = {
    "video/wan-3.0": 7,
    "video/minimax-h3": 7,
    "video/flux-3": 7,
    "video/seedance": "7",
    "video/kling": "7",
    "video/veo": "6",
    "video/google-omni": "7",
  };
  for (const option of options) {
    const overrides = getStoryboardVideoParamOverrides(option.type, registry, option.params, settings);
    assert.equal(overrides.duration, expectedDurations[option.type]);
    if (["video/flux-3", "video/veo", "video/google-omni"].includes(option.type)) {
      assert.equal(overrides.aspect_ratio, option.type === "video/flux-3" ? "4:3" : "16:9");
    } else {
      assert.equal("aspect_ratio" in overrides, false);
    }
  }

  const omni = options.find((option) => option.type === "video/google-omni");
  assert.equal(getStoryboardVideoParamOverrides(
    "video/google-omni",
    registry,
    omni.params,
    { ...settings, durationSeconds: 12 },
  ).duration, "10");
});
