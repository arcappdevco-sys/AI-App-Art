const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

// Load the existing TypeScript modules without adding a separate test runner.
require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const lib = (name) => require(path.join(__dirname, "..", "src", "lib", `${name}.ts`));
const { runGraph } = lib("executor");
const { validateWorkflow } = lib("workflow-validation");
const { WAN_DEFAULTS, WAN_NODE_TYPE } = lib("wan");
const { MINIMAX_DEFAULTS, MINIMAX_NODE_TYPE } = lib("minimax");
const { FLUX3_DEFAULTS, FLUX3_NODE_TYPE } = lib("flux3");
const { FLUX3_VIDEO_DEFAULTS, FLUX3_VIDEO_NODE_TYPE } = lib("flux3-video");

test("workflow runs fresh Atlas generations, propagates outputs, and isolates failures", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  let submissions = [];
  let failureAction = "";
  let id = 0;
  let submissionsAtFirstPoll;
  global.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(delay, 1), ...args);
  global.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      const request = JSON.parse(options.body);
      submissions.push(request);
      if (request.action === failureAction) return Response.json({ error: "Simulated failure" }, { status: 402 });
      return Response.json({ predictionId: `prediction${++id}`, status: "created" });
    }
    if (submissionsAtFirstPoll === undefined) submissionsAtFirstPoll = submissions.map((entry) => entry.action);
    return Response.json({ data: { status: "completed", outputs: [`https://example.com/${new URL(url, "http://localhost").searchParams.get("prediction_id")}.mp4`] } });
  };
  try {
    const nodes = [
      { id: "p", type: "input/prompt", params: { text: "A dragon" } },
      { id: "wan", type: WAN_NODE_TYPE, params: { ...WAN_DEFAULTS } },
      { id: "mini", type: MINIMAX_NODE_TYPE, params: { ...MINIMAX_DEFAULTS } },
      { id: "image", type: FLUX3_NODE_TYPE, params: { ...FLUX3_DEFAULTS } },
      { id: "video", type: FLUX3_VIDEO_NODE_TYPE, params: { ...FLUX3_VIDEO_DEFAULTS, task: "image-to-video" } },
    ];
    const graph = {
      nodes,
      edges: [
        ...nodes.slice(1).map((node) => ({ source: "p", sourceHandle: "text", target: node.id, targetHandle: "prompt" })),
        { source: "image", sourceHandle: "image", target: "video", targetHandle: "image" },
      ],
    };
    const cache = new Map(), params = {}, outputs = {}, statuses = {};
    const options = {
      cache, fresh: true,
      onStatus: (nodeId, status, info) => { statuses[nodeId] = [status, info]; },
      onOutput: (nodeId, value) => { outputs[nodeId] = value; },
      onParams: (nodeId, patch) => { params[nodeId] = { ...params[nodeId], ...patch }; },
    };
    assert.equal(validateWorkflow(graph).filter((issue) => issue.severity === "error").length, 0);
    await runGraph(graph, options);
    assert.deepEqual(submissions.map((entry) => entry.action).sort(),
      ["generate", "minimax_generate", "flux3_generate", "flux3_video_generate"].sort());
    assert.deepEqual(submissionsAtFirstPoll.sort(), ["generate", "minimax_generate", "flux3_generate"].sort());
    for (const nodeId of ["wan", "mini", "image", "video"]) {
      assert.equal(statuses[nodeId][0], "done", `${nodeId}: ${statuses[nodeId]}`);
      assert.match(params[nodeId].prediction_id, /^prediction/);
      assert.equal(params[nodeId].last_status, "completed");
      assert.ok(outputs[nodeId].image || outputs[nodeId].video);
    }
    assert.equal(submissions.find((entry) => entry.action === "flux3_video_generate").body.image_url, outputs.image.image);

    submissions = [];
    await runGraph(graph, options);
    assert.equal(submissions.length, 4, "a second workflow run submits all generators again");
    assert.equal(submissions.find((entry) => entry.action === "flux3_video_generate").body.image_url, outputs.image.image);

    submissions = [];
    failureAction = "minimax_generate";
    await runGraph(graph, options);
    assert.equal(statuses.mini[0], "error");
    assert.match(statuses.mini[1], /Simulated failure/);
    assert.equal(statuses.video[0], "done", "an unrelated failed branch does not block generation");

    submissions = [];
    failureAction = "flux3_generate";
    await runGraph(graph, options);
    assert.equal(statuses.image[0], "error");
    assert.match(statuses.video[1], /upstream node failed/);
    assert.equal(submissions.some((entry) => entry.action === "flux3_video_generate"), false);
    assert.equal(statuses.mini[0], "done");
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

test("stopping a submitted Atlas job retains its prediction ID for resuming", async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  const patches = [];
  const statuses = {};
  global.fetch = async (url, options = {}) => {
    assert.equal(options.method, "POST", "stopped jobs must not start polling");
    return Response.json({ predictionId: "resumable", status: "created" });
  };
  try {
    const graph = {
      nodes: [
        { id: "p", type: "input/prompt", params: { text: "A dragon" } },
        { id: "v", type: FLUX3_VIDEO_NODE_TYPE, params: { ...FLUX3_VIDEO_DEFAULTS } },
      ],
      edges: [{ source: "p", sourceHandle: "text", target: "v", targetHandle: "prompt" }],
    };
    await runGraph(graph, {
      cache: new Map(), fresh: true, signal: controller.signal,
      onStatus: (id, status, info) => { statuses[id] = [status, info]; },
      onOutput: () => {},
      onParams: (id, patch) => { patches.push(patch); controller.abort(); },
    });
    assert.equal(patches[0].prediction_id, "resumable");
    assert.equal(statuses.v[0], "error");
    assert.match(statuses.v[1], /still be billed.*Resume checking/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("local uploads and multiple reference images are passed to both generators", async () => {
      const originalFetch = global.fetch;
      const originalSetTimeout = global.setTimeout;
      const submissions = [];
      let uploads = 0;
      global.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(delay, 1), ...args);
      global.fetch = async (url, options = {}) => {
        if (options.body instanceof FormData) {
          uploads++;
          return Response.json({ url: `https://example.com/upload-${uploads}.png` });
        }
        if (options.method === "POST") {
          submissions.push(JSON.parse(options.body));
          return Response.json({ predictionId: `prediction${submissions.length}`, status: "created" });
        }
        return Response.json({ data: { status: "completed", outputs: ["https://example.com/output.png"] } });
      };
      try {
        const graph = {
          nodes: [
            { id: "p", type: "input/prompt", params: { text: "Edit" } },
            { id: "i1", type: "input/image", params: { url: "data:image/png;base64,YQ==" } },
            { id: "i2", type: "input/image", params: { url: "https://example.com/remote.png" } },
            { id: "f", type: FLUX3_NODE_TYPE, params: { ...FLUX3_DEFAULTS, task: "edit" } },
            { id: "m", type: MINIMAX_NODE_TYPE, params: { ...MINIMAX_DEFAULTS, task: "reference-to-video" } },
          ],
          edges: [
            ...["f", "m"].map((target) => ({ source: "p", sourceHandle: "text", target, targetHandle: "prompt" })),
            ...["i1", "i2"].flatMap((source) => [
              { source, sourceHandle: "image", target: "f", targetHandle: "reference_images" },
              { source, sourceHandle: "image", target: "m", targetHandle: "references" },
            ]),
          ],
        };
        const statuses = {};
        await runGraph(graph, {
          cache: new Map(), fresh: true,
          onStatus: (id, status, info) => { statuses[id] = [status, info]; },
          onOutput: () => {},
        });

        assert.equal(statuses.f[0], "done", String(statuses.f));
        assert.equal(statuses.m[0], "done", String(statuses.m));
        const imageRequest = submissions.find((entry) => entry.action === "flux3_generate").body;
        const videoRequest = submissions.find((entry) => entry.action === "minimax_generate").body;
        assert.equal(uploads, 2);
        assert.equal(imageRequest.reference_images.length, 2);
        assert.equal(videoRequest.refers.length, 2);
        assert.equal(imageRequest.reference_images[1], "https://example.com/remote.png");
        assert.equal(videoRequest.refers[1].url, "https://example.com/remote.png");
      } finally {
        global.fetch = originalFetch;
        global.setTimeout = originalSetTimeout;
      }
});

test("full workflow reruns other AI image generators instead of using cache", async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async (url) => {
    assert.equal(url, "/api/gemini");
    requests++;
    return Response.json({ image: `https://example.com/image-${requests}.png` });
  };
  try {
    const graph = {
      nodes: [
        { id: "p", type: "input/prompt", params: { text: "A dragon" } },
        { id: "g", type: "google/gemini-image", params: { model: "Nano Banana", aspect_ratio: "1:1" } },
      ],
      edges: [{ source: "p", sourceHandle: "text", target: "g", targetHandle: "prompt" }],
    };
    const cache = new Map(), outputs = {};
    const options = { cache, fresh: true, onStatus: () => {}, onOutput: (id, value) => { outputs[id] = value; } };
    await runGraph(graph, options);
    await runGraph(graph, options);
    assert.equal(requests, 2);
    assert.equal(outputs.g.image, "https://example.com/image-2.png");
  } finally {
    global.fetch = originalFetch;
  }
});

test("workflow rejects Wan images with transparency before upload or generation", async () => {
  const originalFetch = global.fetch;
  const originalBitmap = global.createImageBitmap;
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error("Unexpected request"); };
  global.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });
  try {
    const bytes = Buffer.alloc(26);
    bytes[25] = 6;
    const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
    const graph = {
      nodes: [
        { id: "p", type: "input/prompt", params: { text: "A dragon" } },
        { id: "i", type: "input/image", params: { url: dataUrl } },
        { id: "w", type: WAN_NODE_TYPE, params: { ...WAN_DEFAULTS, task: "image-to-video" } },
      ],
      edges: [
        { source: "p", sourceHandle: "text", target: "w", targetHandle: "prompt" },
        { source: "i", sourceHandle: "image", target: "w", targetHandle: "image" },
      ],
    };
    const statuses = {};
    await runGraph(graph, {
      cache: new Map(), fresh: true,
      onStatus: (id, status, info) => { statuses[id] = [status, info]; },
      onOutput: () => {},
    });
    assert.equal(statuses.w[0], "error");
    assert.match(statuses.w[1], /transparency/);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    global.createImageBitmap = originalBitmap;
  }
});
