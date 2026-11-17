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
const { formatCameraTrackGuide, parseCameraTrack } = require(path.join(__dirname, "..", "src", "lib", "camera-guide.ts"));

const validTrack = JSON.stringify({
  version: 1,
  frameRate: 24,
  handedness: "right",
  upAxis: "Y",
  keyframes: [
    { frame: 0, position: [0, 1.6, 0], rotationDegrees: [0, 0, 0], focalLengthMm: 35 },
    { frame: 48, position: [0, 1.6, -2], rotationDegrees: [0, 15, 0], focalLengthMm: 35 },
  ],
});

test("camera tracks are validated and formatted as explicit approximate guidance", () => {
  const track = parseCameraTrack(validTrack);
  assert.equal(track.keyframes.length, 2);
  const guide = formatCameraTrackGuide(validTrack);
  assert.match(guide, /approximate prompt guidance, not a hard 3D constraint/);
  assert.match(guide, /frame 48: position \[0, 1\.6, -2\]/);
  assert.match(guide, /focal length 35 mm/);
});

test("camera tracks reject malformed, unordered, and oversized input", () => {
  assert.throws(() => parseCameraTrack("{"), /valid JSON/);
  assert.throws(() => parseCameraTrack(JSON.stringify({
    version: 1, frameRate: 24,
    keyframes: [
      { frame: 2, position: [0, 0, 0], rotationDegrees: [0, 0, 0] },
      { frame: 2, position: [0, 0, 0], rotationDegrees: [0, 0, 0] },
    ],
  })), /unique, increasing/);
  assert.throws(() => parseCameraTrack(JSON.stringify({
    version: 1,
    frameRate: 24,
    keyframes: Array.from({ length: 17 }, (_, frame) => ({
      frame, position: [0, 0, 0], rotationDegrees: [0, 0, 0],
    })),
  })), /1 to 16 keyframes/);
});
