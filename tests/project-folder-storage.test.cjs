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
  addMediaToProjectFolder,
  loadProjectVideoEditorState,
  PROJECT_MANIFEST_FILE_NAME,
  chooseProjectMediaFiles,
  readProjectMediaAssetFile,
  readProjectMediaFile,
  readOrCreateProjectManifest,
  saveProjectVideoEditorState,
} = require(path.join(__dirname, "..", "src", "lib", "project-folder-storage.ts"));
const { createProjectVideoEditorState, PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME } = require(
  path.join(__dirname, "..", "src", "lib", "project-video-editor.ts"),
);

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

function createMemoryDirectoryHandle() {
  const files = new Map();
  const directories = new Set([""]);
  const createHandle = (directoryPath, name) => ({
    name,
    async getDirectoryHandle(childName, options = {}) {
      const childPath = [directoryPath, childName].filter(Boolean).join("/");
      if (!directories.has(childPath) && !options.create) {
        const error = new Error("Missing directory");
        error.name = "NotFoundError";
        throw error;
      }
      directories.add(childPath);
      return createHandle(childPath, childName);
    },
    async getFileHandle(fileName, options = {}) {
      const filePath = [directoryPath, fileName].filter(Boolean).join("/");
      if (!files.has(filePath) && !options.create) {
        const error = new Error("Missing file");
        error.name = "NotFoundError";
        throw error;
      }
      return {
        async getFile() {
          const contents = files.get(filePath);
          const blob = contents instanceof Blob ? contents : new Blob([contents ?? ""]);
          return new File([blob], fileName, { type: blob.type });
        },
        async createWritable() {
          let contents;
          return {
            write: async (value) => { contents = value; },
            close: async () => { files.set(filePath, contents); },
          };
        },
      };
    },
  });
  return { ...createHandle("", "Test Project"), files, directories };
}

test("creates a manifest in a new project folder", async () => {
  const handle = createDirectoryHandle();
  const result = await readOrCreateProjectManifest(handle);
  assert.equal(result.created, true);
  assert.equal(result.manifest.name, "Test Project");
  assert.deepEqual(result.manifest.assets, []);
  assert.equal(JSON.parse(handle.files.get(PROJECT_MANIFEST_FILE_NAME)).id, result.manifest.id);
});

test("starts the media picker in the project folder and returns selected files", async () => {
  const projectFolder = { name: "Test Project" };
  const selectedFile = new File(["video"], "clip.mp4", { type: "video/mp4" });
  const previousWindow = global.window;
  let pickerOptions;
  global.window = {
    showOpenFilePicker: async (options) => {
      pickerOptions = options;
      return [{ getFile: async () => selectedFile }];
    },
  };
  try {
    assert.deepEqual(await chooseProjectMediaFiles(projectFolder), [selectedFile]);
    assert.equal(pickerOptions.multiple, true);
    assert.equal(pickerOptions.startIn, projectFolder);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test("reports when the project-aware picker is unavailable for input fallback", async () => {
  const previousWindow = global.window;
  global.window = {};
  try {
    assert.equal(await chooseProjectMediaFiles({ name: "Test Project" }), null);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
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

test("copies shared media into the project and restores it using the manifest path", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const asset = {
    id: "media-1",
    name: "Portrait clip",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "media-1" },
    metadata: {
      width: 240,
      height: 320,
      durationSeconds: 1.5,
      frameRate: null,
      color: { space: null, ocioConfig: null, sceneLinear: null },
      alphaMode: "unknown",
    },
  };
  const updated = await addMediaToProjectFolder(
    handle,
    manifest,
    asset,
    new File(["video bytes"], "portrait.mp4", { type: "video/mp4" }),
  );
  const projectAsset = updated.assets[0];
  assert.match(projectAsset.relativePath, /^Media\/Originals\/[0-9a-f-]+-portrait\.mp4$/i);
  assert.equal(projectAsset.sizeBytes, 11);

  const restored = await readProjectMediaFile(handle, projectAsset);
  assert.equal(restored.name, asset.name);
  assert.equal(restored.type, "video/mp4");
  assert.equal(await restored.text(), "video bytes");
  assert.equal(await (await readProjectMediaAssetFile(handle, updated.id, asset.id)).text(), "video bytes");

  const reopened = await readOrCreateProjectManifest(handle);
  assert.deepEqual(reopened.manifest.assets, updated.assets);
});

test("preserves all media copied sequentially into a project", async () => {
  const handle = createMemoryDirectoryHandle();
  let { manifest } = await readOrCreateProjectManifest(handle);
  for (const id of ["media-first", "media-second"]) {
    manifest = await addMediaToProjectFolder(handle, manifest, {
      id,
      name: `${id}.mp4`,
      mediaKind: "video",
      mimeType: "video/mp4",
      source: { kind: "storage", storageKey: id },
      metadata: {},
    }, new File([id], `${id}.mp4`, { type: "video/mp4" }));
  }
  assert.deepEqual(manifest.assets.map((asset) => asset.id), ["media-first", "media-second"]);
  assert.equal(await (await readProjectMediaFile(handle, manifest.assets[0])).text(), "media-first");
  assert.equal(await (await readProjectMediaFile(handle, manifest.assets[1])).text(), "media-second");
});

test("reports project media files that are missing from disk", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const asset = {
    id: "media-2",
    name: "Missing clip",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "media-2" },
    metadata: {},
  };
  const updated = await addMediaToProjectFolder(
    handle,
    manifest,
    asset,
    new File(["clip"], "missing.mp4", { type: "video/mp4" }),
  );
  handle.files.delete(updated.assets[0].relativePath);
  await assert.rejects(readProjectMediaFile(handle, updated.assets[0]), /is missing/);
});

test("saves and reloads the project timeline document", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const asset = {
    id: "timeline-source",
    name: "Timeline source",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "timeline-source" },
    metadata: {
      width: 240,
      height: 320,
      durationSeconds: 1.5,
      frameRate: null,
      color: { space: null, ocioConfig: null, sceneLinear: null },
      alphaMode: "unknown",
    },
  };
  const projectManifest = await addMediaToProjectFolder(
    handle,
    manifest,
    asset,
    new File(["project clip"], "clip.mp4", { type: "video/mp4" }),
  );
  const initial = createProjectVideoEditorState(projectManifest);
  initial.sequences[0].clips.push({
    id: "clip-1",
    name: asset.name,
    mediaId: asset.id,
    duration: 1.5,
    trimStart: 0,
    trimEnd: 1.5,
    projectAssetId: asset.id,
  });
  initial.sequences[0].selectedId = "clip-1";
  initial.sequences[0].playheadTime = 0.75;

  await saveProjectVideoEditorState(handle, projectManifest.id, initial);
  const restored = await loadProjectVideoEditorState(handle, projectManifest.id);
  const restoredMedia = await readProjectMediaAssetFile(handle, projectManifest.id, asset.id);

  assert.equal(restored.sequences[0].clips[0].projectAssetId, asset.id);
  assert.equal(restored.sequences[0].clips[0].trimEnd, 1.5);
  assert.equal(restored.sequences[0].playheadTime, 0.75);
  assert.equal(await restoredMedia.text(), "project clip");
  assert.equal(
    JSON.parse(handle.files.get(PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME)).projectId,
    projectManifest.id,
  );
});
