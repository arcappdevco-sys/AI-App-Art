"use client";

import {
  useCallback, useEffect, useEffectEvent, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ReactFlow, Background, Controls, Handle, Position, addEdge, useEdgesState, useNodesState,
  type Connection, type Edge, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import { COMPOSITOR_DESCRIPTIONS, COMPOSITOR_INPUTS, COMPOSITOR_LABELS, DEFAULT_VIEWER_TRANSFORM, EMPTY_COMPOSITOR_MARKS, compositorBypassInput, compositorImageFit, compositorMediaSource, compositorRange, nextCompositorTime, reachesCompositorNode, trackPatch, zoomViewerAt, type CompositorMarks, type CompositorParamValue, type CompositorParams } from "@/lib/compositor";
import { COMPOSITOR_NODE_OPTIONS, COMPOSITOR_TEMPLATES, appendCompositorTemplate, createCompositorNode, createCompositorTemplate, type CompositorNode, type CompositorNodeOption, type TemplateId } from "@/lib/compositor-templates";
import { applyCompositorMask, convertMaskGeometry, createMaskGeometry, createMaskLayer, getMaskLayers, hasMaskKeyframeAt, maskGeometryAt, removeMaskKeyframe, setMaskKeyframe, updateMaskGeometry, validateMaskProjection, type MaskGeometry, type MaskLayer, type MaskShapeKind } from "@/lib/compositor-mask";
import { applyColorCorrection } from "@/lib/compositor-color";
import ColorCurves from "@/components/ColorCurves";
import ColorNumberField from "@/components/ColorNumberField";
import MaskEditor from "@/components/MaskEditor";
import TrackerEditor from "@/components/TrackerEditor";
import { applyCompositorKeyer } from "@/lib/compositor-keyer";
import { CompositorHistory, compositorHistoryShortcut } from "@/lib/compositor-history";
import { IDENTITY_TRACKING_MATRIX, detectPlanarFeatures, planarTrackingMatrix, similarityTrackingMatrix, trackerAnchors, trackerMode, trackingAt, trackPlanarFeatures, transformTrackingPoint, validateTrackingProjection, validateTrackingSurface, warpTrackingCanvas, type TrackingData, type TrackingMatrix, type TrackingPoint, type TrackingResult, type TrackingSample } from "@/lib/compositor-tracking";
import { createUnknownMediaAssetMetadata, normalizeMediaAssetMetadata, normalizeMediaAssetMetadataMap, type MediaAssetMetadata, type ProjectMediaAsset } from "@/lib/project-media";
import {
  addMediaToProjectFolder,
  chooseProjectMediaFiles,
  loadProjectCompositorState,
  readOrCreateProjectManifest,
  saveProjectCompositorState,
  type ProjectFolderSession,
} from "@/lib/project-folder-storage";
import { loadProjectMediaFile, registerProjectMediaAsset } from "@/lib/project-media-storage";
import type { ProjectCompositorState } from "@/lib/project-compositor";

type CompNode = CompositorNode;
type Project = {
  nodes: CompNode[];
  edges: Edge[];
  media: Record<string, File>;
  mediaRefs?: Record<string, string>;
  mediaMetadata?: Record<string, MediaAssetMetadata>;
  tracks?: Record<string, TrackingData>;
  marks?: CompositorMarks;
  time?: number;
  viewerTransform?: { zoom: number; x: number; y: number };
  previewBackground?: "checkerboard" | "color";
  previewColor?: string;
  viewChannel?: "rgb" | "red" | "green" | "blue" | "alpha";
};
type HistorySnapshot = {
  nodes: CompNode[];
  edges: Edge[];
  files: Record<string, File>;
  mediaRefs: Record<string, string>;
  mediaMetadata: Record<string, MediaAssetMetadata>;
  tracks: Record<string, TrackingData>;
  selected: string;
  marks: CompositorMarks;
};
const HISTORY_LIMIT = 50;
const WIDTH = 640, HEIGHT = 360;
const VIEWER_MIN_HEIGHT = 250;
const GRAPH_MIN_HEIGHT = 200;
const VIEWER_DIVIDER_HEIGHT = 12;
const COMPOSITOR_SPLIT_MIN_HEIGHT = VIEWER_MIN_HEIGHT + GRAPH_MIN_HEIGHT;
const labels = COMPOSITOR_LABELS;

type ViewerResizeDrag = {
  pointerId: number;
  startClientY: number;
  startHeight: number;
  availableHeight: number;
};

function getViewerFlexRatio(height: number, availableHeight: number) {
  const flexibleHeight = Math.max(1, availableHeight - COMPOSITOR_SPLIT_MIN_HEIGHT);
  return Math.min(1, Math.max(0, (height - VIEWER_MIN_HEIGHT) / flexibleHeight));
}

function CompNodeView({ data }: NodeProps<CompNode>) {
  const inputs = COMPOSITOR_INPUTS[data.kind];
  return <div className={`comp-node${data.disabled ? " is-disabled" : ""}`}
    title={`${data.label}: ${COMPOSITOR_DESCRIPTIONS[data.kind]}`}>
    <strong>{data.label}</strong>
    {data.disabled && <div className="comp-node-disabled">Disabled</div>}
    {data.kind === "media" && <div className="comp-node-hint">{data.params.sourceMode === "solid" ? "Solid color" :
      data.params.sourceMode === "transparent" ? "Transparent background" : "Media input · select to upload"}</div>}
    {inputs.map((input) => <div key={input} className="comp-port">
      <Handle type="target" position={Position.Left} id={input} />{input}
    </div>)}
    {data.kind !== "viewer" && <div className="comp-port comp-out">
      {data.kind === "tracker" ? "motion" : "image"}<Handle type="source" position={Position.Right} id="output" />
    </div>}
  </div>;
}
const nodeTypes = { comp: CompNodeView };

function NumberField({ label, value, min, max, disabled, onChange }: {
  label: string; value: number; min?: number; max?: number; disabled: boolean; onChange: (value: number) => void;
}) {
  return <label>{label}<input type="number" disabled={disabled} value={value} min={min} max={max}
    onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function openProjectDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fal-flow-compositor", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("project");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open compositor storage."));
  });
}
async function loadProject(): Promise<Project | undefined> {
  const db = await openProjectDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("project", "readonly").objectStore("project").get("current");
      request.onsuccess = () => resolve(request.result as Project | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not load compositor project."));
    });
  } finally { db.close(); }
}
async function saveProject(project: Project) {
  const db = await openProjectDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("project", "readwrite");
      tx.objectStore("project").put(project, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save compositor project."));
      tx.onabort = () => reject(tx.error ?? new Error("Compositor save was aborted."));
    });
  } finally { db.close(); }
}

function canvas() {
  const value = document.createElement("canvas");
  value.width = WIDTH; value.height = HEIGHT;
  return value;
}
function context(value: HTMLCanvasElement) {
  const ctx = value.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas rendering is not available in this browser.");
  return ctx;
}
function number(params: CompositorParams, key: string, fallback: number) {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}
function inspectTracking(data: TrackingData, time: number): { sample?: TrackingSample; error?: string } {
  try { return { sample: trackingAt(data, time) }; }
  catch (caught) { return { error: caught instanceof Error ? caught.message : String(caught) }; }
}
function inspectMaskProjection(geometry: MaskGeometry | undefined, matrix: TrackingMatrix): string {
  if (!geometry) return "";
  try { validateMaskProjection(geometry, matrix); return ""; }
  catch (caught) { return caught instanceof Error ? caught.message : String(caught); }
}
function graphDuration(id: string, nodes: CompNode[], edges: Edge[], durations: Record<string, number>, visited = new Set<string>()): number {
  if (visited.has(id)) return 0;
  visited.add(id);
  const node = nodes.find((item) => item.id === id);
  if (node?.data.disabled) {
    const bypass = compositorBypassInput(node.data.kind);
    const edge = edges.find((item) => item.target === id && item.targetHandle === bypass);
    return edge ? graphDuration(edge.source, nodes, edges, durations, visited) : 0;
  }
  return Math.max(node?.data.kind === "media" && compositorMediaSource(node.data.params) !== "file" ? 0 : durations[id] ?? 0,
    ...edges.filter((edge) => edge.target === id && edge.targetHandle !== "motion")
      .map((edge) => graphDuration(edge.source, nodes, edges, durations, visited)));
}
async function seek(video: HTMLVideoElement, time: number) {
  const target = Math.max(0, Math.min(time, Math.max(0, video.duration - 0.001)));
  if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Could not seek video.")); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("Video seek timed out.")); }, 10000);
    const cleanup = () => { window.clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", fail); };
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("error", fail, { once: true });
    try { video.currentTime = target; } catch { fail(); }
  });
}

type Media = {
  element: HTMLImageElement | HTMLVideoElement;
  url: string;
  duration: number;
  metadata: MediaAssetMetadata;
  projectAssetId?: string;
  projectAssetRevision?: number;
};
async function createMedia(file: File): Promise<Media> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith("image/")) {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve(); image.onerror = () => reject(new Error(`Could not load ${file.name}.`)); image.src = url;
      });
      return {
        element: image,
        url,
        duration: 0,
        metadata: { ...createUnknownMediaAssetMetadata(), width: image.naturalWidth, height: image.naturalHeight },
      };
    }
    if (!file.type.startsWith("video/")) throw new Error("Choose an image or video file.");
    const video = document.createElement("video");
    video.preload = "auto"; video.muted = true; video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error(`Could not load ${file.name}.`));
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Video duration could not be determined.");
    return {
      element: video,
      url,
      duration: video.duration,
      metadata: {
        ...createUnknownMediaAssetMetadata(),
        width: video.videoWidth,
        height: video.videoHeight,
        durationSeconds: video.duration,
      },
    };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function renderGraph(
  nodes: CompNode[], edges: Edge[], media: Record<string, Media>, tracks: Record<string, TrackingData>,
  target: string, time: number,
): Promise<HTMLCanvasElement> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path = new Set<string>();
  const render = async (id: string): Promise<HTMLCanvasElement> => {
    if (path.has(id)) throw new Error("The compositor graph contains a cycle.");
    const node = byId.get(id);
    if (!node) throw new Error("A connected node is missing.");
    path.add(id);
    try {
      const input = async (name: string) => {
        const edge = edges.find((item) => item.target === id && item.targetHandle === name);
        if (!edge) throw new Error(`${node.data.label}: connect ${name}.`);
        return render(edge.source);
      };
      if (node.data.disabled) {
        const bypass = compositorBypassInput(node.data.kind);
        if (bypass) return await input(bypass);
        throw new Error(`${node.data.label} is disabled. Enable it to render.`);
      }
      const result = canvas(), ctx = context(result), params = node.data.params;
      if (node.data.kind === "media") {
        const source = compositorMediaSource(params);
        if (source === "transparent") return result;
        if (source === "solid") {
          ctx.fillStyle = typeof params.solidColor === "string" && /^#[0-9a-f]{6}$/i.test(params.solidColor) ? params.solidColor : "#ffffff";
          ctx.fillRect(0, 0, WIDTH, HEIGHT);
          return result;
        }
        const item = media[id];
        if (!item) throw new Error(`${node.data.label}: choose a media file.`);
        if (item.element instanceof HTMLVideoElement) await seek(item.element, time);
        const fit = compositorImageFit(item.metadata.width ?? 0, item.metadata.height ?? 0, WIDTH, HEIGHT);
        ctx.drawImage(item.element, fit.x, fit.y, fit.width, fit.height);
      } else if (node.data.kind === "tracker") {
        throw new Error("Tracker outputs motion only. Connect it to a Transform or Mask motion input.");
      } else if (node.data.kind === "merge") {
        ctx.drawImage(await input("background"), 0, 0);
        ctx.globalAlpha = Math.max(0, Math.min(1, number(params, "opacity", 100) / 100));
        ctx.drawImage(await input("foreground"), 0, 0);
      } else {
        const source = await input("image");
        const motionEdge = edges.find((edge) => edge.target === id && edge.targetHandle === "motion");
        const tracker = motionEdge ? byId.get(motionEdge.source) : undefined;
        const motion: TrackingMatrix = motionEdge && !tracker?.data.disabled
          ? trackingAt(tracks[motionEdge.source] ?? [], time).matrix : IDENTITY_TRACKING_MATRIX;
        if (node.data.kind === "transform") {
          const scale = Math.max(0.01, number(params, "scale", 100) / 100);
          const perspective = Math.abs(motion[6]) > 1e-10 || Math.abs(motion[7]) > 1e-10;
          if (!perspective) ctx.transform(motion[0], motion[3], motion[1], motion[4], motion[2], motion[5]);
          ctx.translate(WIDTH / 2 + number(params, "x", 0), HEIGHT / 2 + number(params, "y", 0));
          ctx.scale(scale, scale); ctx.drawImage(source, -WIDTH / 2, -HEIGHT / 2);
          if (perspective) return warpTrackingCanvas(result, motion);
        } else if (node.data.kind === "mask") {
          return applyCompositorMask(source, getMaskLayers(params), time, Boolean(params.invert), motion);
        } else {
          ctx.drawImage(source, 0, 0);
          if (node.data.kind === "key" || node.data.kind === "color") {
            const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT);
            if (node.data.kind === "color") applyColorCorrection(pixels.data, params);
            else applyCompositorKeyer(pixels.data, WIDTH, HEIGHT, params);
            ctx.putImageData(pixels, 0, 0);
          }
        }
      }
      return result;
    } finally { path.delete(id); }
  };
  return render(target);
}

async function drawPreview(
  output: HTMLCanvasElement | null, nodes: CompNode[], edges: Edge[], media: Record<string, Media>,
  tracks: Record<string, TrackingData>, viewerId: string | undefined, at: number,
) {
  if (!viewerId || !output) throw new Error("Connect a Viewer before rendering.");
  const result = await renderGraph(nodes, edges, media, tracks, viewerId, at);
  const ctx = context(output);
  ctx.clearRect(0, 0, WIDTH, HEIGHT); ctx.drawImage(result, 0, 0);
}

async function renderVideoFrames(start: number, duration: number, draw: (time: number) => Promise<void>) {
  const started = performance.now();
  for (let frame = 0; frame < Math.ceil(duration * 10); frame++) {
    const frameTime = frame / 10;
    const wait = started + frameTime * 1000 - performance.now();
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    if (performance.now() - started > frameTime * 1000 + 500) throw new Error("Rendering is too slow for real-time video export. Simplify the graph and try again.");
    await draw(start + frameTime);
  }
  const remaining = started + duration * 1000 - performance.now();
  if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
}

export default function Compositor({
  hidden,
  sharedMediaAssets = [],
  projectSession = null,
  projectSessionReady = true,
  onProjectMediaChange,
  onProjectSessionChange,
  onRegisterSaveHandler,
  onSendFrameToWorkflow,
}: {
  hidden: boolean;
  sharedMediaAssets?: ProjectMediaAsset[];
  projectSession?: ProjectFolderSession | null;
  projectSessionReady?: boolean;
  onProjectMediaChange?: () => Promise<void>;
  onProjectSessionChange?: (session: ProjectFolderSession) => void;
  onRegisterSaveHandler?: (handler: (() => Promise<void>) | null) => void;
  onSendFrameToWorkflow?: (dataUrl: string, time: number) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CompNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [files, setFiles] = useState<Record<string, File>>({});
  const [mediaReferences, setMediaReferences] = useState<Record<string, string>>({});
  const [mediaMetadata, setMediaMetadata] = useState<Record<string, MediaAssetMetadata>>({});
  const [tracks, setTracks] = useState<Record<string, TrackingData>>({});
  const [selected, setSelected] = useState("");
  const [time, setTime] = useState(0);
  const [marks, setMarks] = useState<CompositorMarks>(EMPTY_COMPOSITOR_MARKS);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [status, setStatus] = useState("Loading project...");
  const [ready, setReady] = useState(false);
  const [mediaVersion, setMediaVersion] = useState(0);
  const [templateVersion, setTemplateVersion] = useState(0);
  const [mediaDurations, setMediaDurations] = useState<Record<string, number>>({});
  const [viewerRatio, setViewerRatio] = useState(0.55);
  const [viewerAvailableHeight, setViewerAvailableHeight] = useState(COMPOSITOR_SPLIT_MIN_HEIGHT);
  const [resizingViewer, setResizingViewer] = useState(false);
  const projectHandle = projectSession?.handle ?? null;
  const projectId = projectSession?.projectId ?? null;
  const [viewerTransform, setViewerTransform] = useState(DEFAULT_VIEWER_TRANSFORM);
  const [previewBackground, setPreviewBackground] = useState<"checkerboard" | "color">("checkerboard");
  const [previewColor, setPreviewColor] = useState("#ffffff");
  const [viewChannel, setViewChannel] = useState<"rgb" | "red" | "green" | "blue" | "alpha">("rgb");
  const [pickingKey, setPickingKey] = useState("");
  const [panning, setPanning] = useState(false);
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false });
  const [historyRevision, setHistoryRevision] = useState(0);
  const [maskLayerSelection, setMaskLayerSelection] = useState<Record<string, string>>({});
  const [maskPointSelection, setMaskPointSelection] = useState<{ layerId: string; index: number } | null>(null);
  const [editMaskOnSource, setEditMaskOnSource] = useState(true);
  const [activeTrackingPoint, setActiveTrackingPoint] = useState(0);
  const [trackingProgress, setTrackingProgress] = useState<{ time: number; end: number } | null>(null);
  const [trackingRecovery, setTrackingRecovery] = useState<{ id: string; anchors: TrackingPoint[] } | null>(null);
  const mediaRef = useRef<Record<string, Media>>({});
  const previewRef = useRef<HTMLCanvasElement>(null);
  const channelRef = useRef<HTMLCanvasElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const viewerPanelRef = useRef<HTMLElement>(null);
  const viewerDividerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewerResizeRef = useRef<ViewerResizeDrag | null>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const drawing = useRef<Promise<void>>(Promise.resolve());
  const flowRef = useRef<ReactFlowInstance<CompNode, Edge> | null>(null);
  const history = useRef(new CompositorHistory<HistorySnapshot>(HISTORY_LIMIT));
  const historyGroup = useRef<{ recorded: boolean; type: "text" | "pointer"; target: EventTarget } | null>(null);
  const restoringHistory = useRef(false);
  const trackingCancelled = useRef(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const selectedNode = nodes.find((node) => node.id === selected);
  const selectedMaskLayers = selectedNode?.data.kind === "mask" ? getMaskLayers(selectedNode.data.params) : [];
  const selectedMaskLayerId = selectedNode ? maskLayerSelection[selectedNode.id] : undefined;
  const selectedMaskLayer = selectedMaskLayers.find((layer) => layer.id === selectedMaskLayerId) ?? selectedMaskLayers[0];
  const selectedMaskLayerIndex = selectedMaskLayers.findIndex((layer) => layer.id === selectedMaskLayer?.id);
  const selectedMaskGeometry = selectedMaskLayer ? maskGeometryAt(selectedMaskLayer, time) : undefined;
  const selectedMaskHasKeyframe = selectedMaskLayer ? hasMaskKeyframeAt(selectedMaskLayer, time) : false;
  const selectedMaskPoint = selectedMaskLayer && maskPointSelection?.layerId === selectedMaskLayer.id
    ? maskPointSelection.index : null;
  const selectedEdges = edges.filter((edge) => edge.selected);
  const viewer = nodes.find((node) => node.data.kind === "viewer");
  const viewerId = viewer?.id;
  const editingMask = selectedNode?.data.kind === "mask" && !selectedNode.data.disabled && editMaskOnSource;
  const maskInput = editingMask ? edges.find((edge) => edge.target === selectedNode.id && edge.targetHandle === "image") : undefined;
  const editingTracker = selectedNode?.data.kind === "tracker" && !selectedNode.data.disabled;
  const trackerInput = editingTracker ? edges.find((edge) => edge.target === selectedNode.id && edge.targetHandle === "image") : undefined;
  const previewTarget = editingMask ? maskInput?.source ?? selectedNode.id
    : editingTracker && trackerInput ? trackerInput.source : viewerId;
  const maskMotion = editingMask ? edges.find((edge) => edge.target === selectedNode.id && edge.targetHandle === "motion") : undefined;
  const motionNode = maskMotion ? nodes.find((node) => node.id === maskMotion.source) : undefined;
  const motionData = maskMotion && !motionNode?.data.disabled ? tracks[maskMotion.source] : undefined;
  const maskTracking = maskMotion && !motionNode?.data.disabled ? inspectTracking(motionData ?? [], time) : {};
  const maskMatrix = maskTracking.sample?.matrix ?? IDENTITY_TRACKING_MATRIX;
  const maskProjectionError = maskTracking.error || inspectMaskProjection(selectedMaskGeometry, maskMatrix);
  const trackerData = editingTracker ? tracks[selectedNode.id] : undefined;
  const trackSamples = trackerData ? Array.isArray(trackerData)
    ? trackerData.map((sample) => ({ time: sample.time, anchors: [{ x: sample.x, y: sample.y }], confidence: sample.confidence }))
    : trackerData.samples : [];
  const trackerPreview = trackerData ? inspectTracking(trackerData, time) : {};
  const recovery = editingTracker && trackingRecovery?.id === selectedNode.id && trackerData
    && !Array.isArray(trackerData) && !trackerData.complete && trackerData.samples.length > 0
    && Math.abs(trackerData.samples[trackerData.samples.length - 1].time - time) <= 0.001 ? trackingRecovery : null;
  const currentTrackerAnchors = recovery?.anchors ?? trackerPreview.sample?.anchors
    ?? (editingTracker ? trackerAnchors(selectedNode.data.params) : []);
  const trackerEditable = Boolean(editingTracker && trackerInput && !busy && (recovery || time <= 0.001));
  const pathStride = Math.max(1, Math.ceil(trackSamples.length / 1000));
  const trackerPaths = currentTrackerAnchors.map((_, index) =>
    trackSamples.filter((__, sampleIndex) => sampleIndex % pathStride === 0 || sampleIndex === trackSamples.length - 1)
      .map((sample) => sample.anchors[index]).filter((point): point is TrackingPoint => Boolean(point)));
  const showViewerHint = selectedNode && selectedNode.data.kind !== "viewer" && selectedNode.data.kind !== "tracker"
    && (!viewerId || !reachesCompositorNode(edges, selectedNode.id, viewerId));
  const durationFor = (id: string) => graphDuration(id, nodes, edges, mediaDurations);
  const duration = Math.max(viewer ? durationFor(viewer.id) : 0, trackerInput ? durationFor(trackerInput.source) : 0);
  const range = compositorRange(marks, duration);

  const measureViewerAvailableHeight = useCallback(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return COMPOSITOR_SPLIT_MIN_HEIGHT;
    const dividerHeight = viewerDividerRef.current?.getBoundingClientRect().height || VIEWER_DIVIDER_HEIGHT;
    return Math.max(COMPOSITOR_SPLIT_MIN_HEIGHT, workspace.clientHeight - dividerHeight);
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateAvailableHeight = () => {
      const next = measureViewerAvailableHeight();
      setViewerAvailableHeight((current) => current === next ? current : next);
    };
    const observer = new ResizeObserver(updateAvailableHeight);
    observer.observe(workspace);
    updateAvailableHeight();
    return () => observer.disconnect();
  }, [measureViewerAvailableHeight]);

  const handleViewerDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || busy) return;
    const viewerPanel = viewerPanelRef.current;
    if (!viewerPanel) return;
    event.preventDefault();
    viewerResizeRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startHeight: viewerPanel.getBoundingClientRect().height,
      availableHeight: measureViewerAvailableHeight(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingViewer(true);
  };

  const handleViewerDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = viewerResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const maxHeight = Math.max(VIEWER_MIN_HEIGHT, drag.availableHeight - GRAPH_MIN_HEIGHT);
    const height = Math.min(maxHeight, Math.max(
      VIEWER_MIN_HEIGHT,
      drag.startHeight + event.clientY - drag.startClientY,
    ));
    setViewerRatio(getViewerFlexRatio(height, drag.availableHeight));
  };

  const finishViewerDividerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (viewerResizeRef.current?.pointerId !== event.pointerId) return;
    viewerResizeRef.current = null;
    setResizingViewer(false);
  };

  const handleViewerDividerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (busy) return;
    const availableHeight = measureViewerAvailableHeight();
    const viewerHeight = viewerPanelRef.current?.getBoundingClientRect().height
      ?? VIEWER_MIN_HEIGHT + viewerRatio * Math.max(0, availableHeight - COMPOSITOR_SPLIT_MIN_HEIGHT);
    const maxHeight = Math.max(VIEWER_MIN_HEIGHT, availableHeight - GRAPH_MIN_HEIGHT);
    let nextHeight: number;
    switch (event.key) {
      case "ArrowUp":
        nextHeight = viewerHeight - 24;
        break;
      case "ArrowDown":
        nextHeight = viewerHeight + 24;
        break;
      case "Home":
        nextHeight = VIEWER_MIN_HEIGHT;
        break;
      case "End":
        nextHeight = maxHeight;
        break;
      default:
        return;
    }
    event.preventDefault();
    setViewerRatio(getViewerFlexRatio(
      Math.min(maxHeight, Math.max(VIEWER_MIN_HEIGHT, nextHeight)),
      availableHeight,
    ));
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1);
      setViewerTransform((current) => zoomViewerAt(current, Math.exp(-delta * 0.0015),
        event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (hidden || !ready || !nodes.length) return;
    let frame = 0, attempts = 0;
    const fit = () => {
      const instance = flowRef.current;
      const measured = instance?.getNodes();
      if (instance && measured?.length === nodes.length && measured.every((node) => node.measured?.width && node.measured?.height)) {
        void instance.fitView({ padding: 0.2 });
      } else if (attempts++ < 60) frame = requestAnimationFrame(fit);
    };
    frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [hidden, ready, nodes.length, templateVersion]);

  useEffect(() => {
    if (!projectSessionReady) return;
    let active = true;
    const load = projectSession && projectId
      ? loadProjectCompositorState(projectSession.handle, projectId)
      : loadProject();
    load.then((project) => {
      if (!active) return;
      if (project) {
        setNodes(project.nodes);
        setEdges(project.edges);
        setFiles("media" in project ? project.media : {});
        setMediaReferences(project.mediaRefs ?? {});
        setMediaMetadata(normalizeMediaAssetMetadataMap(project.mediaMetadata));
        setTracks(project.tracks ?? {});
        setMarks(project.marks ?? EMPTY_COMPOSITOR_MARKS);
        setTime(project.time ?? 0);
        setViewerTransform(project.viewerTransform ?? DEFAULT_VIEWER_TRANSFORM);
        setPreviewBackground(project.previewBackground === "color" ? "color" : "checkerboard");
        setPreviewColor(project.previewColor ?? "#ffffff");
        setViewChannel(project.viewChannel === "red" || project.viewChannel === "green"
          || project.viewChannel === "blue" || project.viewChannel === "alpha" ? project.viewChannel : "rgb");
        setSelected(project.nodes.find((node) => node.selected)?.id ?? "");
      } else {
        setFiles({});
        setMediaMetadata({});
        setMediaReferences({});
        setTracks({});
        setMarks(EMPTY_COMPOSITOR_MARKS);
        setTime(0);
        setViewerTransform(DEFAULT_VIEWER_TRANSFORM);
        setPreviewBackground("checkerboard");
        setPreviewColor("#ffffff");
        setViewChannel("rgb");
        setNodes([{ id: crypto.randomUUID(), type: "comp", position: { x: 700, y: 120 },
          data: { kind: "viewer", label: labels.viewer, params: {} } }]);
      }
      setReady(true); setStatus(projectId ? "Project loaded" : "Project loaded locally");
    }).catch((caught) => { if (active) { setError(caught instanceof Error ? caught.message : String(caught)); setStatus("Project could not be loaded"); } });
    return () => { active = false; };
  }, [projectId, projectSession, projectSessionReady, setNodes, setEdges]);

  const saveCompositorNow = useCallback(async () => {
    if (!ready) throw new Error("The compositor is still loading and cannot be saved yet.");
    const state: ProjectCompositorState = {
      nodes,
      edges,
      mediaRefs: mediaReferences,
      mediaMetadata,
      tracks,
      marks,
      time,
      viewerTransform,
      previewBackground,
      previewColor,
      viewChannel,
    };
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      if (projectHandle && projectId) {
        if (Object.keys(files).length) {
          throw new Error("Copy compositor media into the project before saving its graph.");
        }
        await saveProjectCompositorState(projectHandle, projectId, state);
      } else {
        const localMedia = Object.fromEntries(Object.entries(files).filter(([id]) => !mediaReferences[id]));
        await saveProject({
          ...state,
          media: localMedia,
        });
      }
    });
    setStatus("Saving...");
    try {
      await saveQueue.current;
      setStatus(projectId ? "Saved to project folder" : "Saved locally");
    } catch (caught) {
      setStatus("Save failed");
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    }
  }, [
    ready,
    nodes,
    edges,
    mediaReferences,
    mediaMetadata,
    tracks,
    marks,
    time,
    viewerTransform,
    previewBackground,
    previewColor,
    viewChannel,
    files,
    projectHandle,
    projectId,
  ]);
  const saveCompositorNowRef = useRef(saveCompositorNow);

  useEffect(() => {
    saveCompositorNowRef.current = saveCompositorNow;
  }, [saveCompositorNow]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => { void saveCompositorNow().catch(() => {}); }, 500);
    return () => window.clearTimeout(timer);
  }, [ready, mediaVersion, saveCompositorNow]);

  useEffect(() => {
    const save = () => saveCompositorNowRef.current();
    onRegisterSaveHandler?.(save);
    return () => onRegisterSaveHandler?.(null);
  }, [onRegisterSaveHandler]);

  useEffect(() => {
    let active = true;
    const pending = Object.entries(files).map(async ([id, file]) => {
      if (mediaRef.current[id] && !mediaRef.current[id].projectAssetId) return;
      const loaded = await createMedia(file);
      if (!active) { URL.revokeObjectURL(loaded.url); return; }
      mediaRef.current[id] = loaded;
      setMediaDurations((current) => ({ ...current, [id]: loaded.duration }));
      setMediaVersion((value) => value + 1);
      setMediaMetadata((current) => {
        const saved = normalizeMediaAssetMetadata(current[id]);
        return {
          ...current,
          [id]: {
            ...saved,
            width: loaded.metadata.width ?? saved.width,
            height: loaded.metadata.height ?? saved.height,
            durationSeconds: loaded.metadata.durationSeconds ?? saved.durationSeconds,
          },
        };
      });
    });
    Promise.all(pending).catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { active = false; };
  }, [files]);
  useEffect(() => {
    let active = true;
    const pending = Object.entries(mediaReferences).map(async ([id, assetId]) => {
      const asset = sharedMediaAssets.find((candidate) => candidate.id === assetId);
      const revision = asset?.revision ?? 0;
      if (mediaRef.current[id]?.projectAssetId === assetId
        && mediaRef.current[id]?.projectAssetRevision === revision) return;
      const file = await loadProjectMediaFile(assetId, revision);
      const loaded = await createMedia(file);
      if (!active) { URL.revokeObjectURL(loaded.url); return; }
      const previous = mediaRef.current[id];
      if (previous) URL.revokeObjectURL(previous.url);
      mediaRef.current[id] = { ...loaded, projectAssetId: assetId, projectAssetRevision: revision };
      setMediaDurations((current) => ({ ...current, [id]: loaded.duration }));
      setMediaVersion((value) => value + 1);
      setMediaMetadata((current) => ({
        ...current,
        [id]: {
          ...normalizeMediaAssetMetadata(asset?.metadata),
          width: loaded.metadata.width,
          height: loaded.metadata.height,
          durationSeconds: loaded.metadata.durationSeconds,
        },
      }));
    });
    Promise.all(pending).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [mediaReferences, sharedMediaAssets]);
  useEffect(() => () => {
    Object.values(mediaRef.current).forEach((item) => URL.revokeObjectURL(item.url));
    mediaRef.current = {};
  }, []);

  const draw = (at: number) => drawPreview(previewRef.current, nodes, edges, mediaRef.current, tracks, viewerId, at);
  useEffect(() => {
    if (hidden || busy || !previewTarget) return;
    let active = true;
    drawing.current = drawing.current.catch(() => {}).then(async () => {
      if (!active) return;
      try {
        await drawPreview(previewRef.current, nodes, edges, mediaRef.current, tracks, previewTarget, time);
        if (active && previewRef.current && channelRef.current && viewChannel !== "rgb") {
          const output = context(channelRef.current);
          output.clearRect(0, 0, WIDTH, HEIGHT);
          output.drawImage(previewRef.current, 0, 0);
          const image = output.getImageData(0, 0, WIDTH, HEIGHT);
          for (let i = 0; i < image.data.length; i += 4) {
            const channel = viewChannel === "alpha" ? 3 : viewChannel === "red" ? 0 : viewChannel === "green" ? 1 : 2;
            const v = image.data[i + channel];
            image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v;
            if (channel === 3) image.data[i + 3] = 255;
          }
          output.putImageData(image, 0, 0);
        }
        if (active) setRenderError("");
      }
      catch (caught) {
        if (active) {
          if (previewRef.current) context(previewRef.current).clearRect(0, 0, WIDTH, HEIGHT);
          if (channelRef.current) context(channelRef.current).clearRect(0, 0, WIDTH, HEIGHT);
          setRenderError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    });
    return () => { active = false; };
  }, [nodes, edges, tracks, time, hidden, busy, previewTarget, mediaVersion, viewChannel]);
  useEffect(() => {
    if (!playing || hidden || busy || !duration) return;
    const timer = window.setInterval(() => setTime((current) => nextCompositorTime(current, range.start, range.end)), 100);
    return () => window.clearInterval(timer);
  }, [playing, hidden, busy, duration, range.start, range.end]);
  useEffect(() => {
    const timer = window.setTimeout(() => setTime((current) => Math.min(current, duration)), 0);
    return () => window.clearTimeout(timer);
  }, [duration]);
  useEffect(() => {
    if (!hidden) return;
    const timer = window.setTimeout(() => setPlaying(false), 0);
    return () => window.clearTimeout(timer);
  }, [hidden]);

  const snapshot = (): HistorySnapshot => ({
    nodes,
    edges,
    files,
    mediaRefs: mediaReferences,
    mediaMetadata,
    tracks,
    selected,
    marks,
  });
  const updateHistoryAvailability = () => setHistoryAvailability({ undo: history.current.canUndo, redo: history.current.canRedo });
  const recordHistory = () => {
    if (historyGroup.current?.recorded) return;
    history.current.record(snapshot());
    if (historyGroup.current) historyGroup.current.recorded = true;
    updateHistoryAvailability();
  };
  const restoreHistory = async (direction: "undo" | "redo") => {
    if (busy || !ready || restoringHistory.current) return;
    const next = history.current.peek(direction);
    if (!next) return;
    restoringHistory.current = true;
    historyGroup.current = null;
    setBusy(true); setPlaying(false);
    const loaded: Record<string, Media> = {};
    try {
      for (const [id, file] of Object.entries(next.files)) {
        const current = mediaRef.current[id];
        if (files[id] !== file || !current || current.projectAssetId) loaded[id] = await createMedia(file);
      }
      for (const [id, assetId] of Object.entries(next.mediaRefs)) {
        const revision = sharedMediaAssets.find((asset) => asset.id === assetId)?.revision ?? 0;
        if (mediaRef.current[id]?.projectAssetId !== assetId
          || mediaRef.current[id]?.projectAssetRevision !== revision) {
          loaded[id] = {
            ...await createMedia(await loadProjectMediaFile(assetId, revision)),
            projectAssetId: assetId,
            projectAssetRevision: revision,
          };
        }
      }
      await drawing.current;
      for (const [id, item] of Object.entries(mediaRef.current)) {
        if ((!next.files[id] && !next.mediaRefs[id]) || loaded[id]) {
          URL.revokeObjectURL(item.url);
          delete mediaRef.current[id];
        }
      }
      Object.assign(mediaRef.current, loaded);
      const current = snapshot();
      history.current.complete(direction, current);
      setNodes(next.nodes); setEdges(next.edges); setFiles(next.files); setMediaReferences(next.mediaRefs);
      setMediaMetadata(next.mediaMetadata);
      setTracks(next.tracks); setMarks(next.marks);
      const durations = Object.fromEntries(Object.entries(mediaRef.current).map(([id, item]) => [id, item.duration]));
      setMediaDurations(durations);
      setSelected(next.nodes.some((node) => node.id === next.selected) ? next.selected : "");
      setMediaVersion((version) => version + 1);
      setHistoryRevision((revision) => revision + 1);
      const nextViewer = next.nodes.find((node) => node.data.kind === "viewer");
      const nextDuration = nextViewer ? graphDuration(nextViewer.id, next.nodes, next.edges, durations) : 0;
      setPickingKey(""); setTrackingRecovery(null); setTime((currentTime) => Math.min(currentTime, nextDuration)); setError(""); setRenderError("");
      updateHistoryAvailability();
    } catch (caught) {
      Object.values(loaded).forEach((item) => URL.revokeObjectURL(item.url));
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { restoringHistory.current = false; setBusy(false); }
  };
  const addNode = (option: CompositorNodeOption) => {
    if (option.kind === "viewer" && viewer) return;
    recordHistory();
    const id = crypto.randomUUID();
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })),
      { ...createCompositorNode(option, id,
        { x: 30 + ((current.length - 1) % 3) * 210, y: 40 + Math.floor((current.length - 1) / 3) * 140 }), selected: true }]);
    setSelected(id);
  };
  const applyTemplate = async (id: TemplateId, mode: "add" | "replace") => {
    const template = COMPOSITOR_TEMPLATES.find((item) => item.id === id);
    if (!template || busy || !ready) return;
    if (mode === "replace" && !window.confirm(`Load the ${template.name} template? This replaces the current compositor project, including its uploaded media and tracking data.`)) return;
    setPlaying(false); setBusy(true);
    try {
      await drawing.current;
      const graph = createCompositorTemplate(id, () => crypto.randomUUID());
      const appended = mode === "add" ? appendCompositorTemplate(nodes, edges, graph) : undefined;
      recordHistory();
      if (appended) {
        setNodes(appended.nodes); setEdges(appended.edges); setSelected(appended.selectedId);
      } else {
        Object.values(mediaRef.current).forEach((item) => URL.revokeObjectURL(item.url));
        mediaRef.current = {};
        setFiles({}); setMediaReferences({}); setMediaMetadata({}); setMediaDurations({}); setTracks({}); setMarks(EMPTY_COMPOSITOR_MARKS);
        setNodes(graph.nodes); setEdges(graph.edges); setSelected(graph.nodes[0].id); setTime(0);
      }
      setError(""); setRenderError("");
      setTemplateVersion((version) => version + 1);
      setStatus(mode === "add" ? `${template.name} added to canvas` : `${template.name} template loaded`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };
  const invalidateTracksFrom = (source: string) => {
    const dependsOn = (id: string, visited = new Set<string>()): boolean => {
      if (id === source) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return edges.some((edge) => edge.target === id && dependsOn(edge.source, visited));
    };
    setTracks((current) => Object.fromEntries(
      Object.entries(current).filter(([trackerId]) => !dependsOn(trackerId)),
    ));
  };
  const toggleSelectedNodes = () => {
    if (busy || !ready || selectedEdges.length) return false;
    const flowSelection = nodes.filter((node) => node.selected);
    const targets = flowSelection.length ? flowSelection : selectedNode ? [selectedNode] : [];
    if (!targets.length) return false;
    const ids = new Set(targets.map((node) => node.id));
    const disabled = targets.some((node) => !node.data.disabled);
    historyGroup.current = null;
    recordHistory();
    setNodes((current) => current.map((node) => ids.has(node.id)
      ? { ...node, data: { ...node.data, disabled } } : node));
    setTracks((current) => Object.fromEntries(Object.entries(current).filter(([trackerId]) =>
      !targets.some((node) => node.id !== trackerId && reachesCompositorNode(edges, node.id, trackerId)))));
    setError("");
    return true;
  };
  const setMarker = (which: "inPoint" | "outPoint", value: number) => {
    if (!duration || busy || !ready) return;
    const at = Math.max(0, Math.min(duration, value));
    if (which === "inPoint" ? at >= range.end : at <= range.start) {
      setError("The In point must be before the Out point.");
      return;
    }
    if (marks[which] === at) return;
    recordHistory();
    setMarks((current) => which === "inPoint"
      ? { inPoint: at, outPoint: current.outPoint === null ? null : range.end }
      : { inPoint: current.inPoint === null ? null : range.start, outPoint: at });
    setError("");
  };
  const clearMarks = () => {
    if (marks.inPoint === null && marks.outPoint === null) return;
    recordHistory();
    setMarks(EMPTY_COMPOSITOR_MARKS);
    setError("");
  };
  const handleCompositorShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (hidden || busy || !ready) return;
    const target = event.target;
    if (!event.defaultPrevented && !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey
      && !event.altKey && !event.shiftKey && ["i", "o"].includes(event.key.toLowerCase())
      && !(target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]")))) {
      if (duration) {
        event.preventDefault();
        setMarker(event.key.toLowerCase() === "i" ? "inPoint" : "outPoint", Math.min(time, duration));
      }
      return;
    }
    if (!event.defaultPrevented && !event.repeat && !event.isComposing && !event.ctrlKey && !event.metaKey
      && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d"
      && !(target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]")))) {
      if (toggleSelectedNodes()) event.preventDefault();
      return;
    }
    let editingText = false;
    if (target instanceof HTMLElement) {
      editingText = target.isContentEditable || target instanceof HTMLTextAreaElement
        || target instanceof HTMLInputElement
        && ["text", "search", "email", "url", "tel", "password"].includes(target.type)
        && !(target.getAttribute("role") === "spinbutton" && target.closest(".comp-inspector"));
    }
    const direction = compositorHistoryShortcut(event, editingText);
    if (!direction) return;
    event.preventDefault();
    void restoreHistory(direction);
  });
  useEffect(() => {
    if (hidden) return;
    const handleKeyDown = (event: KeyboardEvent) => handleCompositorShortcut(event);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hidden]);
  const updateParams = (values: CompositorParams) => {
    if (!selectedNode || Object.entries(values).every(([key, value]) => JSON.stringify(selectedNode.data.params[key]) === JSON.stringify(value))) return;
    recordHistory();
    invalidateTracksFrom(selected);
    setNodes((current) => current.map((node) => node.id === selected
      ? { ...node, data: { ...node.data, params: { ...node.data.params, ...values } } } : node));
  };
  const update = (key: string, value: CompositorParamValue) => updateParams({ [key]: value });
  const updateMaskLayer = (layer: MaskLayer) => {
    if (!selectedNode || selectedNode.data.kind !== "mask") return;
    update("layers", selectedMaskLayers.map((current) => current.id === layer.id ? layer : current));
  };
  const addMaskLayer = (kind: MaskShapeKind) => {
    if (!selectedNode || selectedNode.data.kind !== "mask") return;
    const layer = createMaskLayer(kind, crypto.randomUUID());
    update("layers", [...selectedMaskLayers, layer]);
    setEditMaskOnSource(true);
    setPlaying(false);
    setMaskLayerSelection((current) => ({ ...current, [selectedNode.id]: layer.id }));
  };
  const moveMaskLayer = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= selectedMaskLayers.length) return;
    const next = [...selectedMaskLayers];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    next[0] = { ...next[0], operation: "add" };
    update("layers", next);
  };
  const updateMaskBounds = (key: "x" | "y" | "width" | "height", value: number) => {
    if (!selectedMaskLayer || !selectedMaskGeometry || !("x" in selectedMaskGeometry)) return;
    updateMaskLayer(updateMaskGeometry(selectedMaskLayer, { ...selectedMaskGeometry, [key]: value }, time));
  };
  const updateTrackerAnchor = (index: number, point: TrackingPoint) => {
    if (!selectedNode || selectedNode.data.kind !== "tracker") return;
    if (recovery) {
      setTrackingRecovery({ ...recovery, anchors: recovery.anchors.map((anchor, i) => i === index ? point : anchor) });
      return;
    }
    if (trackerMode(selectedNode.data.params) === "planar") {
      updateParams({ [`planeX${index + 1}`]: point.x, [`planeY${index + 1}`]: point.y });
    } else {
      updateParams(index === 0 ? { x: point.x, y: point.y } : { x2: point.x, y2: point.y });
    }
  };
  const pickKeyColor = async (x: number, y: number) => {
    const edge = edges.find((item) => item.target === selected && item.targetHandle === "image");
    if (!edge) { setError("Connect the Keyer's image input before picking a color."); setPickingKey(""); return; }
    setBusy(true); setPlaying(false);
    try {
      await drawing.current;
      const source = await renderGraph(nodes, edges, mediaRef.current, tracks, edge.source, time);
      const pixel = context(source).getImageData(x, y, 1, 1).data;
      if (!pixel[3]) throw new Error("Cannot pick a color from a transparent pixel.");
      update("color", `#${Array.from(pixel.slice(0, 3)).map((v) => v.toString(16).padStart(2, "0")).join("")}`);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setPickingKey(""); setBusy(false); }
  };
  const connect = (connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source);
    const target = nodes.find((node) => node.id === connection.target);
    if (!source || !target || !connection.targetHandle) return;
    const motion = connection.targetHandle === "motion";
    if ((source.data.kind === "tracker") !== motion || source.id === target.id) {
      setError(motion ? "A motion input requires a Tracker." : "Connect an image output to this input.");
      return;
    }
    if (reachesCompositorNode(edges, target.id, source.id)) { setError("Connections cannot create a cycle."); return; }
    recordHistory();
    setEdges((current) => addEdge(connection, current.filter((edge) =>
      edge.target !== connection.target || edge.targetHandle !== connection.targetHandle)));
    invalidateTracksFrom(target.id); setError("");
  };
  const chooseFile = async (file?: File) => {
    if (!file || !selectedNode) return;
    if (file.size > 200 * 1024 * 1024) { setError("Media files must be 200 MB or smaller."); return; }
    setBusy(true);
    let loaded: Media | undefined;
    try {
      const media = await createMedia(file);
      loaded = media;
      let projectAssetId: string | undefined;
      let projectAssetRevision: number | undefined;
      if (projectSession && projectId) {
        const { manifest } = await readOrCreateProjectManifest(projectSession.handle);
        if (manifest.id !== projectId) throw new Error("The project folder changed before compositor media could be added.");
        const id = `compositor-${crypto.randomUUID()}`;
        const mediaAsset: ProjectMediaAsset = {
          id,
          name: file.name,
          mediaKind: file.type.startsWith("image/") ? "image" : "video",
          mimeType: file.type || null,
          source: { kind: "storage", storageKey: id },
          metadata: media.metadata,
        };
        const updatedManifest = await addMediaToProjectFolder(projectSession.handle, manifest, mediaAsset, file);
        const registered = await registerProjectMediaAsset(mediaAsset, file);
        projectAssetId = id;
        projectAssetRevision = registered.revision;
        onProjectSessionChange?.(projectSession);
        await onProjectMediaChange?.();
        if (updatedManifest.id !== projectId) throw new Error("The compositor media was added to a different project.");
      }
      await drawing.current;
      recordHistory();
      const old = mediaRef.current[selectedNode.id];
      if (old) URL.revokeObjectURL(old.url);
      mediaRef.current[selectedNode.id] = {
        ...media,
        projectAssetId,
        projectAssetRevision,
      };
      setMediaDurations((current) => ({ ...current, [selectedNode.id]: media.duration }));
      setMediaMetadata((current) => ({ ...current, [selectedNode.id]: media.metadata }));
      if (projectAssetId) {
        const assetId = projectAssetId;
        setMediaReferences((current) => ({ ...current, [selectedNode.id]: assetId }));
        setFiles((current) => {
          const next = { ...current };
          delete next[selectedNode.id];
          return next;
        });
      } else {
        setMediaReferences((current) => {
          const next = { ...current };
          delete next[selectedNode.id];
          return next;
        });
        setFiles((current) => ({ ...current, [selectedNode.id]: file }));
      }
      setMediaVersion((current) => current + 1); setTracks({}); setTime(0); setError("");
    } catch (caught) {
      if (loaded && !Object.values(mediaRef.current).some((item) => item.url === loaded?.url)) {
        URL.revokeObjectURL(loaded.url);
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    finally { setBusy(false); }
  };
  const chooseSharedAsset = async (assetId: string) => {
    if (!selectedNode || selectedNode.data.kind !== "media" || !assetId) return;
    const asset = sharedMediaAssets.find((candidate) => candidate.id === assetId);
    if (!asset) { setError("The selected shared media asset is unavailable."); return; }
    setBusy(true);
    try {
      const loaded = await createMedia(await loadProjectMediaFile(assetId, asset.revision ?? 0));
      await drawing.current;
      recordHistory();
      const old = mediaRef.current[selectedNode.id];
      if (old) URL.revokeObjectURL(old.url);
      mediaRef.current[selectedNode.id] = {
        ...loaded,
        projectAssetId: assetId,
        projectAssetRevision: asset.revision ?? 0,
      };
      setMediaDurations((current) => ({ ...current, [selectedNode.id]: loaded.duration }));
      setMediaMetadata((current) => ({
        ...current,
        [selectedNode.id]: {
          ...normalizeMediaAssetMetadata(asset.metadata),
          width: loaded.metadata.width,
          height: loaded.metadata.height,
          durationSeconds: loaded.metadata.durationSeconds,
        },
      }));
      setMediaReferences((current) => ({ ...current, [selectedNode.id]: assetId }));
      setFiles((current) => {
        const next = { ...current };
        delete next[selectedNode.id];
        return next;
      });
      setMediaVersion((current) => current + 1); setTracks({}); setTime(0); setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };
  const chooseMediaFile = async () => {
    if (!projectSession) {
      mediaInputRef.current?.click();
      return;
    }
    try {
      const filesInProject = await chooseProjectMediaFiles(projectSession.handle, false);
      if (filesInProject === null) {
        mediaInputRef.current?.click();
      } else if (filesInProject[0]) {
        await chooseFile(filesInProject[0]);
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Could not choose compositor media.");
    }
  };
  const runTracking = async (resume = false) => {
    if (!selectedNode || selectedNode.data.kind !== "tracker") return;
    if (selectedNode.data.disabled) { setError("Enable the Tracker before tracking."); return; }
    const edge = edges.find((item) => item.target === selectedNode.id && item.targetHandle === "image");
    if (!edge) { setError("Connect a video to the Tracker image input."); return; }
    const trackDuration = durationFor(edge.source);
    if (!trackDuration) { setError("Tracking requires a video source."); return; }
    const existing = tracks[selectedNode.id];
    if (resume && (!existing || Array.isArray(existing) || existing.complete || !existing.samples.length || !recovery)) {
      setError("There is no interrupted track to resume."); return;
    }
    const mode = trackerMode(selectedNode.data.params);
    const rate = Math.max(1, Math.min(15, number(selectedNode.data.params, "sampleRate", 5)));
    const samples: TrackingSample[] = resume && existing && !Array.isArray(existing)
      ? existing.samples.map((sample) => ({ ...sample, anchors: sample.anchors.map((point) => ({ ...point })) })) : [];
    let anchors = resume && recovery ? recovery.anchors.map((point) => ({ ...point })) : trackerAnchors(selectedNode.data.params);
    let failure = "";
    let completed = false;
    trackingCancelled.current = false;
    setPlaying(false); setBusy(true); setError(""); setStatus("Tracking...");
    try {
      await drawing.current;
      const small = document.createElement("canvas"); small.width = 320; small.height = 180;
      const ctx = context(small);
      const readFrame = async (at: number) => {
        ctx.clearRect(0, 0, 320, 180);
        ctx.drawImage(await renderGraph(nodes, edges, mediaRef.current, tracks, edge.source, at), 0, 0, 320, 180);
        return ctx.getImageData(0, 0, 320, 180).data;
      };
      if (anchors.some((point) => point.x < 10 || point.x >= 630 || point.y < 10 || point.y >= 350)) {
        throw new Error("Choose tracking points away from the image edge.");
      }
      if (mode === "planar") { validateTrackingSurface(anchors); planarTrackingMatrix(anchors, anchors); }
      else similarityTrackingMatrix(anchors, anchors);
      const start = samples.length ? samples[samples.length - 1].time : 0;
      let previous = await readFrame(start);
      let features: TrackingPoint[] = [];
      if (mode === "planar") features = detectPlanarFeatures(previous, 320, 180, anchors.map((point) => ({ x: point.x / 2, y: point.y / 2 })));
      else for (const point of anchors) trackPatch(previous, previous, 320, 180, Math.round(point.x / 2), Math.round(point.y / 2));
      if (!samples.length) samples.push({ time: 0, matrix: IDENTITY_TRACKING_MATRIX, anchors, confidence: 1 });
      else {
        const initial = samples.length === 1 ? anchors : samples[0].anchors;
        const matrix = mode === "planar" ? planarTrackingMatrix(initial, anchors) : similarityTrackingMatrix(initial, anchors);
        validateTrackingProjection(matrix);
        samples[samples.length - 1] = { ...samples[samples.length - 1], anchors, matrix };
      }
      const initial = samples[0].anchors;
      const lastTime = Math.max(0, trackDuration - 0.001);
      for (let index = 1; start + (index - 1) / rate < lastTime; index++) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (trackingCancelled.current) { failure = "Tracking stopped."; break; }
        const at = Math.min(start + index / rate, lastTime);
        setTrackingProgress({ time: at, end: trackDuration });
        const pixels = await readFrame(at);
        let confidence = 1;
        if (mode === "planar") {
          const result = trackPlanarFeatures(previous, pixels, 320, 180, features);
          features = result.features;
          anchors = anchors.map((point) => {
            const mapped = transformTrackingPoint(result.matrix, { x: point.x / 2, y: point.y / 2 });
            return { x: mapped.x * 2, y: mapped.y * 2 };
          });
          validateTrackingSurface(anchors);
          confidence = result.confidence;
        } else {
          anchors = anchors.map((point) => {
            const x = Math.round(point.x / 2), y = Math.round(point.y / 2);
            if (x < 5 || x >= 315 || y < 5 || y >= 175) throw new Error("A tracked feature moved too close to the image edge.");
            const match = trackPatch(previous, pixels, 320, 180, x, y);
            if (match.confidence < 0.8) throw new Error("A tracking feature was lost.");
            confidence = Math.min(confidence, match.confidence);
            return { x: match.x * 2, y: match.y * 2 };
          });
        }
        const matrix = mode === "planar" ? planarTrackingMatrix(initial, anchors) : similarityTrackingMatrix(initial, anchors);
        validateTrackingProjection(matrix);
        samples.push({ time: at, matrix, anchors, confidence });
        previous = pixels;
      }
      completed = !failure;
    } catch (caught) { failure = caught instanceof Error ? caught.message : String(caught); }
    finally {
      if (samples.length) {
        const result: TrackingResult = { mode, samples, complete: completed, endTime: trackDuration };
        recordHistory();
        setTracks((current) => ({ ...current, [selectedNode.id]: result }));
        const last = samples[samples.length - 1];
        setTrackingRecovery(completed ? null : { id: selectedNode.id, anchors: last.anchors });
        if (!completed) setTime(last.time);
        setStatus(completed ? `Tracked ${samples.length} samples` : `Tracking paused at ${last.time.toFixed(1)} s`);
      } else setStatus("Tracking failed");
      if (failure) setError(`${failure}${samples.length ? " Adjust the markers and resume." : ""}`);
      setTrackingProgress(null); setBusy(false);
    }
  };
  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportImage = async () => {
    setBusy(true);
    try {
      await drawing.current;
      await draw(time);
      const blob = await new Promise<Blob | null>((resolve) => previewRef.current?.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Could not export image.");
      download(blob, "composite.png"); setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const sendFrameToWorkflow = async () => {
    if (!onSendFrameToWorkflow) return;
    setBusy(true);
    try {
      await drawing.current;
      await draw(time);
      const dataUrl = previewRef.current?.toDataURL("image/png");
      if (!dataUrl) throw new Error("Could not encode the compositor frame.");
      onSendFrameToWorkflow(dataUrl, time);
      setError("");
      setStatus(`Frame sent to Workflow · 640 × 360 at ${time.toFixed(1)} s`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const exportVideo = async () => {
    const exportDuration = range.end - range.start;
    if (!exportDuration || exportDuration > 60) { setError("Video export requires a marked range no longer than 60 seconds."); return; }
    if (!previewRef.current || !window.MediaRecorder || !MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) {
      setError("This browser does not support WebM video export."); return;
    }
    setBusy(true); setPlaying(false); setError(""); setStatus("Exporting video...");
    const stream = previewRef.current.captureStream(10);
    let recorder: MediaRecorder | undefined;
    try {
      await drawing.current;
      await draw(range.start);
      recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks: Blob[] = [];
      const finished = new Promise<Blob>((resolve, reject) => {
        recorder!.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder!.onerror = () => reject(new Error("Video recording failed."));
        recorder!.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      });
      finished.catch(() => {});
      recorder.start();
      await renderVideoFrames(range.start, exportDuration, draw);
      recorder.stop();
      const blob = await finished;
      if (!blob.size) throw new Error("Video export returned an empty file.");
      download(blob, "composite.webm"); setStatus("Video exported");
    } catch (caught) {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      setError(caught instanceof Error ? caught.message : String(caught)); setStatus("Export failed");
    } finally { stream.getTracks().forEach((track) => track.stop()); setBusy(false); }
  };
  const params = selectedNode?.data.params;
  const colorField = (key: string, label: string, min: number, max: number, fallback = 0, step = 1) => (
    <ColorNumberField key={`${selected}:${key}:${historyRevision}`} label={label} min={min} max={max} step={step} disabled={busy}
      value={number(params ?? {}, key, fallback)} onChange={(value) => update(key, value)} />
  );
  const keyRange = (key: string, label: string, min: number, max: number, fallback: number) => (
    <label key={key}>{label}: {number(params ?? {}, key, fallback)}
      <input type="range" min={min} max={max} step="1" disabled={busy}
        value={number(params ?? {}, key, fallback)} onChange={(event) => update(key, Number(event.target.value))} />
    </label>
  );
  const viewerFlexibleHeight = Math.max(0, viewerAvailableHeight - COMPOSITOR_SPLIT_MIN_HEIGHT);
  const currentViewerHeight = VIEWER_MIN_HEIGHT + viewerRatio * viewerFlexibleHeight;
  const viewerMinValue = Math.round(VIEWER_MIN_HEIGHT / viewerAvailableHeight * 100);
  const viewerMaxValue = Math.round(
    (viewerAvailableHeight - GRAPH_MIN_HEIGHT) / viewerAvailableHeight * 100,
  );
  return <main className="comp-layout" hidden={hidden} onKeyDownCapture={(event) => {
    if (busy || event.ctrlKey || event.metaKey || event.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.classList.contains("react-flow__node")
      && nodes.some((node) => node.selected && node.draggable !== false)) recordHistory();
  }}>
    <aside className="comp-sidebar">
      <h1>Compositor</h1>
      <p>Node-based compositing</p>
      <div className="comp-history">
        <button type="button" disabled={!ready || busy || !historyAvailability.undo} onClick={() => void restoreHistory("undo")} title="Undo (Ctrl/Cmd+Z)">Undo</button>
        <button type="button" disabled={!ready || busy || !historyAvailability.redo} onClick={() => void restoreHistory("redo")} title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)">Redo</button>
      </div>
      <div className="comp-buttons">
        {COMPOSITOR_NODE_OPTIONS.map((option) =>
          <button type="button" key={`${option.kind}:${option.label}`} onClick={() => addNode(option)}
            disabled={!ready || busy || option.kind === "viewer" && Boolean(viewer)}>+ {option.label}</button>)}
      </div>
      <p className="comp-status" role="status">{status}</p>
      {selectedEdges.length > 0 && <section className="comp-inspector" aria-label="Selected connections">
        <h2>{selectedEdges.length === 1 ? "Connection selected" : `${selectedEdges.length} connections selected`}</h2>
        <small>Press Delete or Backspace, or use the button below. The nodes will remain.</small>
        <button type="button" disabled={busy} onClick={() => {
          recordHistory();
          setTracks({});
          setEdges((current) => current.filter((edge) => !edge.selected));
        }}>Delete {selectedEdges.length === 1 ? "connection" : "connections"}</button>
      </section>}
      {selectedEdges.length === 0 && selectedNode && <section className="comp-inspector"
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLInputElement && !["file", "checkbox", "color", "range"].includes(event.target.type)) {
            historyGroup.current = { recorded: false, type: "text", target: event.target };
          }
        }}
        onBlurCapture={(event) => {
          if (historyGroup.current?.type === "text" && historyGroup.current.target === event.target) historyGroup.current = null;
        }}
        onPointerDownCapture={(event) => {
          const target = event.target;
          if (target instanceof Element && (target.closest(".comp-curve-graph, .comp-mask-editor") || target.matches('input[type="range"], input[type="color"]'))) {
            historyGroup.current = { recorded: false, type: "pointer", target };
          }
        }}
        onPointerUpCapture={() => { if (historyGroup.current?.type === "pointer") historyGroup.current = null; }}
        onPointerCancelCapture={() => { if (historyGroup.current?.type === "pointer") historyGroup.current = null; }}>
        <h2>{selectedNode.data.label}</h2>
        <button type="button" disabled={busy} onClick={() => toggleSelectedNodes()}>
          {selectedNode.data.disabled ? "Enable node" : "Disable node"} (D)
        </button>
        {showViewerHint && <div className="comp-viewer-hint">
          <p>This node is not connected to the Viewer, so its changes will not appear in the preview or export.</p>
          {viewerId ? <button type="button" disabled={busy} onClick={() => connect({
            source: selectedNode.id, sourceHandle: "output", target: viewerId, targetHandle: "image",
          })}>Show in Viewer</button> : <p>Add a Viewer to see this node.</p>}
          {viewerId && <small>Replaces the Viewer&apos;s current input. Connect the node&apos;s image input too.</small>}
        </div>}
        {selectedNode.data.kind === "media" && <>
          <label>Source
            <select disabled={busy} value={compositorMediaSource(params ?? {})} onChange={(event) => {
              update("sourceMode", event.target.value);
              if (event.target.value === "transparent") setPreviewBackground("checkerboard");
            }}>
              <option value="file">Image or video</option><option value="solid">Solid color</option>
              <option value="transparent">Transparent (checkerboard)</option>
            </select>
          </label>
          {params?.sourceMode === "solid" ? <label key="solid">Solid color (included in export)
            <input type="color" disabled={busy} value={String(params.solidColor ?? "#ffffff")} onChange={(event) => update("solidColor", event.target.value)} />
          </label> : params?.sourceMode === "transparent" ? <small>Checkerboard indicates transparency in the Viewer. PNG preserves transparency; WebM does not preserve alpha.</small> : <div key="file" className="comp-media-picker">
            <span>Image or video</span>
            <button type="button" disabled={busy} onClick={() => void chooseMediaFile()}
              title={projectSession ? "Choose a file starting in the project folder." : "Choose an image or video file."}>
              Choose file
            </button>
            <input ref={mediaInputRef} type="file" accept="image/*,video/*" hidden disabled={busy}
              aria-label="Choose image or video file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                void chooseFile(file);
              }}
            />
            <small>{files[selectedNode.id]?.name
              ?? sharedMediaAssets.find((asset) => asset.id === mediaReferences[selectedNode.id])?.name
              ?? "No file selected"}</small>
          </div>}
          {params?.sourceMode !== "solid" && params?.sourceMode !== "transparent"
            && sharedMediaAssets.some((asset) => asset.mediaKind === "image" || asset.mediaKind === "video") && (
              <label>Shared project media
                <select disabled={busy} value={mediaReferences[selectedNode.id] ?? ""}
                  onChange={(event) => void chooseSharedAsset(event.target.value)}>
                  <option value="">Choose a shared asset…</option>
                  {sharedMediaAssets.filter((asset) => asset.mediaKind === "image" || asset.mediaKind === "video")
                    .map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </select>
                <small>The compositor saves the asset ID, not another copy of the media file.</small>
              </label>
            )}
        </>}
        {selectedNode.data.kind === "transform" && <>{([
          ["x", "X", undefined, undefined], ["y", "Y", undefined, undefined], ["scale", "Scale %", 1, 1000],
        ] as const).map(([key, label, min, max]) => <NumberField key={key} label={label} disabled={busy}
          value={number(params ?? {}, key, 0)} min={min} max={max} onChange={(value) => update(key, value)} />)}</>}
        {selectedNode.data.kind === "key" && <>
          <label>Key color<input type="color" disabled={busy} value={String(params?.color ?? "#00ff00")} onChange={(event) => update("color", event.target.value)} /></label>
          <button type="button" disabled={busy} aria-pressed={pickingKey === selected} onClick={() => {
            setPlaying(false); setPickingKey(pickingKey === selected ? "" : selected);
          }}>{pickingKey === selected ? "Cancel picking" : "Pick from Viewer"}</button>
          <small>Click the Viewer to sample the Keyer&apos;s input at that position. Show the input in the Viewer for accurate positioning.</small>
          <NumberField label="Similarity / tolerance" value={number(params ?? {}, "tolerance", 0)} min={0} max={442} disabled={busy} onChange={(value) => update("tolerance", value)} />
          <NumberField label="Edge softness" value={number(params ?? {}, "softness", 0)} min={1} max={442} disabled={busy} onChange={(value) => update("softness", value)} />
          {keyRange("spillSuppression", "Spill suppression %", 0, 100, 0)}
          {keyRange("clipBlack", "Clip black %", 0, Math.max(0, number(params ?? {}, "clipWhite", 100) - 1), 0)}
          {keyRange("clipWhite", "Clip white %", Math.min(100, number(params ?? {}, "clipBlack", 0) + 1), 100, 100)}
          {keyRange("edgeChoke", "Choke / expand (pixels)", -20, 20, 0)}
          {keyRange("edgeFeather", "Edge feather (pixels)", 0, 20, 0)}
        </>}
        {selectedNode.data.kind === "mask" && <>
          <div className="comp-mask-add">
            {(["rectangle", "ellipse", "polygon", "freehand", "bezier"] as const).map((kind) =>
              <button type="button" key={kind} disabled={busy} onClick={() => addMaskLayer(kind)}>+ {kind}</button>)}
          </div>
          <p>Choose a shape, then draw it directly on the video in the Viewer. Layers combine from top to bottom.</p>
          {selectedMaskLayers.length > 0 ? <div className="comp-mask-layers">
            {selectedMaskLayers.map((layer, index) => <div className="comp-mask-layer-row" key={layer.id}>
              <button type="button" className="comp-mask-layer-select" aria-pressed={layer.id === selectedMaskLayer?.id}
                onClick={() => setMaskLayerSelection((current) => ({ ...current, [selectedNode.id]: layer.id }))}>
                {index + 1}. {layer.geometry.kind}
              </button>
              <button type="button" disabled={busy || index === 0} aria-label={`Move mask layer ${index + 1} up`}
                title="Move up" onClick={() => moveMaskLayer(index, -1)}>↑</button>
              <button type="button" disabled={busy || index === selectedMaskLayers.length - 1} aria-label={`Move mask layer ${index + 1} down`}
                title="Move down" onClick={() => moveMaskLayer(index, 1)}>↓</button>
              <button type="button" disabled={busy} aria-label={`Remove mask layer ${index + 1}`}
                title="Remove layer" onClick={() => {
                  const remaining = selectedMaskLayers.filter((item) => item.id !== layer.id);
                  if (remaining.length) remaining[0] = { ...remaining[0], operation: "add" };
                  update("layers", remaining);
                  setMaskLayerSelection((current) => ({ ...current, [selectedNode.id]: remaining[0]?.id ?? "" }));
                }}>×</button>
            </div>)}
          </div> : <p>No masks applied. Choose a shape to begin drawing.</p>}
          {selectedMaskLayer && selectedMaskGeometry && <>
            <label>Shape
              <select disabled={busy} value={selectedMaskLayer.geometry.kind} onChange={(event) => {
                const kind = event.target.value as MaskShapeKind;
                updateMaskLayer({ ...selectedMaskLayer, geometry: convertMaskGeometry(selectedMaskGeometry, kind), keyframes: [] });
              }}>
                <option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option>
                <option value="polygon">Polygon</option><option value="freehand">Freehand</option><option value="bezier">Bézier</option>
              </select>
            </label>
            <label>Combine mode
              <select disabled={busy || selectedMaskLayerIndex === 0} value={selectedMaskLayer.operation}
                onChange={(event) => updateMaskLayer({ ...selectedMaskLayer, operation: event.target.value as MaskLayer["operation"] })}>
                <option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
              </select>
            </label>
            <label>Feather: {selectedMaskLayer.feather} px
              <input type="range" min="0" max="80" step="1" disabled={busy} value={selectedMaskLayer.feather}
                onChange={(event) => updateMaskLayer({ ...selectedMaskLayer, feather: Number(event.target.value) })} />
            </label>
            <div className="comp-mask-keyframes">
              <button type="button" disabled={busy} onClick={() => updateMaskLayer(setMaskKeyframe(selectedMaskLayer, time))}>
                Set keyframe at {time.toFixed(1)} s
              </button>
              <button type="button" disabled={busy || !selectedMaskHasKeyframe}
                onClick={() => updateMaskLayer(removeMaskKeyframe(selectedMaskLayer, time))}>Remove current keyframe</button>
              <small>{selectedMaskLayer.keyframes.length
                ? `${selectedMaskLayer.keyframes.length} keyframe${selectedMaskLayer.keyframes.length === 1 ? "" : "s"} · edits create a keyframe at the playhead`
                : "Static shape · set a keyframe to animate its points"}</small>
              {selectedMaskLayer.keyframes.length > 0 && <div className="comp-mask-keyframe-list">
                {[...selectedMaskLayer.keyframes].sort((a, b) => a.time - b.time).map((frame) =>
                  <button type="button" key={frame.time} disabled={busy}
                    aria-pressed={Math.abs(frame.time - time) <= 0.001} onClick={() => setTime(frame.time)}>
                    {frame.time.toFixed(1)} s
                  </button>)}
              </div>}
            </div>
            <small>{selectedMaskLayer.keyframes.length
              ? "Drag existing points to animate them. Changing shape clears its keyframes; point count edits are disabled while animated."
              : selectedMaskLayer.geometry.kind === "freehand"
              ? "Drag on the video to draw or redraw the outline."
              : selectedMaskLayer.geometry.kind === "polygon" || selectedMaskLayer.geometry.kind === "bezier"
                ? "Click on the video to add points. The outline closes automatically after three points. For Bézier curves, drag when placing a point or adjust its handles."
                : "Drag on the video to draw the shape. Drag the shape to move it or its corners to resize."}</small>
            {"x" in selectedMaskGeometry && <>
                {(["x", "y", "width", "height"] as const).map((key) => <NumberField key={key}
                  label={{ x: "Left", y: "Top", width: "Width", height: "Height" }[key]}
                  value={selectedMaskGeometry[key]} min={key === "width" || key === "height" ? 0 : undefined}
                  disabled={busy} onChange={(value) => updateMaskBounds(key, value)} />)}
            </>}
            {"points" in selectedMaskGeometry && <div className="comp-mask-outline-actions">
              <button type="button" disabled={busy || Boolean(selectedMaskLayer.keyframes.length) || selectedMaskPoint === null || selectedMaskPoint >= selectedMaskGeometry.points.length}
                onClick={() => {
                  updateMaskLayer(updateMaskGeometry(selectedMaskLayer,
                    { ...selectedMaskGeometry, points: selectedMaskGeometry.points.filter((_, index) => index !== selectedMaskPoint) }, time));
                  setMaskPointSelection(null);
                }}>Remove selected point</button>
              <button type="button" disabled={busy || Boolean(selectedMaskLayer.keyframes.length) || !selectedMaskGeometry.points.length}
                onClick={() => updateMaskLayer(updateMaskGeometry(selectedMaskLayer,
                  { ...selectedMaskGeometry, points: selectedMaskGeometry.points.slice(0, -1) }, time))}>Undo point</button>
              <button type="button" disabled={busy || Boolean(selectedMaskLayer.keyframes.length)} onClick={() => updateMaskLayer(updateMaskGeometry(selectedMaskLayer,
                createMaskGeometry(selectedMaskLayer.geometry.kind), time))}>Reset shape</button>
            </div>}
          </>}
          <label><input type="checkbox" disabled={busy} checked={Boolean(params?.invert)} onChange={(event) => update("invert", event.target.checked)} /> Invert mask</label>
        </>}
        {selectedNode.data.kind === "color" && <>
          {colorField("brightness", "Brightness", -255, 255)}{colorField("contrast", "Contrast %", 0, 300, 100)}{colorField("saturation", "Saturation %", 0, 300, 100)}
          <h3>Grading</h3>
          {colorField("exposure", "Exposure (stops)", -4, 4, 0, 0.1)}{colorField("gamma", "Gamma", 0.1, 4, 1, 0.1)}
          {colorField("temperature", "Temperature", -100, 100)}{colorField("tint", "Tint", -100, 100)}
          {colorField("highlights", "Highlights", -100, 100)}{colorField("shadows", "Shadows", -100, 100)}
          <h3>RGB gain</h3>
          {colorField("redGain", "Red gain %", 0, 300, 100)}{colorField("greenGain", "Green gain %", 0, 300, 100)}
          {colorField("blueGain", "Blue gain %", 0, 300, 100)}
          <h3>Curves</h3>
          <ColorCurves key={`${selectedNode.id}:${historyRevision}`} params={selectedNode.data.params} disabled={busy} onChange={update} />
        </>}
        {selectedNode.data.kind === "merge" && <NumberField label="Foreground opacity %" value={number(params ?? {}, "opacity", 0)} min={0} max={100} disabled={busy} onChange={(value) => update("opacity", value)} />}
        {selectedNode.data.kind === "tracker" && <>
          {!trackerInput && <small>Connect a video to the Tracker image input to position markers and track.</small>}
          <label>Tracking mode
            <select disabled={busy} value={trackerMode(selectedNode.data.params)} onChange={(event) => {
              update("mode", event.target.value);
              setActiveTrackingPoint(0); setTrackingRecovery(null); setTime(0);
            }}>
              <option value="point">Single point · position</option>
              <option value="two-point">Two points · rotation and scale</option>
              <option value="planar">Planar surface · perspective</option>
            </select>
          </label>
          <label>Samples per second
            <select disabled={busy} value={number(selectedNode.data.params, "sampleRate", 5)}
              onChange={(event) => { setTrackingRecovery(null); update("sampleRate", Number(event.target.value)); }}>
              <option value={5}>5</option><option value={10}>10</option><option value={15}>15</option>
            </select>
          </label>
          <small>{recovery ? "Adjust the markers at the last valid frame, then resume."
            : "At frame 0, drag the markers onto clear features in the Viewer. For planar tracking, outline a textured surface."}</small>
          <div className="comp-mask-add">
            {currentTrackerAnchors.map((_, index) => <button type="button" key={index}
              disabled={!trackerEditable} aria-pressed={activeTrackingPoint === index}
              onClick={() => setActiveTrackingPoint(index)}>Marker {index + 1}</button>)}
          </div>
          {currentTrackerAnchors[activeTrackingPoint] && <>
            <NumberField label="Marker X" value={currentTrackerAnchors[activeTrackingPoint].x} min={10} max={630}
              disabled={!trackerEditable} onChange={(value) => updateTrackerAnchor(activeTrackingPoint, { ...currentTrackerAnchors[activeTrackingPoint], x: value })} />
            <NumberField label="Marker Y" value={currentTrackerAnchors[activeTrackingPoint].y} min={10} max={350}
              disabled={!trackerEditable} onChange={(value) => updateTrackerAnchor(activeTrackingPoint, { ...currentTrackerAnchors[activeTrackingPoint], y: value })} />
          </>}
          <button type="button" disabled={busy || selectedNode.data.disabled} onClick={() => {
            setTrackingRecovery(null); void runTracking();
          }}>Track video from start</button>
          {trackerData && !Array.isArray(trackerData) && !trackerData.complete && trackerData.samples.length > 0 && <>
            {!recovery ? <button type="button" disabled={busy} onClick={() => {
              const last = trackerData.samples[trackerData.samples.length - 1];
              setTrackingRecovery({ id: selectedNode.id, anchors: last.anchors });
              setTime(last.time); setPlaying(false); setError("");
            }}>Correct interrupted track</button> : <>
              <button type="button" disabled={busy} onClick={() => void runTracking(true)}>Resume tracking</button>
              <button type="button" disabled={busy} onClick={() => setTrackingRecovery(null)}>Cancel correction</button>
            </>}
          </>}
          {trackingProgress && <div>
            <progress max={trackingProgress.end} value={trackingProgress.time} />
            <small> {Math.round(trackingProgress.time / trackingProgress.end * 100)}% · {trackingProgress.time.toFixed(1)} / {trackingProgress.end.toFixed(1)} s</small>
            <button type="button" onClick={() => { trackingCancelled.current = true; }}>Stop tracking</button>
          </div>}
          <small>{trackSamples.length ? `${trackSamples.length} samples · confidence ${Math.round((trackSamples[trackSamples.length - 1].confidence) * 100)}%`
            : "Not tracked"}{trackerData && !Array.isArray(trackerData) && !trackerData.complete ? " · incomplete" : ""}</small>
        </>}
      </section>}
      <section className="comp-templates" aria-labelledby="comp-templates-heading">
        <h2 id="comp-templates-heading">Templates</h2>
        <p>Add to canvas keeps existing nodes, media, and tracking. Its output becomes the Viewer input. Replace clears the current project; use Undo to restore either action.</p>
        <p>Each template includes connected media inputs. Select a media input to upload your image or video.</p>
        {COMPOSITOR_TEMPLATES.map((template) => <div key={template.id} className="comp-template">
          <strong>{template.name}</strong>
          <div className="comp-template-actions">
            <button type="button" disabled={!ready || busy} onClick={() => void applyTemplate(template.id, "add")}>Add to canvas</button>
            <button type="button" disabled={!ready || busy} onClick={() => void applyTemplate(template.id, "replace")}>Replace</button>
          </div>
          <small>{template.description}</small>
        </div>)}
        <details>
          <summary>Tracking template steps</summary>
          <small>Load a video into Background video and an image into Overlay image. Select Tracker, pause at frame 0, click a feature in the Viewer, and run Track video. Then select Merge and click Show in Viewer. Adjust the overlay with Transform.</small>
        </details>
      </section>
    </aside>
    <div className="comp-workspace" ref={workspaceRef} style={{
      gridTemplateRows: `minmax(${VIEWER_MIN_HEIGHT}px, ${currentViewerHeight}px) ${VIEWER_DIVIDER_HEIGHT}px minmax(${GRAPH_MIN_HEIGHT}px, 1fr)`,
    }}>
      <section id="comp-viewer" className="comp-viewer" ref={viewerPanelRef}>
        <div className="comp-viewer-header"><strong>Viewer</strong><span>{editingMask ? "Mask input · editing preview" : editingTracker && trackerInput ? "Tracker input · tracking preview" : "640 × 360 · silent preview"}</span></div>
        <div ref={viewportRef} className={`comp-viewer-viewport${panning ? " is-panning" : ""}`}
          aria-label="Viewer navigation" onPointerDownCapture={(event) => {
            if (event.button === 0 && event.target instanceof Element && event.target.closest(".comp-mask-editor, .comp-tracker-editor")) {
              historyGroup.current = { recorded: false, type: "pointer", target: event.target };
              setPlaying(false);
            }
          }} onPointerUpCapture={() => { if (historyGroup.current?.type === "pointer") historyGroup.current = null; }}
          onPointerCancelCapture={() => { if (historyGroup.current?.type === "pointer") historyGroup.current = null; }}
          onPointerDown={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            setPanning(true);
          }} onPointerMove={(event) => {
            const pan = panRef.current;
            if (!pan || pan.pointerId !== event.pointerId) return;
            const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
            pan.x = event.clientX; pan.y = event.clientY;
            setViewerTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
          }} onPointerUp={(event) => {
            if (panRef.current?.pointerId !== event.pointerId || event.button !== 1) return;
            panRef.current = null; setPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={(event) => {
            if (panRef.current?.pointerId === event.pointerId) { panRef.current = null; setPanning(false); }
          }} onLostPointerCapture={(event) => {
            if (panRef.current?.pointerId === event.pointerId) { panRef.current = null; setPanning(false); }
          }} onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }} onClick={(event) => {
            if (busy || !previewRef.current) return;
            const rect = previewRef.current.getBoundingClientRect();
            const x = Math.floor((event.clientX - rect.left) * WIDTH / rect.width);
            const y = Math.floor((event.clientY - rect.top) * HEIGHT / rect.height);
            if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
            if (pickingKey === selected && selectedNode?.data.kind === "key") { void pickKeyColor(x, y); return; }
          }}>
        <canvas ref={previewRef} width={WIDTH} height={HEIGHT} aria-label="Composite viewer"
          style={{ transform: `translate(${viewerTransform.x}px, ${viewerTransform.y}px) scale(${viewerTransform.zoom})`,
            visibility: viewChannel === "rgb" ? "visible" : "hidden",
            ...(previewBackground === "color" ? { background: previewColor } : {}) }} />
        <canvas ref={channelRef} width={WIDTH} height={HEIGHT} aria-label="Viewer channel preview" aria-hidden="true"
          style={{ transform: `translate(${viewerTransform.x}px, ${viewerTransform.y}px) scale(${viewerTransform.zoom})`,
            display: viewChannel === "rgb" ? "none" : "block",
            ...(previewBackground === "color" ? { background: previewColor } : {}) }} />
        {editingMask && !maskProjectionError && selectedMaskLayer && selectedMaskGeometry && <MaskEditor
          key={`${selectedMaskLayer.id}:${selectedMaskGeometry.kind}:${historyRevision}`} geometry={selectedMaskGeometry}
          disabled={busy} allowPointChanges={!selectedMaskLayer.keyframes.length} motion={maskMatrix}
          transform={`translate(${viewerTransform.x}px, ${viewerTransform.y}px) scale(${viewerTransform.zoom})`}
          selectedPoint={selectedMaskPoint}
          onSelectPoint={(index) => setMaskPointSelection(index === null ? null : { layerId: selectedMaskLayer.id, index })}
          onChange={(geometry) => updateMaskLayer(updateMaskGeometry(selectedMaskLayer, geometry, time))} />}
        {editingTracker && trackerInput && <TrackerEditor anchors={currentTrackerAnchors} paths={trackerPaths} active={activeTrackingPoint}
          editable={trackerEditable} transform={`translate(${viewerTransform.x}px, ${viewerTransform.y}px) scale(${viewerTransform.zoom})`}
          onActive={setActiveTrackingPoint} onMove={updateTrackerAnchor} />}
        </div>
        <div className="comp-viewer-options">
          {selectedNode?.data.kind === "mask" && !selectedNode.data.disabled && <label>
            <input type="checkbox" checked={editMaskOnSource} onChange={(event) => setEditMaskOnSource(event.target.checked)} />
            Edit mask on input (uncheck to preview result)
          </label>}
          <label>View channel (preview only) <select value={viewChannel} onChange={(event) => {
            const value = event.target.value;
            setViewChannel(value === "red" || value === "green" || value === "blue" || value === "alpha" ? value : "rgb");
          }}>
            <option value="rgb">RGB</option><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option><option value="alpha">Alpha</option>
          </select></label>
          <label>Transparency background (preview only) <select value={previewBackground}
            onChange={(event) => setPreviewBackground(event.target.value === "color" ? "color" : "checkerboard")}>
            <option value="checkerboard">Checkerboard</option><option value="color">Custom color</option>
          </select></label>
          {previewBackground === "color" && <label>Preview color <input type="color" value={previewColor} onChange={(event) => setPreviewColor(event.target.value)} /></label>}
        </div>
        <div className="comp-transport">
          <button type="button" disabled={!duration || busy || Boolean(recovery)} onClick={() => {
            if (!playing && (time < range.start || time >= range.end)) setTime(range.start);
            setPlaying(!playing);
          }}>{playing ? "Pause" : "Play"}</button>
          <div className="comp-timeline">
            <div className="comp-timeline-range" aria-hidden="true">
              <span style={{ left: `${duration ? range.start / duration * 100 : 0}%`, right: `${duration ? (1 - range.end / duration) * 100 : 0}%` }} />
            </div>
            <input aria-label="Playhead" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(time, duration)} disabled={!duration || busy || Boolean(recovery)}
              onChange={(event) => setTime(Number(event.target.value))} />
          </div>
          <span>{time.toFixed(1)} / {duration.toFixed(1)} s</span>
          <button type="button" disabled={!duration || busy || !ready} onClick={() => setMarker("inPoint", Math.min(time, duration))} title="Set In at playhead (I)">Set In (I)</button>
          <button type="button" disabled={!duration || busy || !ready} onClick={() => setMarker("outPoint", Math.min(time, duration))} title="Set Out at playhead (O)">Set Out (O)</button>
          <button type="button" disabled={busy || !ready || marks.inPoint === null && marks.outPoint === null} onClick={clearMarks}>Clear In/Out</button>
          <button type="button" onClick={() => setViewerTransform(DEFAULT_VIEWER_TRANSFORM)} title="Reset Viewer zoom and pan">Fit viewer ({Math.round(viewerTransform.zoom * 100)}%)</button>
          <button type="button" disabled={busy || !ready} onClick={() => void exportImage()}>Export PNG</button>
          <button type="button" disabled={busy || !ready || !onSendFrameToWorkflow}
            onClick={() => void sendFrameToWorkflow()}
            title="Send the current 640 × 360 composite frame to Workflow as an image input">
            Send frame to Workflow
          </button>
          <button type="button" disabled={busy || !ready || !duration} onClick={() => void exportVideo()}>Export WebM</button>
        </div>
        <div className="comp-markers" onPointerDownCapture={(event) => {
          if (event.target instanceof HTMLInputElement) historyGroup.current = { recorded: false, type: "pointer", target: event.target };
        }} onPointerUpCapture={() => { if (historyGroup.current?.type === "pointer") historyGroup.current = null; }}
          onPointerCancelCapture={() => { if (historyGroup.current?.type === "pointer") historyGroup.current = null; }}>
          <label>In: {range.start.toFixed(1)} s
            <input aria-label="In point" type="range" min="0" max={duration || 0} step="0.1" value={range.start} disabled={!duration || busy || !ready}
              onChange={(event) => setMarker("inPoint", Number(event.target.value))} />
          </label>
          <label>Out: {range.end.toFixed(1)} s
            <input aria-label="Out point" type="range" min="0" max={duration || 0} step="0.1" value={range.end} disabled={!duration || busy || !ready}
              onChange={(event) => setMarker("outPoint", Number(event.target.value))} />
          </label>
        </div>
        {editingMask && maskProjectionError && <p className="comp-error" role="alert">{maskProjectionError}</p>}
        {editingTracker && !recovery && trackerPreview.error && <p className="comp-error" role="alert">{trackerPreview.error}</p>}
        {error && <p className="comp-error" role="alert">{error}</p>}
        {renderError && <p className="comp-error" role="alert">{renderError}</p>}
      </section>
      <div
        ref={viewerDividerRef}
        className={`comp-viewer-divider${resizingViewer ? " comp-viewer-divider-active" : ""}`}
        role="separator"
        aria-label="Resize compositor viewer"
        aria-orientation="horizontal"
        aria-controls="comp-viewer comp-graph"
        aria-valuemin={viewerMinValue}
        aria-valuemax={viewerMaxValue}
        aria-valuenow={Math.round(currentViewerHeight / viewerAvailableHeight * 100)}
        aria-valuetext={`${Math.round(currentViewerHeight / viewerAvailableHeight * 100)}% viewer height`}
        aria-disabled={busy}
        tabIndex={busy ? -1 : 0}
        onPointerDown={handleViewerDividerPointerDown}
        onPointerMove={handleViewerDividerPointerMove}
        onPointerUp={finishViewerDividerResize}
        onPointerCancel={finishViewerDividerResize}
        onKeyDown={handleViewerDividerKeyDown}
      >
        <span aria-hidden="true" />
      </div>
      <section id="comp-graph" className="comp-graph" aria-label="Compositor node graph" style={{ pointerEvents: busy ? "none" : undefined }}>
        {!hidden && <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={(instance) => { flowRef.current = instance; }} onNodesChange={(changes) => {
          if (changes.some((change) => change.type === "remove")) setTracks({});
          onNodesChange(changes);
          const removed = changes.filter((change) => change.type === "remove").map((change) => change.id);
          if (removed.length) {
            setFiles((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !removed.includes(id))));
            setMediaReferences((current) => Object.fromEntries(
              Object.entries(current).filter(([id]) => !removed.includes(id)),
            ));
            setMediaMetadata((current) => Object.fromEntries(Object.entries(current)
              .filter(([id]) => !removed.includes(id))
              .map(([id, value]) => [id, normalizeMediaAssetMetadata(value)])));
            setMediaDurations((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !removed.includes(id))));
            for (const id of removed) {
              const media = mediaRef.current[id];
              if (media) URL.revokeObjectURL(media.url);
              delete mediaRef.current[id];
            }
          }
        }} onEdgesChange={(changes) => { if (changes.some((change) => change.type === "remove")) setTracks({}); onEdgesChange(changes); }}
          onBeforeDelete={async () => { recordHistory(); return true; }}
          onNodeDragStart={() => { recordHistory(); }}
          onConnect={connect} onNodeClick={(_, node) => { setSelected(node.id); setPickingKey(""); }}
          onEdgeClick={() => setSelected("")} onPaneClick={() => { setSelected(""); setPickingKey(""); }} defaultEdgeOptions={{ interactionWidth: 30 }}
          deleteKeyCode={busy ? null : ["Backspace", "Delete"]} fitView>
          <Background /><Controls />
        </ReactFlow>}
      </section>
    </div>
  </main>;
}
