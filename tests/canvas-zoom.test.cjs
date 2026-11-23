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
const { zoomCanvasAtPoint } = require(path.join(__dirname, "..", "src", "lib", "canvas-zoom.ts"));

test("zooms around the pointer so its canvas position stays fixed", () => {
  const viewport = { x: 100, y: 50, zoom: 1 };
  const point = { x: 300, y: 200 };
  const next = zoomCanvasAtPoint(viewport, point, -100, 0.001, 2);
  const before = { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
  const after = { x: (point.x - next.x) / next.zoom, y: (point.y - next.y) / next.zoom };

  assert.ok(next.zoom > viewport.zoom);
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test("keeps zoom within the canvas limits", () => {
  assert.equal(zoomCanvasAtPoint({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 100000, 0.5, 2).zoom, 0.5);
  assert.equal(zoomCanvasAtPoint({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, -100000, 0.5, 2).zoom, 2);
});
