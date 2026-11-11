/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(__dirname, "..", "src", request.slice(2)) : request, ...args);
};
const { POST } = require("../src/app/api/atlas/wan/route.ts");
const { findAtlasUploadUrl } = require("../src/lib/atlas-upload.ts");
const { wanDataUrlToFile } = require("../src/lib/wan-api.ts");
Module._resolveFilename = originalResolve;

function uploadRequest(action) {
  const png = Buffer.alloc(33);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(1024, 20);
  png[25] = 2;
  const form = new FormData();
  form.append("action", action);
  if (action === "upload") form.append("kind", "image");
  form.append("file", new File([png], "frame.png", { type: "image/png" }));
  return new Request("http://localhost/api/atlas/wan", { method: "POST", body: form });
}

test("all Atlas upload actions accept top-level and nested media URLs", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ATLASCLOUD_API_KEY;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  let payload;
  global.fetch = async () => Response.json(payload);
  try {
    for (const action of ["upload", "minimax_upload", "flux3_upload", "flux3_video_upload"]) {
      for (const result of [
        { url: "https://cdn.example.com/image.png" },
        { data: { url: "https://cdn.example.com/image.png" } },
        { data: "https://cdn.example.com/image.png" },
        { code: 200, message: "success", data: {
          type: "image/png", download_url: "https://cdn.example.com/image.png", filename: "frame.png", size: 33,
        } },
      ]) {
        payload = result;
        const response = await POST(uploadRequest(action));
        assert.equal(response.status, 200, `${action}: ${JSON.stringify(await response.clone().json())}`);
        assert.deepEqual(await response.json(), { url: "https://cdn.example.com/image.png" });
      }
    }
    payload = { code: 400, message: "Invalid upload test-key" };
    const response = await POST(uploadRequest("upload"));
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.match(error, /Invalid upload \[redacted\]/);
    assert.doesNotMatch(error, /test-key/);
    assert.match(error, /Response fields: code, message/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = originalKey;
  }
});

test("upload parsing ignores unrelated URLs unless legacy compatibility is requested", () => {
  const payload = { message: "https://example.com/help" };
  assert.equal(findAtlasUploadUrl(payload), "");
  assert.equal(findAtlasUploadUrl(payload, 0, true), payload.message);
});

test("data URL uploads use filenames matching their media type", () => {
  assert.equal(wanDataUrlToFile("data:image/png;base64,YQ==", "wan-first-frame", "").name, "wan-first-frame.png");
  assert.equal(wanDataUrlToFile("data:image/jpeg;base64,YQ==", "wan-last-frame", "").name, "wan-last-frame.jpg");
  assert.equal(wanDataUrlToFile("data:image/png;base64,YQ==", "existing.png", "").name, "existing.png");
});
