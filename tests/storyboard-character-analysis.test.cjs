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
  findStoryboardCharacterNameHints,
  normalizeStoryboardCharacterAnalysis,
} = require(path.join(
  __dirname, "..", "src", "lib", "storyboard-character-analysis.ts",
));
const { POST } = require(path.join(
  __dirname, "..", "src", "app", "api", "storyboard", "analyze-characters", "route.ts",
));

const script = [
  "INT. LAB - NIGHT",
  "SHOT 01",
  "MARA enters the lab.",
  "MARA: I found the map.",
].join("\n");
const characterResponse = {
  characters: [{
    name: "MARA",
    aliases: [],
    visualDescription: "",
    evidence: ["MARA enters the lab."],
    appearances: [{
      reference: "Shot 01 | INT. LAB - NIGHT",
      evidence: "MARA enters the lab.",
    }],
  }],
};

function post(body) {
  return POST(new Request("http://localhost/api/storyboard/analyze-characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("normalizes exact script evidence and numbered appearance references", () => {
  assert.deepEqual(normalizeStoryboardCharacterAnalysis(characterResponse, script), {
    characters: [{
      name: "MARA",
      aliases: [],
      visualDescription: "",
      evidence: ["MARA enters the lab."],
      appearances: [{
        shotNumber: 1,
        sceneHeading: "INT. LAB - NIGHT",
        evidence: "MARA enters the lab.",
      }],
    }],
  });
});

test("finds likely character IDs and screenplay dialogue cues with exact evidence", () => {
  const hints = findStoryboardCharacterNameHints([
    "INT. LAB - NIGHT",
    "SHOT 01 | LAB | DURATION: 6s",
    "VISUAL: UNIT-07 enters the lab.",
    "SHOT 02 | LAB | DURATION: 6s",
    "VISUAL: Unit-07 scans the doorway.",
    "",
    "MARA (V.O.)",
    "I found the map.",
  ].join("\n"));

  assert.deepEqual(hints, [
    {
      name: "UNIT-07",
      evidence: [
        "VISUAL: UNIT-07 enters the lab.",
        "VISUAL: Unit-07 scans the doorway.",
      ],
    },
    {
      name: "MARA",
      evidence: ["MARA (V.O.)\nI found the map."],
    },
  ]);
});

test("rejects malformed, unverified, and out-of-range character details", () => {
  assert.throws(() => normalizeStoryboardCharacterAnalysis(null, script), /invalid character list/i);
  assert.throws(() => normalizeStoryboardCharacterAnalysis({
    characters: [{ ...characterResponse.characters[0], evidence: ["MARA is a pilot."] }],
  }, script), /unverified evidence/i);
  assert.throws(() => normalizeStoryboardCharacterAnalysis({
    characters: [{ ...characterResponse.characters[0], appearances: [{
      reference: "Shot 121",
      evidence: "MARA enters the lab.",
    }] }],
  }, script), /out-of-range shot reference/i);
});

test("uses only a verified local Ollama model and returns validated character candidates", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url).endsWith("/api/tags")
      ? Response.json({ models: [{ name: "local:latest" }, { name: "remote:cloud", remote_model: "remote" }] })
      : Response.json({ message: { content: JSON.stringify(characterResponse) } });
  };
  try {
    const response = await post({ script, model: "local:latest" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), normalizeStoryboardCharacterAnalysis(characterResponse, script));
    const requestBody = JSON.parse(calls[1].options.body);
    assert.equal(requestBody.model, "local:latest");
    assert.equal(requestBody.options.temperature, 0);
    assert.equal(requestBody.stream, false);
    assert.match(requestBody.messages[0].content, /untrusted source material/i);
    assert.match(requestBody.messages[1].content, /MARA enters the lab/);
    assert.equal(requestBody.format.type, "object");

    const rejected = await post({ script, model: "remote:cloud" });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rechecks an empty result once to catch named subjects in shot lists", async () => {
  const originalFetch = global.fetch;
  const unitScript = [
    "SHOT 01 | GREENHOUSE | DURATION: 6s",
    "VISUAL: UNIT-07 rolls down the greenhouse aisle.",
  ].join("\n");
  const unitResponse = {
    characters: [{
      name: "UNIT-07",
      aliases: [],
      visualDescription: "",
      evidence: ["UNIT-07 rolls down the greenhouse aisle."],
      appearances: [{
        reference: "Shot 01 | GREENHOUSE",
        evidence: "UNIT-07 rolls down the greenhouse aisle.",
      }],
    }],
  };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/tags")) {
      return Response.json({ models: [{ name: "local:latest" }] });
    }
    return Response.json({
      message: { content: calls.filter((call) => call.url.endsWith("/api/chat")).length === 1
        ? JSON.stringify({ characters: [] })
        : JSON.stringify(unitResponse) },
    });
  };
  try {
    const response = await post({ script: unitScript, model: "local:latest" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), normalizeStoryboardCharacterAnalysis(unitResponse, unitScript));
    const chatCalls = calls.filter((call) => call.url.endsWith("/api/chat"));
    assert.equal(chatCalls.length, 2);
    const retryBody = JSON.parse(chatCalls[1].options.body);
    assert.match(retryBody.messages.at(-1).content, /previous response returned an empty/i);
    assert.match(retryBody.messages.at(-1).content, /robot or other non-human subject/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects oversized scripts before contacting local Ollama", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("Ollama should not be called");
  };
  try {
    const response = await post({ script: "x".repeat(40001), model: "local:latest" });
    assert.equal(response.status, 400);
  } finally {
    global.fetch = originalFetch;
  }
});
