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
  createUnknownMediaAssetMetadata,
  normalizeMediaAssetMetadata,
  normalizeProjectMediaAsset,
  workflowOutputMediaId,
} = require(path.join(__dirname, "..", "src", "lib", "project-media.ts"));

test("legacy assets receive explicit unknown metadata", () => {
  const asset = normalizeProjectMediaAsset({
    id: "shot-frame",
    name: "Shot frame",
    mediaKind: "image",
    source: { kind: "data-url", dataUrl: "data:image/png;base64,ZmFrZQ==" },
  });
  assert.deepEqual(asset.metadata, createUnknownMediaAssetMetadata());
});

test("normalizes rational frame rates and preserves color and alpha interpretation", () => {
  const metadata = normalizeMediaAssetMetadata({
    width: 1920,
    height: 1080,
    durationSeconds: 10,
    frameRate: { numerator: 48000, denominator: 2002 },
    color: { space: "ACEScg", ocioConfig: "studio-v1", sceneLinear: true },
    alphaMode: "premultiplied",
  });
  assert.deepEqual(metadata, {
    width: 1920,
    height: 1080,
    durationSeconds: 10,
    frameRate: { numerator: 24000, denominator: 1001 },
    color: { space: "ACEScg", ocioConfig: "studio-v1", sceneLinear: true },
    alphaMode: "premultiplied",
  });
});

test("rejects invalid frame rates, dimensions, and source references", () => {
  assert.throws(() => normalizeMediaAssetMetadata({ frameRate: { numerator: 24, denominator: 0 } }),
    /Frame-rate denominator/);
  assert.throws(() => normalizeMediaAssetMetadata({ width: 0 }), /Media width/);
  assert.throws(() => normalizeProjectMediaAsset({
    id: "source", name: "Source", mediaKind: "video", source: { kind: "url", url: "file:///local.mp4" },
  }), /HTTP or HTTPS/);
});

test("workflow output asset IDs are stable and require all source identifiers", () => {
  assert.equal(workflowOutputMediaId("workflow-1", "node-1", "video"),
    "workflow-output:workflow-1:node-1:video");
  assert.throws(() => workflowOutputMediaId("", "node-1", "video"), /requires workflow, node, and port IDs/);
});
