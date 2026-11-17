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
  normalizeProjectManifest,
  PROJECT_MANIFEST_FORMAT,
  PROJECT_MANIFEST_VERSION,
} = require(path.join(__dirname, "..", "src", "lib", "project-manifest.ts"));
const {
  createProjectVideoEditorDocument,
  createProjectVideoEditorState,
  normalizeProjectVideoEditorDocument,
  PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT,
  PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION,
} = require(path.join(__dirname, "..", "src", "lib", "project-video-editor.ts"));

function createManifest() {
  return normalizeProjectManifest({
    format: PROJECT_MANIFEST_FORMAT,
    schemaVersion: PROJECT_MANIFEST_VERSION,
    id: "project-1",
    name: "Test Project",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    assets: [{
      id: "shot-1",
      name: "Shot one",
      mediaKind: "video",
      mimeType: "video/mp4",
      relativePath: "Media/Originals/shot-one.mp4",
      proxyPath: null,
      sizeBytes: 4,
      sha256: null,
      metadata: {
        width: 240,
        height: 320,
        durationSeconds: 2,
        frameRate: null,
        color: { space: null, ocioConfig: null, sceneLinear: null },
        alphaMode: "unknown",
      },
    }],
  });
}

function createTimelineState() {
  return {
    version: 4,
    sequences: [{
      id: "sequence-1",
      name: "Sequence 1",
      clips: [{
        id: "clip-1",
        name: "Shot one",
        mediaId: "shot-1",
        duration: 2,
        trimStart: 0.25,
        trimEnd: 1.75,
        projectAssetId: "shot-1",
        projectAssetRevision: 3,
      }],
      audioClips: [],
      transitions: [],
      selectedId: "clip-1",
      playheadTime: 0.5,
    }],
    uploadedAssets: [],
    activeSequenceId: "sequence-1",
    activeTool: "razor",
  };
}

test("creates a versioned project timeline that references manifest media IDs", () => {
  const manifest = createManifest();
  const document = createProjectVideoEditorDocument(createTimelineState(), manifest);
  assert.equal(document.format, PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT);
  assert.equal(document.schemaVersion, PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION);
  assert.equal(document.projectId, manifest.id);
  assert.equal(document.state.sequences[0].clips[0].mediaId, "shot-1");
  assert.equal(document.state.sequences[0].clips[0].projectAssetRevision, undefined);
  assert.equal(document.state.uploadedAssets[0].projectAssetId, "shot-1");

  const reopened = normalizeProjectVideoEditorDocument(JSON.parse(JSON.stringify(document)), manifest);
  assert.equal(reopened.state.sequences[0].clips[0].trimStart, 0.25);
  assert.equal(reopened.state.sequences[0].playheadTime, 0.5);
  assert.equal(reopened.state.activeTool, "razor");
});

test("starts a new project timeline with its folder media in the footage bin", () => {
  const manifest = createManifest();
  const state = createProjectVideoEditorState(manifest);
  assert.equal(state.sequences.length, 1);
  assert.equal(state.sequences[0].clips.length, 0);
  assert.equal(state.uploadedAssets[0].projectAssetId, "shot-1");
});

test("refuses timeline clips that are not backed by a project asset", () => {
  const state = createTimelineState();
  state.sequences[0].clips[0].projectAssetId = "outside-project";
  assert.throws(() => createProjectVideoEditorDocument(state, createManifest()), /Copy "Shot one" into the project/);
});

test("rejects documents for another project or unsupported schema versions", () => {
  const manifest = createManifest();
  const document = createProjectVideoEditorDocument(createTimelineState(), manifest);
  assert.throws(() => normalizeProjectVideoEditorDocument({
    ...document,
    projectId: "another-project",
  }, manifest), /different project/);
  assert.throws(() => normalizeProjectVideoEditorDocument({
    ...document,
    schemaVersion: 2,
  }, manifest), /schema version 2 is not supported/);
});
