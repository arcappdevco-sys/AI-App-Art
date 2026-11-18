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
  buildStoryboardVideoPrompt,
  collectStoryboardVideoCandidates,
  rebindStoryboardWorkflowReferences,
  resolveStoryboardFrameReference,
  resolveWorkflowStoryboardFrames,
} = require(path.join(__dirname, "..", "src", "lib", "storyboard-workflow.ts"));
const { normalizeStoryboard } = require(path.join(__dirname, "..", "src", "lib", "StoryboardData.ts"));

const workflows = [{
  id: "workflow-1",
  storyboard: {
    version: 1,
    title: "Test",
    aspectRatio: "16:9",
    scenes: [{
      id: "scene-1",
      title: "Scene 1",
      collapsed: false,
      shots: [{ id: "shot-1", frame: "data:image/png;base64,ZmFrZQ==" }],
    }],
  },
}];

test("resolves storyboard frames by workflow, scene, and shot IDs", () => {
  assert.equal(resolveStoryboardFrameReference({
    kind: "storyboard-frame",
    workflowId: "workflow-1",
    sceneId: "scene-1",
    shotId: "shot-1",
  }, workflows), "data:image/png;base64,ZmFrZQ==");
});

test("reports invalid or stale storyboard frame references", () => {
  assert.throws(() => resolveStoryboardFrameReference(null, workflows), /reference is invalid/);
  assert.throws(() => resolveStoryboardFrameReference({
    kind: "storyboard-frame",
    workflowId: "missing",
    sceneId: "scene-1",
    shotId: "shot-1",
  }, workflows), /workflow containing this storyboard frame is unavailable/);
  assert.throws(() => resolveStoryboardFrameReference({
    kind: "storyboard-frame",
    workflowId: "workflow-1",
    sceneId: "scene-1",
    shotId: "missing",
  }, workflows), /referenced storyboard frame is unavailable/);
});

test("resolves guide references only in the run graph without mutating saved nodes", () => {
  const nodes = [{
    id: "image-input",
    type: "input/image",
    params: {
      url: "",
      storyboardFrameRef: {
        kind: "storyboard-frame",
        workflowId: "workflow-1",
        sceneId: "scene-1",
        shotId: "shot-1",
      },
    },
  }];
  const runNodes = resolveWorkflowStoryboardFrames(nodes, workflows);
  assert.equal(runNodes[0].params.url, "data:image/png;base64,ZmFrZQ==");
  assert.equal("storyboardFrameRef" in runNodes[0].params, false);
  assert.equal(nodes[0].params.url, "");
  assert.equal("storyboardFrameRef" in nodes[0].params, true);
});

test("manual image URLs override a stale storyboard reference", () => {
  const runNodes = resolveWorkflowStoryboardFrames([{
    id: "image-input",
    type: "input/image",
    params: {
      url: "https://example.test/guide.png",
      storyboardFrameRef: null,
    },
  }], workflows);
  assert.equal(runNodes[0].params.url, "https://example.test/guide.png");
  assert.equal("storyboardFrameRef" in runNodes[0].params, false);
});

test("rebinds self-references when an exported workflow is imported as a copy", () => {
  const nodes = [{
    id: "image-input",
    type: "input/image",
    params: {
      url: "",
      storyboardFrameRef: {
        kind: "storyboard-frame",
        workflowId: "workflow-1",
        sceneId: "scene-1",
        shotId: "shot-1",
      },
    },
  }];
  const rebound = rebindStoryboardWorkflowReferences(nodes, "workflow-1", "workflow-copy");
  assert.equal(rebound[0].params.storyboardFrameRef.workflowId, "workflow-copy");
  assert.equal(nodes[0].params.storyboardFrameRef.workflowId, "workflow-1");
});

test("builds an editable prompt from one storyboard shot and its visual direction", () => {
  const prompt = buildStoryboardVideoPrompt(
    { title: "Scene 1" },
    {
      title: "Robot reveal",
      description: "A robot turns toward the camera.",
      shotType: "Close-up",
      cameraMove: "Orbit",
      durationSeconds: 6,
    },
  );
  assert.match(prompt, /Animate the provided storyboard frame/);
  assert.match(prompt, /Description: A robot turns toward the camera\./);
  assert.match(prompt, /Shot type: Close-up/);
  assert.match(prompt, /Camera movement: Orbit/);
  assert.match(prompt, /Shot storyboard duration: 6 seconds/);
});

test("combines first and last shot details for a continuous video prompt", () => {
  const prompt = buildStoryboardVideoPrompt(
    { title: "Scene 1" },
    {
      title: "Robot reveal",
      description: "A robot turns toward the camera.",
      shotType: "Close-up",
      cameraMove: "Orbit",
      durationSeconds: 6,
    },
    {
      scene: { title: "Scene 2" },
      shot: {
        title: "Ocean",
        description: "A dolphin leaps out of the water.",
        shotType: "Wide",
        cameraMove: "Tracking",
        durationSeconds: 4,
      },
    },
  );
  assert.match(prompt, /one continuous video/);
  assert.match(prompt, /First frame:\nScene: Scene 1/);
  assert.match(prompt, /Last frame:\nScene: Scene 2/);
  assert.match(prompt, /First shot storyboard duration: 6 seconds/);
  assert.match(prompt, /Last shot storyboard duration: 4 seconds/);
});

test("collects generated videos connected to storyboard frames with model and prompt provenance", () => {
  const nodes = [
    {
      id: "first-frame",
      data: {
        type: "input/image",
        params: {
          storyboardFrameRef: {
            kind: "storyboard-frame",
            workflowId: "workflow-1",
            sceneId: "scene-1",
            shotId: "shot-1",
          },
        },
      },
    },
    {
      id: "last-frame",
      data: {
        type: "input/image",
        params: {
          storyboardFrameRef: {
            kind: "storyboard-frame",
            workflowId: "workflow-1",
            sceneId: "scene-1",
            shotId: "shot-2",
          },
        },
      },
    },
    { id: "prompt", data: { type: "input/prompt", params: { text: "A careful camera move." } } },
    {
      id: "video",
      data: {
        type: "video/test",
        params: { model: "model-a", prompt: "fallback prompt" },
        outputs: { video: "https://media.example/video.mp4" },
      },
    },
    {
      id: "unrelated-video",
      data: {
        type: "video/test",
        params: { model: "model-a" },
        outputs: { video: "https://media.example/unrelated.mp4" },
      },
    },
  ];
  const edges = [
    { source: "first-frame", target: "video", targetHandle: "image" },
    { source: "last-frame", target: "video", targetHandle: "last_image" },
    { source: "prompt", target: "video", targetHandle: "prompt" },
  ];
  const definitions = {
    "video/test": {
      type: "video/test",
      label: "Test Video",
      category: "Video",
      inputs: {},
      outputs: { video: "video" },
      params: [{ key: "model", optionLabels: { "model-a": "Model A" } }],
      execute: async () => ({}),
    },
  };
  const candidates = collectStoryboardVideoCandidates("workflow-1", nodes, edges, definitions);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].model, "Model A");
  assert.equal(candidates[0].prompt, "A careful camera move.");
  assert.deepEqual(candidates[0].sourceShotRefs.map((reference) => reference.shotId), ["shot-1", "shot-2"]);
  assert.equal(candidates[0].videoUrl, "https://media.example/video.mp4");
});

test("normalizes generated takes and ignores malformed or non-HTTP video sources", () => {
  const take = {
    id: "take-1",
    sourceId: "workflow-1:video:video",
    workflowId: "workflow-1",
    nodeId: "video",
    outputPort: "video",
    videoType: "video/test",
    videoUrl: "https://media.example/take.mp4",
    mediaAssetId: "storyboard-take:take-1",
    model: "Test Video",
    prompt: "A careful camera move.",
    createdAt: 1_700_000_000_000,
  };
  const storyboard = normalizeStoryboard({
    version: 1,
    title: "Test",
    aspectRatio: "16:9",
    scenes: [{
      id: "scene-1",
      title: "Scene 1",
      shots: [{
        id: "shot-1",
        generatedTakes: [take, { ...take, id: "bad", videoUrl: "file:///video.mp4" }],
      }],
    }],
  });
  assert.deepEqual(storyboard.scenes[0].shots[0].generatedTakes, [take]);
});
