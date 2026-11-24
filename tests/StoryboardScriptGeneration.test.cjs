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
  buildGeminiStoryboardRequest,
  buildStoryboardChatMessages,
  extractGeminiStoryboardText,
  GEMINI_STORYBOARD_TEXT_MODEL,
  isStoryboardScriptProvider,
  STORYBOARD_SCRIPT_PROVIDERS,
} = require(path.join(__dirname, "..", "src", "lib", "storyboard-script-generation.ts"));
const { normalizeGeneratedStoryboard } = require(path.join(__dirname, "..", "src", "lib", "StoryboardScript.ts"));

test("script API options expose supported text providers and their keys", () => {
  assert.deepEqual(STORYBOARD_SCRIPT_PROVIDERS.map(({ id, apiKeyName }) => [id, apiKeyName]), [
    ["gemini", "GEMINI_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["atlas", "ATLASCLOUD_API_KEY"],
    ["topview-gpt", "TOPVIEW_API_KEY"],
    ["topview-claude", "TOPVIEW_API_KEY"],
  ]);
  assert.equal(isStoryboardScriptProvider("gemini"), true);
  assert.equal(isStoryboardScriptProvider("atlas"), true);
  assert.equal(isStoryboardScriptProvider("topview-claude"), true);
  assert.equal(isStoryboardScriptProvider("fal"), false);
  assert.equal(GEMINI_STORYBOARD_TEXT_MODEL, "gemini-3.8-flash");
});

test("chat storyboard prompt specifies a JSON-only shot list and wraps source text", () => {
  const messages = buildStoryboardChatMessages("SHOT 01 | NIGHT\nVISUAL: A robot waits.");
  assert.match(messages[0].content, /untrusted source material/);
  assert.match(messages[0].content, /single global styleBible object/);
  assert.match(messages[0].content, /only a valid JSON object/);
  assert.match(messages[0].content, /"styleBible"/);
  assert.match(messages[1].content, /<screenplay>\nSHOT 01 \| NIGHT/);
});

test("Gemini request asks for schema-constrained JSON and treats the screenplay as source text", () => {
  const request = buildGeminiStoryboardRequest("SHOT 01 | NIGHT\nVISUAL: A robot waits.");
  assert.match(request.system_instruction, /untrusted source material/);
  assert.match(request.input, /<screenplay>\nSHOT 01 \| NIGHT/);
  assert.equal(request.response_format.mime_type, "application/json");
  assert.equal(request.response_format.type, "text");
  assert.equal(request.generation_config.max_output_tokens, 12000);
  assert.equal(request.store, false);
  assert.equal(request.response_format.schema.required.includes("styleBible"), true);
  assert.equal(request.response_format.schema.properties.styleBible.required.includes("visualStyle"), true);
  const shotSchema = request.response_format.schema.properties.scenes.items.properties.shots.items;
  assert.equal(request.response_format.schema.properties.scenes.type, "array");
  assert.equal(shotSchema.properties.shotType.enum.includes(""), false);
  assert.equal(shotSchema.properties.cameraMove.enum.includes(""), false);
  assert.equal(shotSchema.required.includes("shotType"), true);
  assert.equal(shotSchema.required.includes("cameraMove"), true);
  assert.equal(shotSchema.required.includes("durationSeconds"), true);
  assert.equal(shotSchema.properties.durationSeconds.type, "number");
});

test("Gemini storyboard text extraction joins text parts and rejects missing output", () => {
  assert.equal(extractGeminiStoryboardText({
    steps: [{ type: "model_output", content: [
      { type: "text", text: '{"scenes":' },
      { type: "text", text: "[]}" },
    ] }],
  }), '{"scenes":[]}');
  assert.equal(extractGeminiStoryboardText({ steps: [] }), null);
  assert.equal(extractGeminiStoryboardText({ steps: [{ type: "model_output", content: [] }] }), null);
});

test("missing shot metadata is filled with practical defaults", () => {
  const result = normalizeGeneratedStoryboard({
    scenes: [{
      title: "EXT. GARDEN - DAWN",
      shots: [{
        title: "The sprout",
        description: "A seed opens in the morning light.",
        notes: "",
      }],
    }],
  });
  assert.equal(result.scenes[0].shots[0].shotType, "Wide");
  assert.equal(result.scenes[0].shots[0].cameraMove, "Static");
  assert.equal(result.scenes[0].shots[0].durationSeconds, 6);
});

test("shot metadata is inferred from descriptions when a model omits it", () => {
  const result = normalizeGeneratedStoryboard({
    scenes: [{
      title: "INT. GREENHOUSE - NIGHT",
      shots: [{
        title: "The lens",
        description: "Extreme close-up of the lens as the camera pushes in. Duration: 12s.",
      }],
    }],
  });
  assert.equal(result.scenes[0].shots[0].shotType, "Extreme close-up");
  assert.equal(result.scenes[0].shots[0].cameraMove, "Dolly in");
  assert.equal(result.scenes[0].shots[0].durationSeconds, 12);
});
