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
const { prepareEditorVideoSource } = require(path.join(__dirname, "..", "src", "lib", "editor-video-source.ts"));

test("workflow videos are downloaded and use a local object URL before playback", async () => {
  const file = new File(["video"], "wan.mp4", { type: "video/mp4" });
  let downloaded = false;
  const prepared = await prepareEditorVideoSource({ src: "https://cdn.example.com/wan.mp4", name: "Wan" }, async (src, name) => {
    assert.equal(src, "https://cdn.example.com/wan.mp4");
    assert.equal(name, "Wan");
    downloaded = true;
    return file;
  });
  try {
    assert.equal(downloaded, true);
    assert.equal(prepared.file, file);
    assert.match(prepared.src, /^blob:/);
    assert.equal(prepared.ownedUrl, prepared.src);
    assert.equal(await (await fetch(prepared.src)).text(), "video");
  } finally {
    URL.revokeObjectURL(prepared.src);
  }
});

test("local footage retains its existing object URL and download failures surface", async () => {
  const file = new File(["video"], "local.mp4", { type: "video/mp4" });
  const asset = { src: "blob:existing", name: "local.mp4", file };
  const prepared = await prepareEditorVideoSource(asset, async () => { throw new Error("Unexpected download"); });
  assert.deepEqual(prepared, { file, src: "blob:existing", ownedUrl: null });
  await assert.rejects(prepareEditorVideoSource({ src: "https://example.com/expired", name: "Wan" },
    async () => { throw new Error("The media source returned HTTP 403."); }), /HTTP 403/);
});
