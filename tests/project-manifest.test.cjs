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
  normalizeProjectManifest,
  PROJECT_MANIFEST_FORMAT,
  PROJECT_MANIFEST_VERSION,
} = require(path.join(__dirname, "..", "src", "lib", "project-manifest.ts"));

function createManifest(overrides = {}) {
  return {
    format: PROJECT_MANIFEST_FORMAT,
    schemaVersion: PROJECT_MANIFEST_VERSION,
    id: "project-1",
    name: "Test Project",
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-03T03:04:05.000Z",
    assets: [{
      id: "shot-1",
      name: "Shot 1",
      mediaKind: "video",
      mimeType: "video/mp4",
      relativePath: "Media\\Originals\\shot-1.mp4",
      proxyPath: "Cache\\Proxies\\shot-1.mp4",
      sizeBytes: 1234,
      sha256: "A".repeat(64),
      metadata: {
        width: 1920,
        height: 1080,
        durationSeconds: 2,
        frameRate: { numerator: 48, denominator: 2 },
        color: { space: "ACEScg", ocioConfig: "config.ocio", sceneLinear: true },
        alphaMode: "straight",
      },
    }],
    ...overrides,
  };
}

test("normalizes folder paths, timestamps, hashes, and media metadata", () => {
  const manifest = normalizeProjectManifest(createManifest());
  assert.equal(manifest.assets[0].relativePath, "Media/Originals/shot-1.mp4");
  assert.equal(manifest.assets[0].proxyPath, "Cache/Proxies/shot-1.mp4");
  assert.equal(manifest.assets[0].sha256, "a".repeat(64));
  assert.deepEqual(manifest.assets[0].metadata.frameRate, { numerator: 24, denominator: 1 });
});

test("rejects absolute and traversal paths for originals and proxies", () => {
  for (const relativePath of ["../outside.mp4", "Media/../../outside.mp4", "C:\\outside.mp4", "\\\\server\\share.mp4"]) {
    assert.throws(() => normalizeProjectManifest(createManifest({
      assets: [{ ...createManifest().assets[0], relativePath },
      ],
    })), /safe path|traversal/);
  }
  assert.throws(() => normalizeProjectManifest(createManifest({
    assets: [{ ...createManifest().assets[0], proxyPath: "../outside.mp4" }],
  })), /safe path|traversal/);
});

test("rejects duplicate IDs, unsupported versions, and invalid integrity data", () => {
  const asset = createManifest().assets[0];
  assert.throws(() => normalizeProjectManifest(createManifest({ assets: [asset, asset] })), /duplicate asset ID/);
  assert.throws(() => normalizeProjectManifest(createManifest({ schemaVersion: 2 })), /not supported/);
  assert.throws(() => normalizeProjectManifest(createManifest({
    assets: [{ ...asset, sha256: "not-a-hash" }],
  })), /SHA-256/);
  assert.throws(() => normalizeProjectManifest(createManifest({
    assets: [{ ...asset, sizeBytes: 0 }],
  })), /size must be a positive safe integer/);
});
