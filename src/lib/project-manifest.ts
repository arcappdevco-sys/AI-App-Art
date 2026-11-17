import {
  normalizeMediaAssetMetadata,
  type MediaAssetMetadata,
  type ProjectMediaKind,
} from "./project-media";

export const PROJECT_MANIFEST_FORMAT = "fal-flow-project";
export const PROJECT_MANIFEST_VERSION = 1;

export type ProjectManifestAsset = {
  id: string;
  name: string;
  mediaKind: ProjectMediaKind;
  mimeType: string | null;
  relativePath: string;
  proxyPath: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  metadata: MediaAssetMetadata;
};

export type ProjectManifest = {
  format: typeof PROJECT_MANIFEST_FORMAT;
  schemaVersion: typeof PROJECT_MANIFEST_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  assets: ProjectManifestAsset[];
};

const MEDIA_KINDS: ProjectMediaKind[] = ["image", "video", "audio", "image-sequence"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, label);
}

function normalizeTimestamp(value: unknown, label: string): string {
  const timestamp = requiredText(value, label);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid date.`);
  return new Date(milliseconds).toISOString();
}

export function normalizeProjectRelativePath(value: unknown, label = "Project path"): string {
  const path = requiredText(value, label).replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be a safe path relative to the project folder.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error(`${label} must not contain empty, traversal, or drive-qualified path segments.`);
  }
  return segments.join("/");
}

function normalizeAsset(value: unknown, index: number): ProjectManifestAsset {
  const label = `Project asset ${index + 1}`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (typeof value.mediaKind !== "string" || !MEDIA_KINDS.includes(value.mediaKind as ProjectMediaKind)) {
    throw new Error(`${label} has an unsupported media kind.`);
  }
  const sizeBytes = value.sizeBytes;
  if (sizeBytes !== undefined && sizeBytes !== null
    && (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) {
    throw new Error(`${label} size must be a positive safe integer or null.`);
  }
  const sha256 = optionalText(value.sha256, `${label} SHA-256`);
  if (sha256 !== null && !/^[a-f\d]{64}$/i.test(sha256)) {
    throw new Error(`${label} SHA-256 must contain exactly 64 hexadecimal characters.`);
  }
  const mimeType = optionalText(value.mimeType, `${label} MIME type`);

  return {
    id: requiredText(value.id, `${label} ID`),
    name: requiredText(value.name, `${label} name`),
    mediaKind: value.mediaKind as ProjectMediaKind,
    mimeType,
    relativePath: normalizeProjectRelativePath(value.relativePath, `${label} path`),
    proxyPath: value.proxyPath === undefined || value.proxyPath === null
      ? null
      : normalizeProjectRelativePath(value.proxyPath, `${label} proxy path`),
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : null,
    sha256: sha256?.toLowerCase() ?? null,
    metadata: normalizeMediaAssetMetadata(value.metadata),
  };
}

export function normalizeProjectManifest(value: unknown): ProjectManifest {
  if (!isRecord(value)) throw new Error("Project manifest must be an object.");
  if (value.format !== PROJECT_MANIFEST_FORMAT) {
    throw new Error(`Project manifest format must be "${PROJECT_MANIFEST_FORMAT}".`);
  }
  if (value.schemaVersion !== PROJECT_MANIFEST_VERSION) {
    throw new Error(`Project manifest schema version ${String(value.schemaVersion)} is not supported.`);
  }
  if (!Array.isArray(value.assets)) throw new Error("Project manifest assets must be an array.");

  const assets = value.assets.map(normalizeAsset);
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (assetIds.has(asset.id)) throw new Error(`Project manifest contains duplicate asset ID "${asset.id}".`);
    assetIds.add(asset.id);
  }

  return {
    format: PROJECT_MANIFEST_FORMAT,
    schemaVersion: PROJECT_MANIFEST_VERSION,
    id: requiredText(value.id, "Project ID"),
    name: requiredText(value.name, "Project name"),
    createdAt: normalizeTimestamp(value.createdAt, "Project creation time"),
    updatedAt: normalizeTimestamp(value.updatedAt, "Project update time"),
    assets,
  };
}
