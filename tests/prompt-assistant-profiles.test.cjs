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
  return originalResolve.call(this, request.startsWith("@/") ? path.join(__dirname, "..", "src", request.slice(2)) : request, ...args);
};
const {
  findPromptAssistantTargets,
  promptAssistantTargetContext,
  validatePromptAssistantCandidate,
} = require("../src/lib/prompt-assistant-profiles.ts");
Module._resolveFilename = originalResolve;

const target = (type, model, task, promptExpansion = false) => ({ type, model, task, promptExpansion });
const wan = target("video/wan-3.0", "alibaba/wan-3.0", "image-to-video");
const v3 = target("video/kling", "kwaivgi/kling-v3.0-pro", "text-to-video");

test("resolves each model variant and task using only connected targets", () => {
  const cases = [
    ["video/wan-3.0", ["alibaba/wan-3.0", "alibaba/wan-3.0-prime"], ["text-to-video", "image-to-video", "reference-to-video"]],
    ["video/minimax-h3", ["minimax/h3", "minimax/h3-fast", "minimax/h3-max", "minimax/h3-max-turbo"], ["text-to-video", "image-to-video", "reference-to-video"]],
    ["image/flux-3", ["black-forest-labs/flux-3/edit"], ["text-to-image", "edit"]],
    ["video/flux-3", ["black-forest-labs/flux-3/text-to-video"], ["text-to-video", "image-to-video", "first-last-frame-to-video", "keyframes-to-video", "extend-video", "edit-video"]],
    ["video/kling", ["kwaivgi/kling-v4.0", "kwaivgi/kling-v3.0-pro", "kwaivgi/kling-v3.0-std"], ["text-to-video", "image-to-video"]],
    ["video/seedance", ["bytedance/seedance-2.5"], ["text-to-video", "image-to-video"]],
    ["video/veo", ["google/veo3.1"], ["text-to-video", "image-to-video", "reference-to-video"]],
    ["video/google-omni", ["google/gemini-omni-flash"], ["text-to-video", "image-to-video", "reference-to-video", "video-edit", "video-extend"]],
  ];
  for (const [type, models, tasks] of cases) for (const model of models) for (const task of tasks) {
    const result = promptAssistantTargetContext([target(type, model, task)]);
    assert.ok(result, `${type} ${model} ${task}`);
    assert.match(result.instructions, new RegExp(task));
    assert.equal(result.known.length, 1);
  }
  assert.match(promptAssistantTargetContext([target("image/flux-3", "", "edit")]).instructions, /image 1, image 2/);
  assert.match(promptAssistantTargetContext([target("video/minimax-h3", "minimax/h3", "text-to-video", true)]).instructions, /expansion is enabled/);
  const combined = promptAssistantTargetContext([wan, v3]);
  assert.equal(combined.maxLength, 2500);
  assert.match(combined.instructions, /compatible with every target/);
  assert.equal(promptAssistantTargetContext([target("unknown/model", "", "")]), null);
});

test("follows only prompt output to prompt inputs and reads current params", () => {
  const nodes = [
    { id: "wan", data: { type: wan.type, params: { model: wan.model, task: wan.task } } },
    { id: "kling", data: { type: v3.type, params: { model: v3.model, task: v3.task } } },
  ];
  const edges = [
    { source: "p", sourceHandle: "text", target: "wan", targetHandle: "prompt" },
    { source: "p", sourceHandle: "text", target: "kling", targetHandle: "image" },
  ];
  assert.deepEqual(findPromptAssistantTargets("p", nodes, edges), [wan]);
  nodes[0].data.params.task = "reference-to-video";
  assert.equal(findPromptAssistantTargets("p", nodes, edges)[0].task, "reference-to-video");
});

test("validates Ollama prompt replies before explicit application", () => {
  assert.equal(validatePromptAssistantCandidate(
    "Use @image_1 as the opening frame.",
    "Keep @image_1 and add a slow pan.",
    "Slowly pan from @image_1.",
    [wan],
  ), null);
  assert.match(validatePromptAssistantCandidate(
    "Use @image_1 as the opening frame.",
    "",
    "Slowly pan from @image_2.",
    [wan],
  ), /changed or invented a reference tag/);
  assert.match(validatePromptAssistantCandidate(
    "",
    "",
    "x".repeat(2501),
    [v3],
  ), /2500 characters/);
});
