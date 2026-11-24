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
const { createOllamaWorkflowContext } = require("../src/lib/ollama-workflow-context.ts");

test("workflow help context includes graph settings but omits media and credential values", () => {
  const context = createOllamaWorkflowContext([
    { id: "prompt-1", data: { type: "input/prompt", title: "Main prompt", params: {
      text: "A robot enters the greenhouse.",
      image_url: "data:image/png;base64,private",
      enable_prompt_expansion: true,
      quality: { preset: "high", api_key: "nested-secret", endpoint: "https://example.invalid/api" },
    } } },
    { id: "video-1", data: { type: "video/seedance", params: {
      model: "bytedance/seedance-2.5",
      task: "image-to-video",
      api_key: "secret-key",
      first_frame: "https://example.invalid/frame.png",
    } } },
  ], [{ source: "prompt-1", sourceHandle: "text", target: "video-1", targetHandle: "prompt" }],
  "workflow-1", "scope-1");

  assert.match(context.text, /A robot enters the greenhouse/);
  assert.match(context.text, /bytedance\/seedance-2\.5/);
  assert.match(context.text, /Main prompt/);
  assert.match(context.text, /image-to-video/);
  assert.match(context.text, /"preset":"high"/);
  assert.match(context.text, /"from":"Main prompt","output":"text","to":"video\/seedance/);
  assert.doesNotMatch(context.text, /data:image|example\.invalid|secret-key|nested-secret/);
  assert.equal(context.tooLong, false);
});

test("marks an oversized workflow context instead of silently truncating it", () => {
  const context = createOllamaWorkflowContext([
    { id: "prompt-1", data: { type: "input/prompt", params: { text: "x".repeat(30001) } } },
  ], [], "workflow-1", "scope-1");
  assert.equal(context.tooLong, true);
});
