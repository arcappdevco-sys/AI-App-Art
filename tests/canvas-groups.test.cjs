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
const { groupBoundsForNodes, nodesInsideGroup, normalizeCanvasGroups } =
  require(path.join(__dirname, "..", "src", "lib", "canvas-groups.ts"));

test("groups wrap measured node bounds with the requested padding", () => {
  const nodes = [
    { id: "a", position: { x: 100, y: 200 }, measured: { width: 250, height: 100 } },
    { id: "b", position: { x: -50, y: 300 }, measured: { width: 100, height: 200 } },
  ];
  assert.deepEqual(groupBoundsForNodes(nodes), { x: -90, y: 130, width: 480, height: 410 });
  assert.equal(groupBoundsForNodes([]), null);
});

test("membership is computed from node centers without storing it", () => {
  const group = { id: "g", title: "Group", color: "default", x: 0, y: 0, width: 200, height: 100 };
  const nodes = [
    { id: "inside", position: { x: -20, y: 20 }, measured: { width: 60, height: 40 } },
    { id: "outside", position: { x: 190, y: 20 }, measured: { width: 60, height: 40 } },
  ];
  assert.deepEqual(nodesInsideGroup(group, nodes).map((node) => node.id), ["inside"]);
});

test("missing and malformed group data is ignored without affecting valid entries", () => {
  const valid = { id: "g", title: "Scene", color: "teal", x: -50, y: 40, width: 400, height: 300 };
  assert.deepEqual(normalizeCanvasGroups(undefined), []);
  assert.deepEqual(normalizeCanvasGroups({ bad: true }), []);
  assert.deepEqual(normalizeCanvasGroups([null, valid, valid, { ...valid, id: "bad", width: -1 }, { ...valid, id: "bad-color", color: "garbage" }]), [valid]);
  assert.deepEqual(normalizeCanvasGroups(JSON.parse(JSON.stringify([valid]))), [valid]);
});
