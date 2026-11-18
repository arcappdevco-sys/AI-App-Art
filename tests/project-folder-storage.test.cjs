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
  backupProjectFolder,
  loadProjectCompositorState,
  loadProjectWorkspaceState,
  loadProjectVideoEditorState,
  PROJECT_MANIFEST_FILE_NAME,
  chooseProjectMediaFiles,
  readProjectMediaAssetFile,
  readProjectMediaFile,
  readOrCreateProjectManifest,
  saveProjectCompositorState,
  saveProjectWorkspaceState,
  saveProjectVideoEditorState,
} = require(path.join(__dirname, "..", "src", "lib", "project-folder-storage.ts"));
const { PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME } = require(
  path.join(__dirname, "..", "src", "lib", "project-compositor.ts"),
);
const { createProjectVideoEditorState, PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME } = require(
  path.join(__dirname, "..", "src", "lib", "project-video-editor.ts"),
);
const { PROJECT_WORKSPACE_DOCUMENT_FILE_NAME } = require(
  path.join(__dirname, "..", "src", "lib", "project-workspace.ts"),
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
  const rootId = {};
  const createFileHandle = (filePath, fileName) => ({
    kind: "file",
    name: fileName,
    path: filePath,
    async isSameEntry(other) { return other.rootId === rootId && other.path === filePath; },
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
  });
  const createHandle = (directoryPath, name) => ({
    kind: "directory",
    name,
    path: directoryPath,
    rootId,
    async isSameEntry(other) { return other.rootId === rootId && other.path === directoryPath; },
    async *values() {
      const prefix = directoryPath ? `${directoryPath}/` : "";
      const childDirectories = [...directories].filter((candidate) => candidate !== directoryPath
        && candidate.startsWith(prefix)
        && !candidate.slice(prefix.length).includes("/"));
      const childFiles = [...files.keys()].filter((candidate) => candidate.startsWith(prefix)
        && !candidate.slice(prefix.length).includes("/"));
      for (const childPath of childDirectories) {
        const childName = childPath.slice(prefix.length);
        yield createHandle(childPath, childName);
      }
      for (const filePath of childFiles) {
        const fileName = filePath.slice(prefix.length);
        yield createFileHandle(filePath, fileName);
      }
    },
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
      return createFileHandle(filePath, fileName);
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

test("starts the media picker in the project folder and supports single or multiple selection", async () => {
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
    assert.deepEqual(await chooseProjectMediaFiles(projectFolder, false), [selectedFile]);
    assert.equal(pickerOptions.multiple, false);
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

test("saves and reloads the project compositor graph, settings, and media references", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const mediaAsset = {
    id: "compositor-source",
    name: "Composite source",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "compositor-source" },
    metadata: {},
  };
  const projectManifest = await addMediaToProjectFolder(
    handle,
    manifest,
    mediaAsset,
    new File(["video"], "source.mp4", { type: "video/mp4" }),
  );
  const state = {
    nodes: [
      { id: "media-node", type: "comp", position: { x: 10, y: 20 },
        data: { kind: "media", label: "Media", params: {} } },
      { id: "viewer-node", type: "comp", position: { x: 300, y: 20 },
        data: { kind: "viewer", label: "Viewer", params: {} } },
    ],
    edges: [{ id: "media-viewer", source: "media-node", target: "viewer-node", targetHandle: "image" }],
    mediaRefs: { "media-node": mediaAsset.id },
    mediaMetadata: { "media-node": { width: 640, height: 360 } },
    tracks: { "media-node": [{ time: 0, x: 320, y: 180, confidence: 1 }] },
    marks: { inPoint: 0.25, outPoint: 1.25 },
    time: 0.75,
    viewerTransform: { zoom: 1.5, x: 12, y: -4 },
    previewBackground: "color",
    previewColor: "#123456",
    viewChannel: "alpha",
  };

  await saveProjectCompositorState(handle, projectManifest.id, state);
  const restored = await loadProjectCompositorState(handle, projectManifest.id);

  assert.deepEqual(restored, {
    ...state,
    mediaMetadata: {
      "media-node": {
        width: 640,
        height: 360,
        durationSeconds: null,
        frameRate: null,
        color: { space: null, ocioConfig: null, sceneLinear: null },
        alphaMode: "unknown",
      },
    },
  });
  assert.equal(JSON.parse(handle.files.get(PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME)).projectId, projectManifest.id);
  await assert.rejects(saveProjectCompositorState(handle, projectManifest.id, {
    ...state,
    mediaRefs: { "media-node": "not-in-the-project" },
  }), /is not in this project/);
});

test("saves and reloads the project workflow library and active workflow", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const state = {
    version: 1,
    activeWorkflowId: "workflow-two",
    workflows: [
      { id: "workflow-one", name: "First", storyboard: { scenes: [] } },
      { id: "workflow-two", name: "Second", storyboard: { scenes: [{ id: "scene-1" }] } },
    ],
  };

  await saveProjectWorkspaceState(handle, manifest.id, state);

  assert.deepEqual(await loadProjectWorkspaceState(handle, manifest.id), state);
  assert.equal(
    JSON.parse(handle.files.get(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME)).projectId,
    manifest.id,
  );
});

test("returns null when the project workflow document has not been created", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  assert.equal(await loadProjectWorkspaceState(handle, manifest.id), null);
});

test("rejects invalid or mismatched project workflow documents without replacing them", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const invalid = JSON.stringify({
    format: "fal-flow-workspace",
    schemaVersion: 1,
    projectId: manifest.id,
    updatedAt: new Date().toISOString(),
    state: { version: 1, activeWorkflowId: "missing", workflows: [{ id: "workflow-1" }] },
  });
  handle.files.set(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME, invalid);

  await assert.rejects(loadProjectWorkspaceState(handle, manifest.id), /active workflow is missing/);
  assert.equal(handle.files.get(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME), invalid);
  const mismatched = JSON.stringify({
    format: "fal-flow-workspace",
    schemaVersion: 1,
    projectId: "different-project",
    updatedAt: new Date().toISOString(),
    state: { version: 1, activeWorkflowId: "workflow-1", workflows: [{ id: "workflow-1" }] },
  });
  handle.files.set(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME, mismatched);
  await assert.rejects(loadProjectWorkspaceState(handle, manifest.id), /different project/);
  assert.equal(handle.files.get(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME), mismatched);
});

test("backs up the complete project tree into an empty folder without changing the source", async () => {
  const source = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(source);
  const asset = {
    id: "backup-media",
    name: "Backup clip",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "backup-media" },
    metadata: {},
  };
  const projectManifest = await addMediaToProjectFolder(
    source,
    manifest,
    asset,
    new File(["backup video"], "backup.mp4", { type: "video/mp4" }),
  );
  const workspace = {
    version: 1,
    activeWorkflowId: "workflow-1",
    workflows: [{ id: "workflow-1", name: "Storyboard", nodes: [], edges: [], storyboard: { scenes: [] } }],
  };
  await saveProjectWorkspaceState(source, projectManifest.id, workspace);
  const sourceFilesBeforeBackup = new Map(source.files);
  const destination = createMemoryDirectoryHandle();
  const progress = [];

  const result = await backupProjectFolder(source, projectManifest.id, destination, (completed, total) => {
    progress.push([completed, total]);
  });

  assert.equal(result.fileCount, sourceFilesBeforeBackup.size);
  assert.equal(result.totalBytes, [...sourceFilesBeforeBackup.values()]
    .reduce((total, value) => total + (value instanceof Blob ? value.size : new Blob([value]).size), 0));
  assert.deepEqual([...destination.files.keys()].sort(), [...sourceFilesBeforeBackup.keys()].sort());
  assert.deepEqual([...source.files.keys()].sort(), [...sourceFilesBeforeBackup.keys()].sort());
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  assert.deepEqual(await loadProjectWorkspaceState(destination, projectManifest.id), workspace);
  assert.equal(
    await (await readProjectMediaAssetFile(destination, projectManifest.id, asset.id)).text(),
    "backup video",
  );
});

test("refuses a non-empty or nested backup destination without overwriting existing files", async () => {
  const source = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(source);
  const nonEmpty = createMemoryDirectoryHandle();
  nonEmpty.files.set("keep.txt", "keep");

  await assert.rejects(backupProjectFolder(source, manifest.id, nonEmpty), /not empty/);
  assert.equal(nonEmpty.files.get("keep.txt"), "keep");
  await assert.rejects(backupProjectFolder(source, manifest.id, source), /different, empty folder/);

  const nested = await source.getDirectoryHandle("nested-backup", { create: true });
  await assert.rejects(backupProjectFolder(source, manifest.id, nested), /outside the project folder/);
  assert.equal(source.files.has("nested-backup/fal-flow.project.json"), false);
});

test("refuses to create a backup when manifest media is missing or changed", async () => {
  const source = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(source);
  const projectManifest = await addMediaToProjectFolder(source, manifest, {
    id: "changed-media",
    name: "Changed clip",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "changed-media" },
    metadata: {},
  }, new File(["expected"], "expected.mp4", { type: "video/mp4" }));
  const assetPath = projectManifest.assets[0].relativePath;
  const missingDestination = createMemoryDirectoryHandle();
  source.files.delete(assetPath);

  await assert.rejects(backupProjectFolder(source, projectManifest.id, missingDestination), /is missing/);
  assert.equal(missingDestination.files.size, 0);

  source.files.set(assetPath, new File(["wrong size"], "expected.mp4", { type: "video/mp4" }));
  const changedDestination = createMemoryDirectoryHandle();
  await assert.rejects(backupProjectFolder(source, projectManifest.id, changedDestination), /has changed size/);
  assert.equal(changedDestination.files.size, 0);
  assert.deepEqual([...changedDestination.directories], [""]);
});
