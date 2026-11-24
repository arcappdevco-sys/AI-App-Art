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
const { createEmptyStoryboard, normalizeStoryboard } =
  require(path.join(__dirname, "..", "src", "lib", "StoryboardData.ts"));

test("missing and malformed storyboards fall back to an empty board", () => {
  assert.deepEqual(normalizeStoryboard(undefined), createEmptyStoryboard());
  assert.deepEqual(normalizeStoryboard(null), createEmptyStoryboard());
  assert.deepEqual(normalizeStoryboard({ version: 2, scenes: [] }), createEmptyStoryboard());
  assert.deepEqual(normalizeStoryboard({ version: 1, scenes: "invalid" }), createEmptyStoryboard());
});

test("valid storyboard content survives normalization and JSON round trips", () => {
  const storyboard = {
    version: 1,
    title: "Opening",
    aspectRatio: "21:9",
    styleBible: { visualStyle: "", recurringCharacter: "", recurringLocation: "" },
    characters: [{
      id: "character",
      name: "MARA",
      aliases: ["The Pilot"],
      visualDescription: "A scarred flight jacket.",
      evidence: ["MARA wears a scarred flight jacket."],
      referenceImageMediaAssetId: "character-reference-image",
      referenceImageApproved: true,
      referenceImageSource: "generated",
      referenceImageModel: "gpt-image-2.6-sunburst",
      appearances: [{
        shotNumber: 1,
        sceneHeading: "INT. COCKPIT - NIGHT",
        evidence: "MARA enters the cockpit.",
      }],
    }],
    scenes: [{
      id: "scene",
      title: "The station",
      collapsed: true,
      shots: [{
        id: "shot",
        title: "Arrival",
        description: "A train enters the station.",
        prompt: "A cinematic wide view of the train arriving.",
        characterIds: ["character"],
        shotType: "Wide",
        cameraMove: "Tracking",
        durationSeconds: 4.5,
        notes: "Blue hour.",
        frame: "data:image/png;base64,ZmFrZQ==",
        frameMetadata: {
          width: 2048,
          height: 1152,
          durationSeconds: null,
          frameRate: null,
          color: { space: null, ocioConfig: null, sceneLinear: null },
          alphaMode: "unknown",
        },
      }],
    }],
  };
  assert.deepEqual(normalizeStoryboard(JSON.parse(JSON.stringify(storyboard))), storyboard);
});

test("legacy storyboard frames receive unknown metadata and known metadata survives round trips", () => {
  const shots = normalizeStoryboard({
    version: 1,
    scenes: [{ id: "scene", shots: [
      { id: "legacy", frame: "data:image/png;base64,ZmFrZQ==" },
      {
        id: "known",
        frame: "data:image/png;base64,ZmFrZQ==",
        frameMetadata: {
          width: 1920,
          height: 1080,
          frameRate: { numerator: 24000, denominator: 1001 },
          color: { space: "ACEScg", ocioConfig: "studio-v1", sceneLinear: true },
          alphaMode: "straight",
        },
      },
    ] }],
  }).scenes[0].shots;
  assert.deepEqual(shots[0].frameMetadata, {
    width: null,
    height: null,
    durationSeconds: null,
    frameRate: null,
    color: { space: null, ocioConfig: null, sceneLinear: null },
    alphaMode: "unknown",
  });
  assert.equal(shots[0].prompt, "");
  assert.equal(shots[1].prompt, "");
  assert.equal(shots[1].frameMetadata.color.space, "ACEScg");
  assert.deepEqual(shots[1].frameMetadata.frameRate, { numerator: 24000, denominator: 1001 });
});

test("legacy repeated continuity blocks are extracted into a single global style bible", () => {
  const storyboard = normalizeStoryboard({
    version: 1,
    title: "Continuity",
    scenes: [{ id: "scene", shots: [
      { id: "shot-1", description: "A robot finds a seed.\n\nVisual style: Painterly sci-fi.\nCharacter continuity: UNIT-07." },
      { id: "shot-2", description: "A robot protects the seed.\n\nVisual style: Painterly sci-fi.\nCharacter continuity: UNIT-07.\nLocation continuity: Glass greenhouse." },
    ] }],
  });
  assert.equal(storyboard.scenes[0].shots[0].description.includes("Visual style:"), true);
  assert.deepEqual(storyboard.styleBible, {
    visualStyle: "Painterly sci-fi.",
    recurringCharacter: "UNIT-07.",
    recurringLocation: "Glass greenhouse.",
  });
});

test("malformed fields are ignored and all scene and shot IDs are unique", () => {
  const result = normalizeStoryboard({
    version: 1,
    title: "",
    aspectRatio: "unknown",
    scenes: [
      { id: "duplicate", title: "Scene", collapsed: true, shots: [
        { id: "duplicate", title: "Shot", shotType: "Invalid", cameraMove: "Invalid", durationSeconds: 0.3, frame: "https://example.test/image.png" },
        null,
      ] },
      { id: "duplicate", title: "", shots: [{ id: "duplicate", durationSeconds: 12.5 }] },
    ],
  });
  assert.equal(result.title, "Untitled storyboard");
  assert.equal(result.aspectRatio, "16:9");
  assert.equal(result.scenes[0].collapsed, true);
  assert.equal(result.scenes[1].title, "Scene 2");
  const ids = result.scenes.flatMap((scene) => [scene.id, ...scene.shots.map((shot) => shot.id)]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.scenes[0].shots[0].shotType, "");
  assert.equal(result.scenes[0].shots[0].cameraMove, "");
  assert.equal(result.scenes[0].shots[0].durationSeconds, null);
  assert.equal(result.scenes[0].shots[0].frame, null);
  assert.equal(result.scenes[1].shots[0].durationSeconds, 12.5);
});
