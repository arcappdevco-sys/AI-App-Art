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
  parseStructuredStoryboardScript,
  STORYBOARD_SCRIPT_MAX_SCENES,
} = require(path.join(__dirname, "..", "src", "lib", "StoryboardScript.ts"));

function makeShotScript(headings, durations = headings.map(() => 6), visuals = []) {
  const shots = headings.map((heading, index) => [
    `SHOT ${String(index + 1).padStart(2, "0")} | ${heading} | DURATION: ${durations[index]}s`,
    `VISUAL: ${visuals[index] ?? `UNIT-07 studies the plants in shot ${index + 1}.`}`,
    "AUDIO: Wind moves through the glass.",
  ].join("\n"));
  return [
    "TITLE: Greenhouse",
    "VISUAL STYLE: Painterly black and white storyboard.",
    "RECURRING CHARACTER: UNIT-07, a small service robot.",
    "RECURRING LOCATION: An overgrown glass greenhouse.",
    ...shots,
  ].join("\n\n");
}

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

test("numbered shot scripts import locally with continuity, audio notes, and durations intact", () => {
  const headings = [
    "EXT. BLACK VOID - TITLE CARD",
    "EXT. ABANDONED GREENHOUSE - DUSK",
    "EXT. ABANDONED GREENHOUSE - DUSK",
    "INT. ABANDONED GREENHOUSE - DUSK",
    "INT. ABANDONED GREENHOUSE - DUSK",
    "INT. ABANDONED GREENHOUSE - DUSK",
    "INT. ABANDONED GREENHOUSE - NIGHT",
    "INT. ABANDONED GREENHOUSE - NIGHT",
    "INT. ABANDONED GREENHOUSE - NIGHT",
    "INT. ABANDONED GREENHOUSE - DEEP NIGHT",
    "INT. ABANDONED GREENHOUSE - DAWN",
    "INT. ABANDONED GREENHOUSE - DAWN",
    "INT. ABANDONED GREENHOUSE - DAWN",
    "INT. ABANDONED GREENHOUSE - MORNING",
  ];
  const durations = [6, 12, 5, 13, 5, 10, 13, 10, 10, 12, 5, 12, 15, 22];
  const visuals = headings.map((_, index) => index === 0
    ? 'White title text "THE LAST GARDEN" on pure black.'
    : `UNIT-07 studies the plants in shot ${index + 1}.`);
  const result = parseStructuredStoryboardScript(makeShotScript(headings, durations, visuals));

  assert.ok(result);
  assert.deepEqual(result.scenes.map((scene) => scene.shots.length), [1, 2, 3, 3, 1, 3, 1]);
  const shots = result.scenes.flatMap((scene) => scene.shots);
  assert.equal(shots.length, 14);
  assert.equal(shots.reduce((total, shot) => total + shot.durationSeconds, 0), 150);
  assert.equal(shots[0].title, "Shot 01");
  assert.equal(shots[0].shotType, "Title card");
  assert.equal(shots[0].cameraMove, "Static");
  assert.equal(shots[0].frame, null);
  assert.doesNotMatch(shots[0].description, /Character continuity|Location continuity|Visual style/);
  assert.equal(shots[1].description, visuals[1]);
  assert.equal(result.styleBible.visualStyle, "Painterly black and white storyboard.");
  assert.equal(result.styleBible.recurringCharacter, "UNIT-07, a small service robot.");
  assert.equal(result.styleBible.recurringLocation, "An overgrown glass greenhouse.");
  assert.equal(shots[0].notes, "Wind moves through the glass.");
});

test("Markdown-formatted shot sections keep continuity in a global style bible", () => {
  const script = [
    "# THE LAST GARDEN",
    "**Runtime:** ~2:30 (14 Shots)",
    "**Visual Style:** Painterly 3D sci-fi animation, 16:9 widescreen.",
    "## CHARACTER BIBLE: UNIT-07",
    "A small service robot with weathered metal and chipped enamel.",
    "### SHOT 01 | EXT. WASTELAND / GREENHOUSE EXTERIOR - DUSK | DURATION: 8s",
    "**Visual:** Wide establishing shot of the shattered conservatory at dusk.",
    "**Audio:** Howling desert wind fades in.",
  ].join("\n");
  const result = parseStructuredStoryboardScript(script);

  assert.ok(result);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].shots[0].durationSeconds, 8);
  assert.equal(result.scenes[0].shots[0].description, "Wide establishing shot of the shattered conservatory at dusk.");
  assert.equal(result.styleBible.visualStyle, "Painterly 3D sci-fi animation, 16:9 widescreen.");
  assert.equal(result.styleBible.recurringCharacter, "UNIT-07\nA small service robot with weathered metal and chipped enamel.");
  assert.equal(result.scenes[0].shots[0].notes, "Howling desert wind fades in.");
});

test("local imports fill missing durations and retain explicit shot metadata", () => {
  const result = parseStructuredStoryboardScript([
    "### SHOT 01 | EXT. BLACK VOID - TITLE CARD",
    "- **Shot Type:** Close-up",
    "- **Camera Movement:** Pan",
    "- **Visual:** White title text centered on black.",
    "- **Audio:** None.",
  ].join("\n"));

  assert.ok(result);
  assert.equal(result.scenes[0].shots[0].shotType, "Close-up");
  assert.equal(result.scenes[0].shots[0].cameraMove, "Pan");
  assert.equal(result.scenes[0].shots[0].durationSeconds, 6);
});

test("title cards keep their shot description separate from the global continuity bible", () => {
  const result = parseStructuredStoryboardScript([
    "**Visual Style:** Painterly sci-fi animation.",
    "## CHARACTER BIBLE: UNIT-07",
    "A compact ochre-yellow robot.",
    "## LOCATION BIBLE: CONSERVATORY 04",
    "A half-collapsed glass greenhouse.",
    "### SHOT 01 | EXT. BLACK VOID - TITLE CARD",
    "**Visual:** White title text on a pure solid black background.",
  ].join("\n"));

  assert.ok(result);
  const shot = result.scenes[0].shots[0];
  assert.equal(shot.shotType, "Title card");
  assert.equal(shot.cameraMove, "Static");
  assert.equal(shot.durationSeconds, 6);
  assert.equal(shot.description, "White title text on a pure solid black background.");
  assert.equal(result.styleBible.visualStyle, "Painterly sci-fi animation.");
  assert.equal(result.styleBible.recurringCharacter, "UNIT-07\nA compact ochre-yellow robot.");
  assert.equal(result.styleBible.recurringLocation, "CONSERVATORY 04\nA half-collapsed glass greenhouse.");
});

test("local shot import splits oversized scenes and rejects incomplete or freeform scripts", () => {
  const oneSlugline = Array.from({ length: 13 }, () => "INT. GREENHOUSE - NIGHT");
  const split = parseStructuredStoryboardScript(makeShotScript(oneSlugline));
  assert.ok(split);
  assert.deepEqual(split.scenes.map((scene) => scene.shots.length), [12, 1]);
  assert.equal(parseStructuredStoryboardScript("A freeform screenplay without numbered shots."), null);
  assert.equal(parseStructuredStoryboardScript(
    "SHOT 01 | INT. GREENHOUSE - NIGHT | DURATION: 6s\nA shot without a VISUAL field.",
  ), null);
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
