export type RationalFrameRate = {
  numerator: number;
  denominator: number;
};

export type MediaAlphaMode = "unknown" | "opaque" | "straight" | "premultiplied";

export type MediaAssetMetadata = {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  frameRate: RationalFrameRate | null;
  color: {
    space: string | null;
    ocioConfig: string | null;
    sceneLinear: boolean | null;
  };
  alphaMode: MediaAlphaMode;
};

export type ProjectMediaKind = "image" | "video" | "audio" | "image-sequence";

export type ProjectMediaSource =
  | { kind: "url"; url: string }
  | { kind: "data-url"; dataUrl: string }
  | { kind: "storage"; storageKey: string };

export type ProjectMediaAsset = {
  id: string;
  name: string;
  mediaKind: ProjectMediaKind;
  mimeType: string | null;
  source: ProjectMediaSource;
  metadata: MediaAssetMetadata;
  revision?: number;
};

export function workflowOutputMediaId(workflowId: string, nodeId: string, port: string): string {
  if (!workflowId.trim() || !nodeId.trim() || !port.trim()) {
    throw new Error("Workflow output media requires workflow, node, and port IDs.");
  }
  return `workflow-output:${workflowId}:${nodeId}:${port}`;
}

export function workflowOutputMediaSource(
  mediaKind: ProjectMediaKind,
  value: string,
): ProjectMediaSource | null {
  if (mediaKind !== "image" && mediaKind !== "video") return null;
  if (/^https?:\/\//i.test(value)) return normalizeSource({ kind: "url", url: value });
  if (mediaKind === "image" && value.startsWith("data:image/")) {
    return normalizeSource({ kind: "data-url", dataUrl: value });
  }
  return null;
}

const MEDIA_KINDS: ProjectMediaKind[] = ["image", "video", "audio", "image-sequence"];
const ALPHA_MODES: MediaAlphaMode[] = ["unknown", "opaque", "straight", "premultiplied"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string or null.`);
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer or null.`);
  }
  return value;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left, b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function normalizeFrameRate(value: unknown): RationalFrameRate | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error("Frame rate must be a rational number or null.");
  const numerator = positiveInteger(value.numerator, "Frame-rate numerator");
  const denominator = positiveInteger(value.denominator, "Frame-rate denominator");
  if (numerator === null || denominator === null) {
    throw new Error("Frame-rate numerator and denominator are required.");
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function createUnknownMediaAssetMetadata(): MediaAssetMetadata {
  return {
    width: null,
    height: null,
    durationSeconds: null,
    frameRate: null,
    color: { space: null, ocioConfig: null, sceneLinear: null },
    alphaMode: "unknown",
  };
}

export function normalizeMediaAssetMetadata(value: unknown): MediaAssetMetadata {
  if (value === undefined || value === null) return createUnknownMediaAssetMetadata();
  if (!isRecord(value)) throw new Error("Media metadata must be an object.");
  const duration = value.durationSeconds;
  if (duration !== undefined && duration !== null
    && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) {
    throw new Error("Media duration must be a finite non-negative number or null.");
  }
  const colorValue = value.color;
  if (colorValue !== undefined && colorValue !== null && !isRecord(colorValue)) {
    throw new Error("Media color metadata must be an object or null.");
  }
  const color = isRecord(colorValue) ? colorValue : {};
  const sceneLinear = color.sceneLinear;
  if (sceneLinear !== undefined && sceneLinear !== null && typeof sceneLinear !== "boolean") {
    throw new Error("Scene-linear metadata must be a boolean or null.");
  }
  const alphaMode = value.alphaMode ?? "unknown";
  if (typeof alphaMode !== "string" || !ALPHA_MODES.includes(alphaMode as MediaAlphaMode)) {
    throw new Error("Media alpha mode is not supported.");
  }
  return {
    width: positiveInteger(value.width, "Media width"),
    height: positiveInteger(value.height, "Media height"),
    durationSeconds: duration === undefined || duration === null ? null : duration,
    frameRate: normalizeFrameRate(value.frameRate),
    color: {
      space: optionalText(color.space, "Color space"),
      ocioConfig: optionalText(color.ocioConfig, "OCIO config"),
      sceneLinear: sceneLinear === undefined || sceneLinear === null ? null : sceneLinear,
    },
    alphaMode: alphaMode as MediaAlphaMode,
  };
}

export function normalizeMediaAssetMetadataMap(value: unknown): Record<string, MediaAssetMetadata> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error("Media metadata map must be an object.");
  return Object.fromEntries(Object.entries(value).map(([id, metadata]) =>
    [id, normalizeMediaAssetMetadata(metadata)]));
}

function normalizeSource(value: unknown): ProjectMediaSource {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Media asset source is invalid.");
  }
  if (value.kind === "url") {
    if (typeof value.url !== "string") throw new Error("Media asset URL is invalid.");
    let url: URL;
    try { url = new URL(value.url); }
    catch { throw new Error("Media asset URL must be absolute."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Media asset URL must use HTTP or HTTPS.");
    }
    return { kind: "url", url: url.toString() };
  }
  if (value.kind === "data-url") {
    if (typeof value.dataUrl !== "string" || !value.dataUrl.startsWith("data:")) {
      throw new Error("Inline media source must be a data URL.");
    }
    return { kind: "data-url", dataUrl: value.dataUrl };
  }
  if (value.kind === "storage") {
    if (typeof value.storageKey !== "string" || !value.storageKey.trim()) {
      throw new Error("Stored media source requires a storage key.");
    }
    return { kind: "storage", storageKey: value.storageKey };
  }
  throw new Error("Media asset source kind is not supported.");
}

export function normalizeProjectMediaAsset(value: unknown): ProjectMediaAsset {
  if (!isRecord(value)) throw new Error("Media asset must be an object.");
  if (typeof value.id !== "string" || !value.id.trim()) throw new Error("Media asset requires an ID.");
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Media asset requires a name.");
  if (typeof value.mediaKind !== "string" || !MEDIA_KINDS.includes(value.mediaKind as ProjectMediaKind)) {
    throw new Error("Media asset kind is not supported.");
  }
  const mimeType = value.mimeType;
  if (mimeType !== undefined && mimeType !== null && (typeof mimeType !== "string" || !mimeType.trim())) {
    throw new Error("Media asset MIME type must be a non-empty string or null.");
  }
  const revision = value.revision;
  if (revision !== undefined && revision !== null
    && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error("Media asset revision must be a non-negative safe integer.");
  }
  return {
    id: value.id,
    name: value.name,
    mediaKind: value.mediaKind as ProjectMediaKind,
    mimeType: typeof mimeType === "string" ? mimeType.trim() : null,
    source: normalizeSource(value.source),
    metadata: normalizeMediaAssetMetadata(value.metadata),
    revision: typeof revision === "number" ? revision : 0,
  };
}
