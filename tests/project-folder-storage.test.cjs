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
  PROJECT_MANIFEST_FILE_NAME,
  readOrCreateProjectManifest,
} = require(path.join(__dirname, "..", "src", "lib", "project-folder-storage.ts"));

function createDirectoryHandle(files = new Map()) {
  return {
    name: "Test Project",
    files,
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) {
        const error = new Error("Missing file");
        error.name = "NotFoundError";
        throw error;
      }
      if (!files.has(name)) files.set(name, "");
      return {
        async getFile() {
          const text = files.get(name);
          return { text: async () => text };
        },
        async createWritable() {
          let text = "";
          return {
            write: async (value) => { text = String(value); },
            close: async () => { files.set(name, text); },
          };
        },
      };
    },
  };
}

test("creates a manifest in a new project folder", async () => {
  const handle = createDirectoryHandle();
  const result = await readOrCreateProjectManifest(handle);
  assert.equal(result.created, true);
  assert.equal(result.manifest.name, "Test Project");
  assert.deepEqual(result.manifest.assets, []);
  assert.equal(JSON.parse(handle.files.get(PROJECT_MANIFEST_FILE_NAME)).id, result.manifest.id);
});

test("opens and validates an existing manifest without overwriting it", async () => {
  const handle = createDirectoryHandle();
  const created = await readOrCreateProjectManifest(handle);
  const original = handle.files.get(PROJECT_MANIFEST_FILE_NAME);
  const opened = await readOrCreateProjectManifest(handle);
  assert.equal(opened.created, false);
  assert.deepEqual(opened.manifest, created.manifest);
  assert.equal(handle.files.get(PROJECT_MANIFEST_FILE_NAME), original);
});

test("surfaces malformed manifest data rather than replacing it", async () => {
  const handle = createDirectoryHandle(new Map([[PROJECT_MANIFEST_FILE_NAME, "{"]]));
  await assert.rejects(readOrCreateProjectManifest(handle), /contains invalid JSON/);
  assert.equal(handle.files.get(PROJECT_MANIFEST_FILE_NAME), "{");
});
