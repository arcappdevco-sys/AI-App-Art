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
const { rebindStoryboardWorkflowReferences, resolveStoryboardFrameReference, resolveWorkflowStoryboardFrames } =
  require(path.join(__dirname, "..", "src", "lib", "storyboard-workflow.ts"));

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
