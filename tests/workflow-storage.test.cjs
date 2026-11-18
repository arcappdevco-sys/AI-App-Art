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
const { stripInvalidWorkflowConnections } = require(
  path.join(__dirname, "..", "src", "lib", "workflow-storage.ts"),
);

test("removes malformed and dangling workflow connections without mutating the saved data", () => {
  const workflow = {
    nodes: [{ id: "source" }, { id: "target" }],
    edges: [
      { id: "valid", source: "source", target: "target", sourceHandle: "image", targetHandle: "image" },
      { id: "missing-target", source: "source", target: "deleted", sourceHandle: "image", targetHandle: "image" },
      { id: "missing-handle", source: "source", target: "target", sourceHandle: null, targetHandle: "image" },
    ],
  };

  const result = stripInvalidWorkflowConnections(workflow);

  assert.equal(result.removed, 2);
  assert.deepEqual(result.workflow.edges.map((edge) => edge.id), ["valid"]);
  assert.equal(workflow.edges.length, 3);
});
