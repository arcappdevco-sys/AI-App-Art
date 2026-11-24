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
  return originalResolve.call(this, request.startsWith("@/")
    ? path.join(__dirname, "..", "src", request.slice(2))
    : request, ...args);
};
const { POST } = require("../src/app/api/atlas/seedance/route.ts");
Module._resolveFilename = originalResolve;

function seedanceRequest(images) {
  return new Request("http://localhost/api/atlas/seedance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "bytedance/seedance-2.5/image-to-video",
      duration: 6,
      resolution: "720p",
      ratio: "adaptive",
      output_format: "mp4",
      generate_audio: true,
      watermark: false,
      return_last_frame: false,
      draft: false,
      ...images,
    }),
  });
}

test("Seedance uploads storyboard data-URI frames before submitting generation", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ATLASCLOUD_API_KEY;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/uploadMedia")) {
      return Response.json({ data: { url: `https://cdn.example.com/frame-${calls.length}.png` } });
    }
    return Response.json({ data: { id: "prediction-1" } });
  };
  try {
    const response = await POST(seedanceRequest({
      image: "data:image/png;base64,aGVsbG8=",
      last_image: "data:image/png;base64,d29ybGQ=",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { predictionId: "prediction-1" });
    assert.equal(calls.length, 3);
    for (const upload of calls.slice(0, 2)) {
      assert.equal(upload.url, "https://api.atlascloud.ai/api/v1/model/uploadMedia");
      assert.equal(upload.init.headers.Authorization, "Bearer test-key");
      assert.equal(upload.init.body.get("file").type, "image/png");
    }
    const submitted = JSON.parse(calls[2].init.body);
    assert.equal(submitted.image, "https://cdn.example.com/frame-1.png");
    assert.equal(submitted.last_image, "https://cdn.example.com/frame-2.png");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = originalKey;
  }
});

test("Seedance keeps already-hosted image URLs without reuploading", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ATLASCLOUD_API_KEY;
  process.env.ATLASCLOUD_API_KEY = "test-key";
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: { id: "prediction-1" } });
  };
  try {
    const response = await POST(seedanceRequest({ image: "https://cdn.example.com/frame.png" }));

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body).image, "https://cdn.example.com/frame.png");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = originalKey;
  }
});
