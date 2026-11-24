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
const { GET, POST } = require("../src/app/api/ollama-chat/route.ts");

const request = (body) => new Request("http://localhost/api/ollama-chat", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const tags = { models: [
  { name: "local:latest" },
  { name: "remote:cloud", remote_model: "remote" },
  { name: "other:latest", remote_host: "https://example.invalid" },
] };

test("lists only local models and sends bounded conversations to Ollama", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/api/tags") ? Response.json(tags)
      : Response.json({ message: { role: "assistant", content: " Hello! " } });
  };
  try {
    const list = await GET(new Request("http://localhost/api/ollama-chat"));
    assert.deepEqual(await list.json(), { models: ["local:latest"] });
    const messages = [{ role: "user", content: "Hello" }];
    const response = await POST(request({ model: "local:latest", messages }));
    assert.deepEqual(await response.json(), { content: "Hello!" });
    assert.equal(calls[2].url, "http://127.0.0.1:11434/api/chat");
    const requestBody = JSON.parse(calls[2].options.body);
    assert.equal(requestBody.model, "local:latest");
    assert.equal(requestBody.messages[0].role, "system");
    assert.match(requestBody.messages[0].content, /### SHOT 01/);
    assert.deepEqual(requestBody.messages.slice(1), messages);
    assert.equal(requestBody.stream, false);

    const longScript = [{ role: "user", content: "x".repeat(9385) }];
    const longResponse = await POST(request({ model: "local:latest", messages: longScript }));
    assert.equal(longResponse.status, 200);
    assert.equal(JSON.parse(calls[4].options.body).messages[1].content.length, 9385);

    const remote = await POST(request({ model: "remote:cloud", messages }));
    assert.equal(remote.status, 400);
    assert.equal(calls.length, 6);
  } finally {
    global.fetch = originalFetch;
  }
});

test("adds bounded text-only prompt context to local Ollama requests", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/api/tags") ? Response.json(tags)
      : Response.json({ message: { role: "assistant", content: "Updated prompt" } });
  };
  const promptContext = {
    currentPrompt: "A robot enters the greenhouse @image_1",
    imageSetup: ["First frame", "Reference images (2 connected)"],
    connectedTargets: [{
      type: "video/seedance",
      model: "bytedance/seedance-2.5",
      task: "image-to-video",
      promptExpansion: false,
    }],
  };
  try {
    const response = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Make the movement more subtle." }],
      promptContext,
    }));
    assert.equal(response.status, 200);
    const chatRequest = JSON.parse(calls[1].options.body);
    const system = chatRequest.messages[0].content;
    assert.match(system, /A robot enters the greenhouse @image_1/);
    assert.match(system, /First frame, Reference images \(2 connected\)/);
    assert.match(system, /Seedance 2\.5/);
    assert.match(system, /image files themselves are not provided/);
    assert.doesNotMatch(system, /data:image/);

    const invalid = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Help" }],
      promptContext: { ...promptContext, imageSetup: ["data:image/png;base64,private"] },
    }));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("adds active storyboard text and shot-number guidance to local chat", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/api/tags") ? Response.json(tags)
      : Response.json({ message: { role: "assistant", content: "Reviewing Shot 04." } });
  };
  const storyboardContext = JSON.stringify({
    title: "The Last Garden",
    aspectRatio: "16:9",
    shots: [{ shot: "Shot 04", scene: "The conservatory", description: "The robot discovers a seed." }],
  });
  try {
    const response = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Look at shot 04." }],
      storyboardContext,
    }));
    assert.equal(response.status, 200);
    const system = JSON.parse(calls[1].options.body).messages[0].content;
    assert.match(system, /Shot numbers are global across scenes/);
    assert.match(system, /The robot discovers a seed/);
    assert.match(system, /Description.*must be preserved/);
    assert.match(system, /current Prompt/);
    assert.match(system, /text descriptions and prompts plus shot metadata only/);
    assert.match(system, /fenced block labeled shot-prompt/);
    assert.doesNotMatch(system, /data:image/);

    const invalid = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Help" }],
      storyboardContext: "x".repeat(40001),
    }));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("uses the aspect-aware prompt assistant instructions and bounded workflow context", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const opening = "A painterly 3D sci-fi render, 9:16 portrait,";
  let assistantReply = [opening, ...Array(90 - opening.split(/\s+/).length).fill("detail")].join(" ");
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/api/tags") ? Response.json(tags)
      : Response.json({ message: { role: "assistant", content: assistantReply } });
  };
  try {
    const promptResponse = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Write a prompt for Shot 04." }],
      storyboardContext: "STORYBOARD ASPECT RATIO: 9:16\nREQUESTED SHOT 04:\nDESCRIPTION: A robot finds a seed.",
      storyboardMode: "prompt",
      storyboardAspectRatio: "9:16",
    }));
    assert.equal(promptResponse.status, 200);
    const promptSystem = JSON.parse(calls[1].options.body).messages[0].content;
    assert.match(promptSystem, /Start exactly with: "A painterly 3D sci-fi render, 9:16 portrait,"/);
    assert.match(promptSystem, /exactly one paragraph of 90-150 words/);
    assert.match(promptSystem, /never use animation or animated/);
    assert.match(promptSystem, /Never repeat or summarize it/);
    assert.match(promptSystem, /Plain-text reference for the requested shot/);
    assert.doesNotMatch(promptSystem, /"aspectRatio"\s*:/);

    assistantReply = "Workflow answer.";
    const workflowResponse = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "How is my workflow connected?" }],
      workflowContext: JSON.stringify({ nodes: [{ name: "Prompt", type: "input/prompt", settings: { text: "A robot" } }], connections: [] }),
    }));
    assert.equal(workflowResponse.status, 200);
    const workflowSystem = JSON.parse(calls[3].options.body).messages[0].content;
    assert.match(workflowSystem, /Active workflow graph context/);
    assert.match(workflowSystem, /A robot/);
    assert.match(workflowSystem, /omits media files, credentials/);

    const missingAspect = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Write a prompt." }],
      storyboardContext: "{}",
      storyboardMode: "prompt",
    }));
    assert.equal(missingAspect.status, 400);
    const oversizedWorkflow = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Help" }],
      workflowContext: "x".repeat(30001),
    }));
    assert.equal(oversizedWorkflow.status, 400);
    assert.equal(calls.length, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

test("retries malformed prompt output once and returns only the final message content", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const opening = "A painterly 3D sci-fi render, 16:9 widescreen,";
  const validPrompt = [opening, ...Array(90 - opening.split(/\s+/).length).fill("detail")].join(" ");
  let chatCount = 0;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/tags")) return Response.json(tags);
    chatCount += 1;
    return chatCount === 1
      ? Response.json({ message: {
        role: "assistant",
        content: `${opening}\n\`\`\`json\n{"shot":"Shot 05","prompt":""}\n\`\`\``,
        thinking: "Reasoning must not be used as the prompt.",
      } })
      : Response.json({ message: {
        role: "assistant",
        content: validPrompt,
        thinking: "JSON thoughts must not be returned.",
      } });
  };
  try {
    const response = await POST(request({
      model: "local:latest",
      messages: [{ role: "user", content: "Write a prompt for Shot 05." }],
      storyboardContext: "STORYBOARD ASPECT RATIO: 16:9\nREQUESTED SHOT 05:\nDESCRIPTION: A robot rests beside a seed cup.",
      storyboardMode: "prompt",
      storyboardAspectRatio: "16:9",
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.content, validPrompt);
    assert.equal(chatCount, 2);
    const retryMessages = JSON.parse(calls[2].options.body).messages;
    assert.match(retryMessages.at(-1).content, /Do not repeat or quote the rejected response/);
    assert.match(retryMessages[0].content, /Plain-text reference/);
    assert.doesNotMatch(JSON.stringify(retryMessages), /"shot":"Shot 05"/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects malformed, oversized and non-user-ending conversations without calling Ollama", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("Unexpected request"); };
  try {
    for (const messages of [[], [{ role: "system", content: "bad" }], [{ role: "assistant", content: "bad" }],
      [{ role: "user", content: "x".repeat(40001) }], Array(22).fill({ role: "user", content: "hi" }),
      Array(11).fill({ role: "user", content: "x".repeat(6000) })]) {
      assert.equal((await POST(request({ model: "local:latest", messages }))).status, 400);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("reports an unavailable Ollama server", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  global.fetch = async () => { throw new Error("Connection refused"); };
  console.error = () => {};
  try {
    const response = await GET(new Request("http://localhost/api/ollama-chat"));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Ollama.*running/);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});

test("surfaces Ollama errors and rejects empty responses", async () => {
  const originalFetch = global.fetch;
  let result = Response.json({ error: "Model cannot be loaded" }, { status: 500 });
  global.fetch = async (url) => url.endsWith("/api/tags") ? Response.json(tags) : result;
  try {
    const body = { model: "local:latest", messages: [{ role: "user", content: "Hi" }] };
    const failure = await POST(request(body));
    assert.equal(failure.status, 502);
    assert.deepEqual(await failure.json(), { error: "Model cannot be loaded" });
    result = Response.json({ message: { content: "" } });
    const empty = await POST(request(body));
    assert.equal(empty.status, 502);
    assert.match((await empty.json()).error, /empty/);
  } finally {
    global.fetch = originalFetch;
  }
});
