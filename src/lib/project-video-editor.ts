import { normalizeMediaAssetMetadata } from "./project-media";
import type { ProjectManifest } from "./project-manifest";
import type {
  StoredEditorAsset,
  StoredEditorAudioClip,
  StoredEditorClip,
  StoredEditorKeyer,
  StoredEditorSequence,
  StoredEditorTransition,
  StoredVideoEditorState,
} from "./video-editor-storage";

export const PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME = "fal-flow.video-editor.json";
export const PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT = "fal-flow-video-editor";
export const PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION = 1;

export type ProjectVideoEditorDocument = {
  format: typeof PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT;
  schemaVersion: typeof PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION;
  projectId: string;
  updatedAt: string;
  state: StoredVideoEditorState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isStoredKeyer(value: unknown): value is StoredEditorKeyer {
  if (!isRecord(value)) return false;
  return typeof value.enabled === "boolean"
    && isText(value.color)
    && isFiniteNumber(value.similarity)
    && isFiniteNumber(value.softness)
    && isFiniteNumber(value.spillSuppression)
    && isFiniteNumber(value.clipBlack)
    && isFiniteNumber(value.clipWhite)
    && isFiniteNumber(value.edgeChoke)
    && isFiniteNumber(value.edgeFeather);
}

function isStoredClip(value: unknown): value is StoredEditorClip {
  if (!isRecord(value)) return false;
  return isText(value.id)
    && isText(value.name)
    && typeof value.mediaId === "string"
    && isNonNegativeNumber(value.duration)
    && isNonNegativeNumber(value.trimStart)
    && isNonNegativeNumber(value.trimEnd)
    && (value.audioWaveform === undefined || value.audioWaveform === null
      || (Array.isArray(value.audioWaveform) && value.audioWaveform.every(isFiniteNumber)))
    && (value.keyer === undefined || isStoredKeyer(value.keyer))
    && (value.projectAssetId === undefined || isText(value.projectAssetId))
    && (value.projectAssetRevision === undefined
      || (Number.isSafeInteger(value.projectAssetRevision) && Number(value.projectAssetRevision) >= 0));
}

function isStoredAudioClip(value: unknown): value is StoredEditorAudioClip {
  if (!isRecord(value)) return false;
  return isText(value.id)
    && isText(value.name)
    && typeof value.mediaId === "string"
    && isNonNegativeNumber(value.duration)
    && isNonNegativeNumber(value.start)
    && isNonNegativeNumber(value.trimStart)
    && isNonNegativeNumber(value.trimEnd)
    && isFiniteNumber(value.volume)
    && (value.projectAssetId === undefined || isText(value.projectAssetId))
    && (value.projectAssetRevision === undefined
      || (Number.isSafeInteger(value.projectAssetRevision) && Number(value.projectAssetRevision) >= 0));
}

function isStoredTransition(value: unknown): value is StoredEditorTransition {
  return isRecord(value)
    && isText(value.leftClipId)
    && isText(value.rightClipId)
    && isNonNegativeNumber(value.duration);
}

function isStoredSequence(value: unknown): value is StoredEditorSequence {
  if (!isRecord(value)) return false;
  return isText(value.id)
    && isText(value.name)
    && Array.isArray(value.clips)
    && value.clips.every(isStoredClip)
    && typeof value.selectedId === "string"
    && isNonNegativeNumber(value.playheadTime)
    && (value.audioClips === undefined
      || (Array.isArray(value.audioClips) && value.audioClips.every(isStoredAudioClip)))
    && (value.transitions === undefined
      || (Array.isArray(value.transitions) && value.transitions.every(isStoredTransition)));
}

function isStoredAsset(value: unknown): value is StoredEditorAsset {
  if (!isRecord(value)) return false;
  return isText(value.id)
    && isText(value.name)
    && typeof value.mediaId === "string"
    && (value.projectAssetId === undefined || isText(value.projectAssetId))
    && (value.projectAssetRevision === undefined
      || (Number.isSafeInteger(value.projectAssetRevision) && Number(value.projectAssetRevision) >= 0));
}

function isStoredEditorState(value: unknown): value is StoredVideoEditorState {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.version)
    && Number(value.version) >= 1
    && Number(value.version) <= 4
    && Array.isArray(value.sequences)
    && value.sequences.every(isStoredSequence)
    && Array.isArray(value.uploadedAssets)
    && value.uploadedAssets.every(isStoredAsset)
    && typeof value.activeSequenceId === "string"
    && (value.activeTool === "select" || value.activeTool === "razor" || value.activeTool === "transition");
}

function projectEditorAssets(manifest: ProjectManifest): StoredEditorAsset[] {
  return manifest.assets
    .filter((asset) => asset.mediaKind !== "image-sequence")
    .map((asset) => ({
      id: asset.id,
      name: asset.name,
      mediaId: asset.id,
      metadata: asset.metadata,
      projectAssetId: asset.id,
      projectAssetRevision: 0,
    }));
}

function projectAssetIdFor(
  mediaId: string,
  projectAssetId: string | undefined,
  manifestAssetIds: ReadonlySet<string>,
  mediaName: string,
): string {
  const assetId = projectAssetId ?? (manifestAssetIds.has(mediaId) ? mediaId : undefined);
  if (!assetId || !manifestAssetIds.has(assetId)) {
    throw new Error(`Copy "${mediaName}" into the project before saving its timeline.`);
  }
  return assetId;
}

function normalizeState(value: unknown, manifest: ProjectManifest): StoredVideoEditorState {
  if (!isStoredEditorState(value)) {
    throw new Error("The project video-editor document contains invalid editor state.");
  }
  const manifestAssetIds = new Set(manifest.assets.map((asset) => asset.id));
  const sequences = value.sequences.map((sequence) => ({
    ...sequence,
    clips: sequence.clips.map((clip) => {
      const projectAssetId = projectAssetIdFor(
        clip.mediaId,
        clip.projectAssetId,
        manifestAssetIds,
        clip.name,
      );
      return {
        ...clip,
        mediaId: projectAssetId,
        projectAssetId,
        projectAssetRevision: undefined,
        metadata: normalizeMediaAssetMetadata(clip.metadata),
      };
    }),
    audioClips: (sequence.audioClips ?? []).map((clip) => {
      const projectAssetId = projectAssetIdFor(
        clip.mediaId,
        clip.projectAssetId,
        manifestAssetIds,
        clip.name,
      );
      return {
        ...clip,
        mediaId: projectAssetId,
        projectAssetId,
        projectAssetRevision: undefined,
        metadata: normalizeMediaAssetMetadata(clip.metadata),
      };
    }),
    transitions: sequence.transitions ?? [],
  }));

  return {
    version: 4,
    sequences,
    uploadedAssets: projectEditorAssets(manifest),
    activeSequenceId: value.activeSequenceId,
    activeTool: value.activeTool,
  };
}

export function createProjectVideoEditorState(manifest: ProjectManifest): StoredVideoEditorState {
  return normalizeState({
    version: 4,
    sequences: [{
      id: "sequence-1",
      name: "Sequence 1",
      clips: [],
      audioClips: [],
      transitions: [],
      selectedId: "",
      playheadTime: 0,
    }],
    uploadedAssets: [],
    activeSequenceId: "sequence-1",
    activeTool: "select",
  }, manifest);
}

export function createProjectVideoEditorDocument(
  state: StoredVideoEditorState,
  manifest: ProjectManifest,
): ProjectVideoEditorDocument {
  return {
    format: PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT,
    schemaVersion: PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION,
    projectId: manifest.id,
    updatedAt: new Date().toISOString(),
    state: normalizeState(state, manifest),
  };
}

export function normalizeProjectVideoEditorDocument(
  value: unknown,
  manifest: ProjectManifest,
): ProjectVideoEditorDocument {
  if (!isRecord(value)) throw new Error("Project video-editor document must be an object.");
  if (value.format !== PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT) {
    throw new Error(`Project video-editor document format must be "${PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT}".`);
  }
  if (value.schemaVersion !== PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION) {
    throw new Error(`Project video-editor schema version ${String(value.schemaVersion)} is not supported.`);
  }
  if (value.projectId !== manifest.id) {
    throw new Error("Project video-editor document belongs to a different project.");
  }
  if (!isText(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Project video-editor update time must be a valid date.");
  }
  return {
    format: PROJECT_VIDEO_EDITOR_DOCUMENT_FORMAT,
    schemaVersion: PROJECT_VIDEO_EDITOR_DOCUMENT_VERSION,
    projectId: manifest.id,
    updatedAt: new Date(value.updatedAt).toISOString(),
    state: normalizeState(value.state, manifest),
  };
}
