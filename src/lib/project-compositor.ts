import { normalizeMediaAssetMetadataMap, type MediaAssetMetadata } from "./project-media";
import type { CompositorMarks, ViewerTransform } from "./compositor";
import type { CompositorNode } from "./compositor-templates";
import type { TrackingData } from "./compositor-tracking";
import type { Edge } from "@xyflow/react";
import type { ProjectManifest } from "./project-manifest";

const COMPOSITOR_KINDS = ["media", "transform", "key", "mask", "color", "merge", "tracker", "viewer"];

export const PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME = "fal-flow.compositor.json";
export const PROJECT_COMPOSITOR_DOCUMENT_FORMAT = "fal-flow-compositor";
export const PROJECT_COMPOSITOR_DOCUMENT_VERSION = 1;

export type ProjectCompositorState = {
  nodes: CompositorNode[];
  edges: Edge[];
  mediaRefs: Record<string, string>;
  mediaMetadata: Record<string, MediaAssetMetadata>;
  tracks: Record<string, TrackingData>;
  marks: CompositorMarks;
  time: number;
  viewerTransform: ViewerTransform;
  previewBackground: "checkerboard" | "color";
  previewColor: string;
  viewChannel: "rgb" | "red" | "green" | "blue" | "alpha";
};

export type ProjectCompositorDocument = {
  format: typeof PROJECT_COMPOSITOR_DOCUMENT_FORMAT;
  schemaVersion: typeof PROJECT_COMPOSITOR_DOCUMENT_VERSION;
  projectId: string;
  updatedAt: string;
  state: ProjectCompositorState;
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

function isTrackPoint(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.time) && isFiniteNumber(value.x)
    && isFiniteNumber(value.y) && isFiniteNumber(value.confidence);
}

function isTrackingData(value: unknown): value is TrackingData {
  if (Array.isArray(value)) return value.every(isTrackPoint);
  if (!isRecord(value) || !Array.isArray(value.samples) || typeof value.complete !== "boolean"
    || !isFiniteNumber(value.endTime)) return false;
  return value.samples.every((sample) => isRecord(sample)
    && isFiniteNumber(sample.time)
    && Array.isArray(sample.matrix) && sample.matrix.length === 9 && sample.matrix.every(isFiniteNumber)
    && Array.isArray(sample.anchors) && sample.anchors.every((anchor) => isRecord(anchor)
      && isFiniteNumber(anchor.x) && isFiniteNumber(anchor.y))
    && isFiniteNumber(sample.confidence));
}

function normalizeNode(value: unknown, index: number): CompositorNode {
  if (!isRecord(value) || !isText(value.id) || !isRecord(value.position)
    || !isFiniteNumber(value.position.x) || !isFiniteNumber(value.position.y)
    || !isRecord(value.data) || !isText(value.data.kind) || !isText(value.data.label)
    || !isRecord(value.data.params)
    || (value.data.disabled !== undefined && typeof value.data.disabled !== "boolean")) {
    throw new Error(`Compositor node ${index + 1} is invalid.`);
  }
  return value as unknown as CompositorNode;
}

function normalizeEdge(value: unknown, index: number): Edge {
  if (!isRecord(value) || !isText(value.id) || !isText(value.source) || !isText(value.target)) {
    throw new Error(`Compositor connection ${index + 1} is invalid.`);
  }
  return value as unknown as Edge;
}

function normalizeState(value: unknown, manifest: ProjectManifest): ProjectCompositorState {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || !isRecord(value.mediaRefs) || !isRecord(value.tracks) || !isRecord(value.marks)
    || !isRecord(value.viewerTransform)) {
    throw new Error("The project compositor document contains invalid state.");
  }
  const nodes = value.nodes.map(normalizeNode);
  const edges = value.edges.map(normalizeEdge);
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("The project compositor document contains duplicate node IDs.");
  if (nodes.some((node) => !COMPOSITOR_KINDS.includes(node.data.kind))) {
    throw new Error("The project compositor document contains an unsupported node type.");
  }
  if (edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    throw new Error("The project compositor document contains a connection to a missing node.");
  }
  const assetIds = new Set(manifest.assets.map((asset) => asset.id));
  const mediaRefs: Record<string, string> = {};
  for (const [nodeId, assetId] of Object.entries(value.mediaRefs)) {
    if (!nodes.some((node) => node.id === nodeId && node.data.kind === "media")
      || !isText(assetId) || !assetIds.has(assetId)) {
      throw new Error(`Compositor media reference for node "${nodeId}" is not in this project.`);
    }
    mediaRefs[nodeId] = assetId;
  }
  const tracks: Record<string, TrackingData> = {};
  for (const [nodeId, track] of Object.entries(value.tracks)) {
    if (!nodeIds.has(nodeId) || !isTrackingData(track)) {
      throw new Error(`Compositor tracking data for node "${nodeId}" is invalid.`);
    }
    tracks[nodeId] = track;
  }
  const { inPoint, outPoint } = value.marks;
  if ((inPoint !== null && !isFiniteNumber(inPoint)) || (outPoint !== null && !isFiniteNumber(outPoint))) {
    throw new Error("Compositor in/out points must be finite numbers or null.");
  }
  const transform = value.viewerTransform;
  if (!isFiniteNumber(transform.zoom) || transform.zoom < 0.25 || transform.zoom > 8
    || !isFiniteNumber(transform.x) || !isFiniteNumber(transform.y)) {
    throw new Error("Compositor viewer transform is invalid.");
  }
  if (!isFiniteNumber(value.time) || value.time < 0) throw new Error("Compositor playhead time is invalid.");
  if (value.previewBackground !== "checkerboard" && value.previewBackground !== "color") {
    throw new Error("Compositor preview background is invalid.");
  }
  if (typeof value.previewColor !== "string" || !/^#[0-9a-f]{6}$/i.test(value.previewColor)) {
    throw new Error("Compositor preview color is invalid.");
  }
  if (!["rgb", "red", "green", "blue", "alpha"].includes(String(value.viewChannel))) {
    throw new Error("Compositor view channel is invalid.");
  }
  const normalizedMarks = {
    inPoint: inPoint as number | null,
    outPoint: outPoint as number | null,
  };
  if (Object.values(normalizedMarks).some((mark) => mark !== null && mark < 0)) {
    throw new Error("Compositor in/out points cannot be negative.");
  }
  return {
    nodes,
    edges,
    mediaRefs,
    mediaMetadata: normalizeMediaAssetMetadataMap(value.mediaMetadata),
    tracks,
    marks: normalizedMarks,
    time: value.time,
    viewerTransform: { zoom: transform.zoom, x: transform.x, y: transform.y },
    previewBackground: value.previewBackground,
    previewColor: value.previewColor,
    viewChannel: value.viewChannel as ProjectCompositorState["viewChannel"],
  };
}

export function createProjectCompositorDocument(
  state: ProjectCompositorState,
  manifest: ProjectManifest,
): ProjectCompositorDocument {
  return {
    format: PROJECT_COMPOSITOR_DOCUMENT_FORMAT,
    schemaVersion: PROJECT_COMPOSITOR_DOCUMENT_VERSION,
    projectId: manifest.id,
    updatedAt: new Date().toISOString(),
    state: normalizeState(state, manifest),
  };
}

export function normalizeProjectCompositorDocument(
  value: unknown,
  manifest: ProjectManifest,
): ProjectCompositorDocument {
  if (!isRecord(value)) throw new Error("Project compositor document must be an object.");
  if (value.format !== PROJECT_COMPOSITOR_DOCUMENT_FORMAT) {
    throw new Error(`Project compositor document format must be "${PROJECT_COMPOSITOR_DOCUMENT_FORMAT}".`);
  }
  if (value.schemaVersion !== PROJECT_COMPOSITOR_DOCUMENT_VERSION) {
    throw new Error(`Project compositor schema version ${String(value.schemaVersion)} is not supported.`);
  }
  if (value.projectId !== manifest.id) throw new Error("Project compositor document belongs to a different project.");
  if (!isText(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Project compositor update time must be a valid date.");
  }
  return {
    format: PROJECT_COMPOSITOR_DOCUMENT_FORMAT,
    schemaVersion: PROJECT_COMPOSITOR_DOCUMENT_VERSION,
    projectId: manifest.id,
    updatedAt: new Date(value.updatedAt).toISOString(),
    state: normalizeState(value.state, manifest),
  };
}
