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

const { getVideoExportDimensions } = require(path.join(__dirname, "..", "src", "lib", "video-export-settings.ts"));

test("maps each export resolution to landscape and portrait dimensions", () => {
  assert.deepEqual(getVideoExportDimensions("720p", "landscape"), { width: 1280, height: 720 });
  assert.deepEqual(getVideoExportDimensions("720p", "portrait"), { width: 720, height: 1280 });
  assert.deepEqual(getVideoExportDimensions("1080p", "landscape"), { width: 1920, height: 1080 });
  assert.deepEqual(getVideoExportDimensions("1080p", "portrait"), { width: 1080, height: 1920 });
  assert.deepEqual(getVideoExportDimensions("4k", "landscape"), { width: 3840, height: 2160 });
  assert.deepEqual(getVideoExportDimensions("4k", "portrait"), { width: 2160, height: 3840 });
});

test("rejects unsupported export settings", () => {
  assert.throws(() => getVideoExportDimensions("8k", "landscape"), /supported video export resolution/);
  assert.throws(() => getVideoExportDimensions("1080p", "square"), /landscape or portrait/);
});
