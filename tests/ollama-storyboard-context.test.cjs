/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const {
  createOllamaStoryboardContext,
  extractOllamaStoryboardPrompt,
  formatOllamaStoryboardPromptContext,
  normalizeOllamaStoryboardPrompt,
  resolveOllamaStoryboardShot,
  validateOllamaStoryboardPrompt,
} = require("../src/lib/ollama-storyboard-context.ts");

const storyboard = {
  version: 1,
  title: "The Last Garden",
  aspectRatio: "16:9",
  scenes: [
    { id: "scene-1", title: "Opening", shots: [
      { id: "shot-1", title: "Establishing", description: "A ruined greenhouse.", prompt: "", shotType: "Wide", cameraMove: "Static", durationSeconds: 6, notes: "", frame: "data:image/png;base64,private" },
      { id: "shot-2", title: "Robot arrives", description: "A small robot enters.", prompt: "A compact ochre robot rolls under broken glass.", shotType: "Medium", cameraMove: "Tracking", durationSeconds: 4, notes: "", frame: null },
    ] },
    { id: "scene-2", title: "Inside", shots: [
      { id: "shot-3", title: "The door", description: "The robot opens the door.", prompt: "", shotType: "Close-up", cameraMove: "Dolly in", durationSeconds: 3, notes: "", frame: null },
      { id: "shot-4", title: "The seed", description: "The robot discovers a seed.", prompt: "", shotType: "Extreme close-up", cameraMove: "Static", durationSeconds: 5, notes: "Warm light", frame: null },
    ] },
  ],
};

test("builds text-only context with the storyboard's visible global shot numbers", () => {
  const context = createOllamaStoryboardContext(storyboard, "workflow-1", "project-1:workflow-1");
  assert.equal(context.shots[3].number, 4);
  assert.equal(context.shots[3].id, "shot-4");
  assert.match(context.text, /Shot 04/);
  assert.match(context.text, /The robot discovers a seed/);
  assert.match(context.text, /A compact ochre robot rolls under broken glass/);
  assert.doesNotMatch(context.text, /data:image/);
  assert.equal(context.workflowId, "workflow-1");
  assert.equal(context.tooLong, false);
});

test("resolves one explicit shot reference and rejects ambiguous references", () => {
  const context = createOllamaStoryboardContext(storyboard, "workflow-1", "scope");
  assert.equal(resolveOllamaStoryboardShot("Can you look at shot 04?", context.shots).id, "shot-4");
  assert.equal(resolveOllamaStoryboardShot("Review shot04", context.shots).id, "shot-4");
  assert.equal(resolveOllamaStoryboardShot("Compare shot 2 and shot 4", context.shots), null);
  assert.equal(resolveOllamaStoryboardShot("Look at shot 8", context.shots), null);
});

test("formats one referenced shot as plain text with continuity separated from its description", () => {
  const legacyStoryboard = {
    ...storyboard,
    scenes: storyboard.scenes.map((scene) => ({
      ...scene,
      shots: scene.shots.map((shot) => ({
        ...shot,
        description: `${shot.description}\n\nVisual style: Painterly 3D sci-fi.\nCharacter continuity: UNIT-07, a small service robot.`,
      })),
    })),
  };
  const context = createOllamaStoryboardContext(legacyStoryboard, "workflow-1", "scope");
  const selectedShot = resolveOllamaStoryboardShot("Write a prompt for Shot 04.", context.shots);
  const formatted = formatOllamaStoryboardPromptContext(context, selectedShot);

  assert.match(formatted.text, /GLOBAL STYLE BIBLE/);
  assert.match(formatted.text, /Recurring character: UNIT-07, a small service robot\./);
  assert.match(formatted.text, /SHOT TYPE: Extreme close-up/);
  assert.match(formatted.text, /DESCRIPTION: The robot discovers a seed\./);
  assert.equal((formatted.text.match(/Visual style: Painterly/g) ?? []).length, 1);
  assert.doesNotMatch(formatted.text, /The robot opens the door|A small robot enters|[{}]/);
  assert.equal(formatted.tooLong, false);
});

test("extracts only a bounded explicit replacement-prompt block", () => {
  assert.equal(
    extractOllamaStoryboardPrompt("Suggested revision:\n```shot-prompt\nA robot finds a seed.\n```"),
    "A robot finds a seed.",
  );
  assert.equal(extractOllamaStoryboardPrompt("Just some feedback."), null);
  assert.equal(extractOllamaStoryboardPrompt("```shot-prompt\none\n```\n```shot-prompt\ntwo\n```"), null);
});

test("validates storyboard prompt length, opening, and single-paragraph wording", () => {
  const opening = "A painterly 3D sci-fi render, 9:16 portrait,";
  const prompt = [
    opening,
    ...Array(90 - opening.split(/\s+/).length).fill("detail"),
  ].join(" ");
  assert.equal(validateOllamaStoryboardPrompt(prompt, "9:16"), null);
  assert.match(validateOllamaStoryboardPrompt(prompt, "16:9"), /must start/);
  assert.match(validateOllamaStoryboardPrompt(prompt.replace(/ detail$/, ""), "9:16"), /90-150 words/);
  assert.match(validateOllamaStoryboardPrompt(`${prompt}\nExtra paragraph.`, "9:16"), /single paragraph/);
  assert.match(validateOllamaStoryboardPrompt(`${prompt} animated`, "9:16"), /render or illustration/);

  const missingOpening = normalizeOllamaStoryboardPrompt(prompt.slice(opening.length).trim(), "9:16");
  assert.equal(validateOllamaStoryboardPrompt(missingOpening, "9:16"), null);
  const labeledPrompt = normalizeOllamaStoryboardPrompt(
    `Here's the final prompt: ${prompt.slice(opening.length).trim()}`,
    "9:16",
  );
  assert.equal(validateOllamaStoryboardPrompt(labeledPrompt, "9:16"), null);
  const alternateOpening = prompt.replace(opening, "A painterly 3D sci-fi illustration, 9:16 portrait,");
  assert.ok(normalizeOllamaStoryboardPrompt(alternateOpening, "9:16").startsWith(opening));
});
