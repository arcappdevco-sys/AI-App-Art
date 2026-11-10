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
const { createWorkflowNodes, videoModelTypes } = lib("workflow-node-factory");

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
