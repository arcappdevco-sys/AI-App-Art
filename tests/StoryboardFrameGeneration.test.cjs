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
  STORYBOARD_FRAME_MODELS,
  buildStoryboardFramePrompt,
  generateStoryboardFrame,
} = require(path.join(__dirname, "..", "src", "lib", "StoryboardFrameGeneration.ts"));

test("frame model selector lists connected image providers and model variants", () => {
  const ids = STORYBOARD_FRAME_MODELS.map((model) => model.id);
  assert.ok(ids.includes("gpt-image-2.6-sunburst"));
  assert.ok(ids.includes("gemini-2.5-flash-image"));
  assert.ok(ids.includes("gemini-3.1-flash-image"));
  assert.ok(ids.includes("fal-ai/nano-banana-pro"));
  assert.ok(ids.includes("black-forest-labs/flux-3/text-to-image"));
  assert.equal(new Set(ids).size, ids.length);
});

test("frame prompts combine scene, shot direction and board aspect ratio", () => {
  const prompt = buildStoryboardFramePrompt({
    title: "EXT. STREET - NIGHT",
  }, {
    title: "The arrival",
    description: "A rain-soaked car pulls up to the curb.",
    shotType: "Wide",
    cameraMove: "Tracking",
  }, "21:9");
  assert.match(prompt, /21:9 video/);
  assert.match(prompt, /EXT\. STREET - NIGHT/);
  assert.match(prompt, /A rain-soaked car pulls up to the curb/);
  assert.match(prompt, /Shot type: Wide/);
  assert.match(prompt, /Camera movement: Tracking/);
});

test("frame generation prefers the separate prompt and falls back to the description", () => {
  const prompt = buildStoryboardFramePrompt(
    { title: "The station" },
    {
      title: "Arrival",
      description: "A train enters the station.",
      prompt: "A rain-soaked train under dramatic blue lights.",
      shotType: "Wide",
      cameraMove: "Tracking",
    },
    "16:9",
  );
  assert.match(prompt, /A rain-soaked train under dramatic blue lights/);
  assert.doesNotMatch(prompt, /A train enters the station/);
});

test("frame generation applies the global style bible once and trims legacy repeated blocks", () => {
  const prompt = buildStoryboardFramePrompt(
    { title: "The station" },
    {
      title: "Arrival",
      description: "A train enters the station.\n\nVisual style: Painterly sci-fi.\nCharacter continuity: UNIT-07.",
      shotType: "Wide",
      cameraMove: "Static",
    },
    "16:9",
    { visualStyle: "Painterly sci-fi.", recurringCharacter: "UNIT-07.", recurringLocation: "" },
  );
  assert.match(prompt, /Action and composition: A train enters the station\./);
  assert.match(prompt, /Global style bible \(apply only details visible in this shot\)/);
  assert.equal((prompt.match(/Painterly sci-fi\./g) ?? []).length, 1);
  assert.doesNotMatch(prompt, /Character continuity:/);
});

test("unsupported image models fail before making a provider request", async () => {
  await assert.rejects(
    generateStoryboardFrame("unsupported-model", "A frame", "16:9"),
    /supported storyboard image model/,
  );
});
