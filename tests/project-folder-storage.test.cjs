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
  exportProjectPackage,
  findProjectFolderRoot,
  importProjectPackageIntoFolder,
  loadProjectCompositorState,
  loadProjectWorkspaceState,
  loadProjectVideoEditorState,
  PROJECT_MANIFEST_FILE_NAME,
  chooseProjectMediaFiles,
  readProjectMediaAssetFile,
  readProjectMediaFile,
  readOrCreateProjectManifest,
  relinkProjectMediaAtPath,
  relinkProjectMediaFromFile,
  saveProjectManifest,
  scanAndRelinkProjectMedia,
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

async function writeMemoryFile(root, relativePath, file) {
  const segments = relativePath.split("/");
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create: true });
  }
  const fileHandle = await directory.getFileHandle(segments.at(-1), { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(file);
  await writable.close();
}

async function createProjectMedia(handle, file = new File(["media bytes"], "source.mp4", { type: "video/mp4" })) {
  const { manifest } = await readOrCreateProjectManifest(handle);
  const updated = await addMediaToProjectFolder(handle, manifest, {
    id: "media-relink",
    name: "Shared source",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "media-relink" },
    metadata: {},
  }, file);
  return { manifest: updated, asset: updated.assets[0] };
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

test("finds a single nested project root without relying on its folder name", async () => {
  const selectedFolder = createMemoryDirectoryHandle();
  const container = await selectedFolder.getDirectoryHandle("Shared bundle", { create: true });
  const renamedProject = await container.getDirectoryHandle("Renamed workspace", { create: true });
  const { manifest } = await readOrCreateProjectManifest(renamedProject);

  const found = await findProjectFolderRoot(selectedFolder);
  assert.equal(found.path, renamedProject.path);
  assert.equal((await readOrCreateProjectManifest(found)).manifest.id, manifest.id);
});

test("automatically relinks a unique exact filename and size match", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest, asset } = await createProjectMedia(handle);
  const originalPath = asset.relativePath;
  const fileName = originalPath.split("/").at(-1);
  handle.files.delete(originalPath);
  const movedPath = `Renamed Media/${fileName}`;
  await writeMemoryFile(handle, movedPath, new File(["media bytes"], fileName, { type: "video/mp4" }));

  const repaired = await scanAndRelinkProjectMedia(handle, manifest);
  assert.deepEqual(repaired.relinkedAssetIds, [asset.id]);
  assert.deepEqual(repaired.unresolved, []);
  assert.equal(repaired.manifest.assets[0].id, asset.id);
  assert.equal(repaired.manifest.assets[0].relativePath, movedPath);
  assert.equal(await (await readProjectMediaFile(handle, repaired.manifest.assets[0])).text(), "media bytes");
});

test("does not guess between duplicate candidates and allows an explicit choice", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest, asset } = await createProjectMedia(handle);
  const originalPath = asset.relativePath;
  const fileName = originalPath.split("/").at(-1);
  handle.files.delete(originalPath);
  const firstPath = `First/${fileName}`;
  const secondPath = `Second/${fileName}`;
  await writeMemoryFile(handle, firstPath, new File(["media bytes"], fileName, { type: "video/mp4" }));
  await writeMemoryFile(handle, secondPath, new File(["media bytes"], fileName, { type: "video/mp4" }));

  const scan = await scanAndRelinkProjectMedia(handle, manifest);
  assert.deepEqual(scan.relinkedAssetIds, []);
  assert.deepEqual(scan.unresolved, [{ asset, candidates: [firstPath, secondPath] }]);
  assert.equal(scan.manifest.assets[0].relativePath, originalPath);

  const selected = await relinkProjectMediaAtPath(handle, manifest, asset.id, secondPath);
  assert.equal(selected.assets[0].id, asset.id);
  assert.equal(selected.assets[0].relativePath, secondPath);
});

test("requires a user choice when the project has no saved file size", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest, asset } = await createProjectMedia(handle);
  const originalPath = asset.relativePath;
  const fileName = originalPath.split("/").at(-1);
  const manifestWithoutSize = await saveProjectManifest(handle, {
    ...manifest,
    assets: manifest.assets.map((entry) => ({ ...entry, sizeBytes: null })),
  });
  handle.files.delete(originalPath);
  const candidatePath = `Moved/${fileName}`;
  await writeMemoryFile(handle, candidatePath, new File(["different size"], fileName, { type: "video/mp4" }));

  const scan = await scanAndRelinkProjectMedia(handle, manifestWithoutSize);
  assert.deepEqual(scan.relinkedAssetIds, []);
  assert.deepEqual(scan.unresolved[0].candidates, [candidatePath]);

  const selected = await relinkProjectMediaAtPath(handle, manifestWithoutSize, asset.id, candidatePath);
  assert.equal(selected.assets[0].relativePath, candidatePath);
});

test("rejects checksum mismatches and copies a verified manual replacement", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest, asset } = await createProjectMedia(handle);
  const originalPath = asset.relativePath;
  const originalFile = await readProjectMediaFile(handle, asset);
  const checksum = await crypto.subtle.digest("SHA-256", await originalFile.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const hashedManifest = await saveProjectManifest(handle, {
    ...manifest,
    assets: manifest.assets.map((entry) => ({ ...entry, sha256 })),
  });
  const fileName = originalPath.split("/").at(-1);
  handle.files.delete(originalPath);
  const wrongFile = new File(["media bytex"], fileName, { type: "video/mp4" });
  const wrongPath = `Wrong/${fileName}`;
  await writeMemoryFile(handle, wrongPath, wrongFile);

  const scan = await scanAndRelinkProjectMedia(handle, hashedManifest);
  assert.equal(scan.unresolved.length, 1);
  assert.deepEqual(scan.unresolved[0].candidates, []);
  await assert.rejects(
    relinkProjectMediaAtPath(handle, hashedManifest, asset.id, wrongPath),
    /saved checksum/,
  );
  await assert.rejects(
    relinkProjectMediaFromFile(handle, hashedManifest, asset.id, wrongFile),
    /saved checksum/,
  );

  const replacement = new File(["media bytes"], "replacement.mp4", { type: "video/mp4" });
  const relinked = await relinkProjectMediaFromFile(handle, hashedManifest, asset.id, replacement);
  assert.equal(relinked.assets[0].id, asset.id);
  assert.notEqual(relinked.assets[0].relativePath, originalPath);
  assert.equal(await (await readProjectMediaFile(handle, relinked.assets[0])).text(), "media bytes");
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

test("saves and reloads a Smart Matte and its generated matte media", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const asset = {
    id: "generated-matte", name: "matte.mp4", mediaKind: "video", mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "generated-matte" }, metadata: {},
  };
  const updated = await addMediaToProjectFolder(handle, manifest, asset, new File(["matte"], "matte.mp4", { type: "video/mp4" }));
  const state = {
    nodes: [{ id: "matte-node", type: "comp", position: { x: 0, y: 0 },
      data: { kind: "smart-matte", label: "Smart Matte", params: { mode: "auto", sourceHash: "source-hash" } } }],
    edges: [], mediaRefs: { "matte-node": asset.id }, mediaMetadata: {}, tracks: {},
    marks: { inPoint: null, outPoint: null }, time: 0, viewerTransform: { zoom: 1, x: 0, y: 0 },
    previewBackground: "checkerboard", previewColor: "#ffffff", viewChannel: "rgb",
  };
  await saveProjectCompositorState(handle, updated.id, state);
  const restored = await loadProjectCompositorState(handle, updated.id);
  assert.equal(restored.nodes[0].data.params.sourceHash, "source-hash");
  assert.equal(restored.mediaRefs["matte-node"], asset.id);
  assert.equal(await (await readProjectMediaAssetFile(handle, updated.id, asset.id)).text(), "matte");
});

test("saves and reloads the project workflow library and active workflow", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  const state = {
    version: 1,
    activeWorkflowId: "workflow-two",
    activeView: "storyboard",
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

test("defaults older project workspaces to the workflow view", async () => {
  const handle = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(handle);
  handle.files.set(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME, JSON.stringify({
    format: "fal-flow-workspace",
    schemaVersion: 1,
    projectId: manifest.id,
    updatedAt: new Date().toISOString(),
    state: {
      version: 1,
      activeWorkflowId: "legacy-workflow",
      workflows: [{ id: "legacy-workflow" }],
    },
  }));

  const state = await loadProjectWorkspaceState(handle, manifest.id);
  assert.equal(state.activeView, "workflow");
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
    activeView: "workflow",
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

test("exports and imports a portable project package with workspace and media", async () => {
  const source = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(source);
  const projectManifest = await addMediaToProjectFolder(source, manifest, {
    id: "package-media",
    name: "Package clip",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "package-media" },
    metadata: {},
  }, new File(["package video"], "package.mp4", { type: "video/mp4" }));
  const workspace = {
    version: 1,
    activeWorkflowId: "workflow-1",
    activeView: "storyboard",
    workflows: [{ id: "workflow-1", name: "Storyboard", nodes: [], edges: [], storyboard: { scenes: [] } }],
  };
  await saveProjectWorkspaceState(source, projectManifest.id, workspace);

  const packageBlob = await exportProjectPackage(source, projectManifest.id);
  assert.equal(packageBlob.type, "application/zip");
  const destination = createMemoryDirectoryHandle();
  const importedManifest = await importProjectPackageIntoFolder(packageBlob, destination);

  assert.equal(importedManifest.id, projectManifest.id);
  assert.deepEqual(await loadProjectWorkspaceState(destination, projectManifest.id), workspace);
  assert.equal(
    await (await readProjectMediaAssetFile(destination, projectManifest.id, "package-media")).text(),
    "package video",
  );
});

test("imports a complete workspace even when media files need relinking", async () => {
  const { unzipSync, zipSync } = require("fflate");
  const source = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(source);
  const projectManifest = await addMediaToProjectFolder(source, manifest, {
    id: "missing-package-media",
    name: "Missing package media",
    mediaKind: "video",
    mimeType: "video/mp4",
    source: { kind: "storage", storageKey: "missing-package-media" },
    metadata: {},
  }, new File(["package video"], "package.mp4", { type: "video/mp4" }));
  await saveProjectWorkspaceState(source, projectManifest.id, {
    version: 1,
    activeWorkflowId: "workflow-1",
    workflows: [{ id: "workflow-1", name: "Workflow", nodes: [], edges: [], storyboard: { scenes: [] } }],
  });
  const completePackage = await exportProjectPackage(source, projectManifest.id);
  const packageEntries = unzipSync(new Uint8Array(await completePackage.arrayBuffer()));
  delete packageEntries[projectManifest.assets[0].relativePath];
  const packageWithMissingMedia = new Blob([zipSync(packageEntries)]);
  const destination = createMemoryDirectoryHandle();

  const imported = await importProjectPackageIntoFolder(packageWithMissingMedia, destination);
  const repair = await scanAndRelinkProjectMedia(destination, imported);
  assert.equal(imported.id, projectManifest.id);
  assert.equal(repair.unresolved.length, 1);
  assert.equal(repair.unresolved[0].asset.id, "missing-package-media");
});

test("rejects unsafe and incomplete project packages without writing files", async () => {
  const { zipSync } = require("fflate");
  const destination = createMemoryDirectoryHandle();
  const unsafePackage = new Blob([zipSync({ "../outside.txt": new Uint8Array([1]) })]);
  await assert.rejects(importProjectPackageIntoFolder(unsafePackage, destination), /safe path|traversal/i);
  assert.equal(destination.files.size, 0);

  const projectSource = createMemoryDirectoryHandle();
  const { manifest } = await readOrCreateProjectManifest(projectSource);
  const missingWorkspace = new Blob([zipSync({
    [PROJECT_MANIFEST_FILE_NAME]: new TextEncoder().encode(JSON.stringify(manifest)),
  })]);
  await assert.rejects(importProjectPackageIntoFolder(missingWorkspace, destination), /missing "fal-flow.workspace.json"/);
  assert.equal(destination.files.size, 0);
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
