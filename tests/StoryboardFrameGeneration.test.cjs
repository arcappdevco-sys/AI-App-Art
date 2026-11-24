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
  buildStoryboardCharacterSheetPrompt,
  buildStoryboardFramePrompt,
  generateStoryboardFrame,
  storyboardFrameModelSupportsCharacterReferences,
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

test("frame prompts name selected character references and restrict their use to identity", () => {
  const prompt = buildStoryboardFramePrompt(
    { title: "Greenhouse" },
    { title: "The sprout", description: "UNIT-07 holds a new sprout.", shotType: "Medium", cameraMove: "Static" },
    "16:9",
    undefined,
    ["UNIT-07"],
  );
  assert.match(prompt, /Character identity references: UNIT-07/);
  assert.match(prompt, /do not copy the reference sheet's pose, composition, background, or lighting/);
});

test("character-sheet prompts preserve canon traits and request matching turnaround views", () => {
  const prompt = buildStoryboardCharacterSheetPrompt({
    name: "UNIT-07",
    visualDescription: "A yellow robot with tank treads, a single lens, and two pincer claws.",
  }, { visualStyle: "Painterly 3D sci-fi.", recurringCharacter: "", recurringLocation: "" });
  assert.match(prompt, /tank treads, a single lens, and two pincer claws/);
  assert.match(prompt, /front view, side view, and back view/);
  assert.match(prompt, /identical in all three views/);
  assert.match(prompt, /Painterly 3D sci-fi/);
  assert.match(prompt, /text, labels, captions, borders, or panel dividers/);
  assert.throws(() => buildStoryboardCharacterSheetPrompt({
    name: "UNIT-07",
    visualDescription: "",
  }), /visual description/);
});

test("unsupported image models fail before making a provider request", async () => {
  await assert.rejects(
    generateStoryboardFrame("unsupported-model", "A frame", "16:9"),
    /supported storyboard image model/,
  );
});

test("character references are limited to supported image models and three images", async () => {
  const image = "data:image/png;base64,ZmFrZQ==";
  assert.equal(storyboardFrameModelSupportsCharacterReferences("gemini-3.1-flash-image"), true);
  assert.equal(storyboardFrameModelSupportsCharacterReferences("fal-ai/nano-banana-2"), true);
  assert.equal(storyboardFrameModelSupportsCharacterReferences("gpt-image-2.6-sunburst"), false);
  await assert.rejects(
    generateStoryboardFrame("gpt-image-2.6-sunburst", "A frame", "16:9", [image]),
    /require a Nano Banana image model/,
  );
  await assert.rejects(
    generateStoryboardFrame("gemini-3.1-flash-image", "A frame", "16:9", [image, image, image, image]),
    /no more than three/,
  );
});
