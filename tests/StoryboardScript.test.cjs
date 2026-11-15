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
  normalizeGeneratedStoryboard,
  STORYBOARD_SCRIPT_MAX_SCENES,
} = require(path.join(__dirname, "..", "src", "lib", "StoryboardScript.ts"));

test("generated storyboard fields are normalized and receive fresh IDs", () => {
  const result = normalizeGeneratedStoryboard({
    scenes: [{
      title: "EXT. STREET - NIGHT",
      shots: [{
        title: "The arrival",
        description: "A car pulls up to the curb.",
        shotType: "Wide",
        cameraMove: "Tracking",
        durationSeconds: 4.5,
        notes: "Rain on the pavement.",
      }],
    }],
  });
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].collapsed, false);
  assert.equal(result.scenes[0].title, "EXT. STREET - NIGHT");
  assert.equal(result.scenes[0].shots[0].shotType, "Wide");
  assert.equal(result.scenes[0].shots[0].frame, null);
  assert.equal(result.scenes[0].shots[0].durationSeconds, 4.5);
  assert.equal(new Set([result.scenes[0].id, result.scenes[0].shots[0].id]).size, 2);
});

test("invalid generated scenes and shots are rejected", () => {
  assert.throws(() => normalizeGeneratedStoryboard({ scenes: [] }), /invalid number of scenes/);
  assert.throws(() => normalizeGeneratedStoryboard({ scenes: [{ title: "Empty", shots: [] }] }), /invalid scene/);
  assert.throws(() => normalizeGeneratedStoryboard({ scenes: [{ title: "Bad", shots: [null] }] }), /invalid shot/);
});

test("scene and total shot limits are enforced", () => {
  assert.throws(() => normalizeGeneratedStoryboard({
    scenes: Array.from({ length: STORYBOARD_SCRIPT_MAX_SCENES + 1 }, () => ({ shots: [{}] })),
  }), /invalid number of scenes/);
  assert.throws(() => normalizeGeneratedStoryboard({
    scenes: Array.from({ length: 11 }, () => ({ shots: Array.from({ length: 11 }, () => ({})) })),
  }), /too many shots/);
});
