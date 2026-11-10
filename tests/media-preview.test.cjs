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
const { isAtlasVideoNode, outputPreviewType, previewMediaType } = require(
  path.join(__dirname, "..", "src", "lib", "media-preview.ts"),
);

test("model output types support extensionless URLs and video variations", () => {
  const outputs = { video: "video" };
  for (const name of ["video", "variation_2", "variation_3"]) {
    assert.equal(previewMediaType("https://example.com/asset?token=abc", outputPreviewType(name, outputs)), "video");
  }
  assert.equal(previewMediaType("https://example.com/asset", outputPreviewType("image", { image: "image" })), "image");
  assert.equal(previewMediaType("data:image/png;base64,abc"), "image");
  assert.equal(previewMediaType("https://example.com/file.mp4#t=1"), "video");
  assert.equal(previewMediaType("hello"), null);
});

test("connected Preview nodes inherit the actual upstream media type", () => {
  assert.equal(previewMediaType("https://example.com/asset", outputPreviewType("media", {}, "video")), "video");
  assert.equal(previewMediaType("https://example.com/asset", outputPreviewType("media", {}, "image")), "image");
  assert.equal(previewMediaType("https://example.com/asset", outputPreviewType("media", {}, "any")), null);
});

test("all Atlas video model families use the protected playback path", () => {
  for (const type of ["video/wan-3.0", "video/minimax-h3", "video/flux-3", "video/seedance", "video/kling", "video/veo", "video/google-omni"]) {
    assert.equal(isAtlasVideoNode(type), true, type);
  }
  assert.equal(isAtlasVideoNode("fal/model"), false);
  assert.equal(isAtlasVideoNode("google/gemini-image"), false);
});
