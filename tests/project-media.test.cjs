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
  workflowOutputSnapshotMediaId,
  workflowOutputMediaSource,
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

test("workflow output snapshots have stable, URL-specific asset IDs", async () => {
  const firstUrl = "https://cdn.example/video.mp4?signature=first";
  const firstId = await workflowOutputSnapshotMediaId("workflow-1", "node-1", "video", firstUrl);
  assert.equal(firstId, await workflowOutputSnapshotMediaId("workflow-1", "node-1", "video", firstUrl));
  assert.notEqual(firstId, await workflowOutputSnapshotMediaId(
    "workflow-1",
    "node-1",
    "video",
    "https://cdn.example/video.mp4?signature=second",
  ));
  await assert.rejects(
    workflowOutputSnapshotMediaId("workflow-1", "node-1", "video", "data:video/mp4;base64,ZmFrZQ=="),
    /HTTP or HTTPS URL/,
  );
});

test("workflow image outputs support remote and inline sources", () => {
  assert.deepEqual(workflowOutputMediaSource("image", "https://cdn.example/image.png"), {
    kind: "url",
    url: "https://cdn.example/image.png",
  });
  assert.deepEqual(workflowOutputMediaSource("image", "data:image/png;base64,ZmFrZQ=="), {
    kind: "data-url",
    dataUrl: "data:image/png;base64,ZmFrZQ==",
  });
  assert.equal(workflowOutputMediaSource("video", "data:video/mp4;base64,ZmFrZQ=="), null);
  assert.equal(workflowOutputMediaSource("audio", "https://cdn.example/audio.mp3"), null);
});

test("shared asset revisions are normalized and validated", () => {
  const asset = normalizeProjectMediaAsset({
    id: "versioned-asset",
    name: "Versioned asset",
    mediaKind: "image",
    source: { kind: "storage", storageKey: "versioned-asset" },
    revision: 3,
  });
  assert.equal(asset.revision, 3);
  assert.throws(() => normalizeProjectMediaAsset({
    id: "invalid-revision",
    name: "Invalid revision",
    mediaKind: "image",
    source: { kind: "storage", storageKey: "invalid-revision" },
    revision: -1,
  }), /non-negative safe integer/);
});
