/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { GET, POST } = require("../src/app/api/setup/route.ts");

function setupRequest(body, url = "http://localhost:3000/api/setup") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(url).origin, Host: new URL(url).host },
    body: JSON.stringify(body),
  });
}

test("local API setup saves keys without replacing unrelated environment settings", async () => {
  const originalCwd = process.cwd();
  const originalNodeEnv = process.env.NODE_ENV;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fal-flow-api-setup-"));
  process.chdir(directory);
  process.env.NODE_ENV = "development";
  fs.writeFileSync(".env.local", "KEEP_ME=value\nOPENAI_API_KEY=old-key\n");

  try {
    const secret = 'new$key"with-quotes';
    const response = await POST(setupRequest({ OPENAI_API_KEY: secret, ATLASCLOUD_API_KEY: "atlas-key" }));
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.clone().text(), /new\$key|atlas-key/);

    const file = fs.readFileSync(".env.local", "utf8");
    assert.match(file, /KEEP_ME=value/);
    assert.match(file, /OPENAI_API_KEY="new\\\$key\\"with-quotes"/);
    assert.match(file, /ATLASCLOUD_API_KEY="atlas-key"/);
    assert.doesNotMatch(file, /OPENAI_API_KEY=old-key/);
  } finally {
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local API setup rejects non-loopback hosts and invalid key values", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const remote = await POST(setupRequest({ OPENAI_API_KEY: "secret" }, "http://192.168.1.5:3000/api/setup"));
    assert.equal(remote.status, 403);

    const invalid = await POST(setupRequest({ OPENAI_API_KEY: "first\nSECOND=value" }));
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /invalid characters/i);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("production API-key setup stays disabled outside the desktop app", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDesktopMode = process.env.FAL_FLOW_DESKTOP;
  process.env.NODE_ENV = "production";
  delete process.env.FAL_FLOW_DESKTOP;
  try {
    const url = "http://localhost:3000/api/setup";
    const status = await GET(new Request(url, { headers: { Host: new URL(url).host } }));
    const save = await POST(setupRequest({ OPENAI_API_KEY: "secret" }, url));
    assert.equal(status.status, 404);
    assert.equal(save.status, 404);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDesktopMode === undefined) delete process.env.FAL_FLOW_DESKTOP;
    else process.env.FAL_FLOW_DESKTOP = originalDesktopMode;
  }
});

test("desktop API setup stores keys in the current user's settings folder", async () => {
  const names = [
    "NODE_ENV",
    "FAL_FLOW_DESKTOP",
    "FAL_FLOW_USER_DATA_PATH",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "ATLASCLOUD_API_KEY",
    "FAL_KEY",
  ];
  const originalValues = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fal-flow-desktop-keys-"));
  process.env.NODE_ENV = "production";
  process.env.FAL_FLOW_DESKTOP = "1";
  process.env.FAL_FLOW_USER_DATA_PATH = directory;
  for (const name of names.slice(3)) delete process.env[name];

  try {
    const url = "http://127.0.0.1:43210/api/setup";
    const remote = await POST(setupRequest(
      { OPENAI_API_KEY: "remote-key" },
      "http://192.168.1.5:43210/api/setup",
    ));
    assert.equal(remote.status, 403);

    const response = await POST(setupRequest({ OPENAI_API_KEY: "user-openai-key" }, url));
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.clone().text(), /user-openai-key/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "api-keys.json"), "utf8")), {
      OPENAI_API_KEY: "user-openai-key",
      GEMINI_API_KEY: "",
      ATLASCLOUD_API_KEY: "",
      FAL_KEY: "",
    });
    assert.equal(process.env.OPENAI_API_KEY, "user-openai-key");

    const status = await GET(new Request(url, { headers: { Host: new URL(url).host } }));
    assert.equal(status.status, 200);
    assert.equal((await status.json()).configured.OPENAI_API_KEY, true);
  } finally {
    for (const name of names) {
      if (originalValues[name] === undefined) delete process.env[name];
      else process.env[name] = originalValues[name];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
