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

const stillVideo = require(path.join(__dirname, "..", "src", "lib", "still-video.ts"));

test("validates still clip duration, motion, and image bounds", () => {
  assert.doesNotThrow(() => stillVideo.validateStillVideoSettings(60, "pan-right"));
  assert.throws(() => stillVideo.validateStillVideoSettings(0, "none"), /between 1 and 60 seconds/);
  assert.throws(() => stillVideo.validateStillVideoSettings(5, "invalid"), /supported still-image motion/);
  assert.doesNotThrow(() => stillVideo.validateStillImage("image/png", 100, 4000, 3000));
  assert.throws(() => stillVideo.validateStillImage("image/gif", 100, 10, 10), /JPEG, PNG, or WebP/);
  assert.throws(() => stillVideo.validateStillImage("image/png", 100, 8192, 8192), /dimensions are too large/);
});

test("creates bounded, fixed-size video filters for each motion preset", () => {
  const expectedFragments = {
    none: "pad=1280:720",
    "zoom-in": "z='1+0.12*on/150'",
    "zoom-out": "z='1.12-0.12*on/150'",
    "pan-left": "zoompan=z='1.12'",
    "pan-right": "zoompan=z='1.12'",
  };
  for (const [motion, fragment] of Object.entries(expectedFragments)) {
    const filter = stillVideo.stillVideoFilter(5, motion);
    assert.ok(filter.includes(fragment), `${motion} filter should include ${fragment}`);
    assert.match(filter, /(?:scale=1280:720|s=1280x720)/);
    assert.ok(filter.includes("fps=30"));
  }
});

test("renders still clips at selected portrait and 4K dimensions", () => {
  const filter = stillVideo.stillVideoFilter(5, "none", 2160, 3840);
  assert.ok(filter.includes("scale=2160:3840"));
  assert.ok(filter.includes("pad=2160:3840"));
});
