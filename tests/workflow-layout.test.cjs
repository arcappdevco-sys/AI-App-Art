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
const { autoLayoutWorkflow } =
  require(path.join(__dirname, "..", "src", "lib", "workflow-layout.ts"));
const { nodesInsideGroup } =
  require(path.join(__dirname, "..", "src", "lib", "canvas-groups.ts"));

function node(id, type, x, y, width = 160, height = 100) {
  return {
    id, type: "workflow", position: { x, y }, measured: { width, height },
    data: { type, params: {} },
  };
}

function edge(source, target) {
  return { id: `${source}-${target}`, source, target };
}

test("layouts a connected sample left-to-right and groups it under its model label", () => {
  const nodes = [
    node("preview", "output/preview", 900, 600, 180, 120),
    node("wan", "video/wan", -300, -100, 220, 160),
    node("prompt", "input/prompt", 400, 900, 180, 120),
  ];
  const result = autoLayoutWorkflow(nodes, [edge("prompt", "wan"), edge("wan", "preview")], [], (candidate) =>
    candidate.data.type === "video/wan" ? "Wan 3.0" : undefined);
  const positions = new Map(result.nodes.map((candidate) => [candidate.id, candidate.position]));

  assert.ok(positions.get("prompt").x < positions.get("wan").x);
  assert.ok(positions.get("wan").x < positions.get("preview").x);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].title, "Wan 3.0");
  assert.deepEqual(nodesInsideGroup(result.groups[0], result.nodes).map((candidate) => candidate.id).sort(),
    ["preview", "prompt", "wan"]);
});

test("preserves existing group appearance and groups a separate ungrouped component", () => {
  const nodes = [
    node("prompt", "input/prompt", 0, 0),
    node("wan", "video/wan", 300, 0),
    node("image", "image/generator", 900, 900),
    node("image-preview", "output/preview", 1200, 900),
  ];
  const groups = [{
    id: "existing", title: "My video setup", color: "teal",
    x: -40, y: -70, width: 800, height: 300,
  }];
  const result = autoLayoutWorkflow(
    nodes,
    [edge("prompt", "wan"), edge("image", "image-preview")],
    groups,
    (candidate) => candidate.data.type === "image/generator" ? "Image generator" : undefined,
  );
  const existing = result.groups.find((group) => group.id === "existing");
  const added = result.groups.find((group) => group.id !== "existing");

  assert.deepEqual(
    { title: existing.title, color: existing.color },
    { title: "My video setup", color: "teal" },
  );
  assert.deepEqual(nodesInsideGroup(existing, result.nodes).map((candidate) => candidate.id).sort(),
    ["prompt", "wan"]);
  assert.equal(added.title, "Image generator");
  assert.deepEqual(nodesInsideGroup(added, result.nodes).map((candidate) => candidate.id).sort(),
    ["image", "image-preview"]);
});

test("lays out cyclic graphs without producing invalid positions", () => {
  const nodes = [node("a", "model/a", 0, 0), node("b", "model/b", 0, 0)];
  const result = autoLayoutWorkflow(nodes, [edge("a", "b"), edge("b", "a")], [], () => undefined);

  assert.ok(result.nodes.every((candidate) =>
    Number.isFinite(candidate.position.x) && Number.isFinite(candidate.position.y)));
});
