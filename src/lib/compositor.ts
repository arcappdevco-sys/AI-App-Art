import type { CurvePoint } from "./compositor-color";

export type CompositorKind = "media" | "transform" | "key" | "mask" | "color" | "merge" | "tracker" | "viewer";
export type CompositorParams = Record<string, string | number | boolean | CurvePoint[]>;
export type TrackPoint = { time: number; x: number; y: number; confidence: number };
export type CompositorMarks = { inPoint: number | null; outPoint: number | null };
export const EMPTY_COMPOSITOR_MARKS: CompositorMarks = { inPoint: null, outPoint: null };

export function compositorRange(marks: CompositorMarks, duration: number) {
  const end = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const clamp = (value: number | null, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(end, value)) : fallback;
  const start = clamp(marks.inPoint, 0), out = clamp(marks.outPoint, end);
  return start < out ? { start, end: out } : { start: 0, end };
}

export function nextCompositorTime(current: number, start: number, end: number, step = 0.1) {
  if (current < start || current >= end || current + step >= end - 1e-9) return start;
  return current + step;
}

export function compositorBypassInput(kind: CompositorKind): "image" | "background" | null {
  if (kind === "merge") return "background";
  if (kind === "transform" || kind === "key" || kind === "mask" || kind === "color") return "image";
  return null;
}

export function compositorMediaSource(params: CompositorParams): "file" | "solid" | "transparent" {
  return params.sourceMode === "solid" || params.sourceMode === "transparent" ? params.sourceMode : "file";
}

export const COMPOSITOR_INPUTS: Record<CompositorKind, string[]> = {
  media: [], transform: ["image", "motion"], key: ["image"], mask: ["image", "motion"],
  color: ["image"], merge: ["background", "foreground"], tracker: ["image"], viewer: ["image"],
};

export const COMPOSITOR_LABELS: Record<CompositorKind, string> = {
  media: "Media", transform: "Transform", key: "Keyer", mask: "Mask",
  color: "Color correction", merge: "Merge", tracker: "Tracker", viewer: "Viewer",
};

export const COMPOSITOR_DEFAULTS: Record<CompositorKind, CompositorParams> = {
  media: {}, transform: { x: 0, y: 0, scale: 100 }, key: { color: "#00ff00", tolerance: 100, softness: 35 },
  mask: { x: 320, y: 180, width: 240, height: 180, invert: false },
  color: { brightness: 0, contrast: 100, saturation: 100 }, merge: { opacity: 100 },
  tracker: { x: 320, y: 180 }, viewer: {},
};

export type ViewerTransform = { zoom: number; x: number; y: number };
export const DEFAULT_VIEWER_TRANSFORM: ViewerTransform = { zoom: 1, x: 0, y: 0 };

export function zoomViewerAt(view: ViewerTransform, factor: number, x: number, y: number): ViewerTransform {
  const zoom = Math.max(0.25, Math.min(8, view.zoom * factor));
  const ratio = zoom / view.zoom;
  return { zoom, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}

export function reachesCompositorNode(edges: ReadonlyArray<{ source: string; target: string }>, source: string, target: string): boolean {
  const pending = [source];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of edges) {
      if (edge.source === id && !visited.has(edge.target)) pending.push(edge.target);
    }
  }
  return false;
}

export function trackPatch(
  reference: Uint8ClampedArray, frame: Uint8ClampedArray, width: number, height: number,
  x: number, y: number, radius = 4, search = 12,
) {
  let best = Infinity, bestX = x, bestY = y;
  let min = 255, max = 0;
  for (let py = -radius; py <= radius; py++) {
    for (let px = -radius; px <= radius; px++) {
      const i = ((y + py) * width + x + px) * 4;
      const value = (reference[i] + reference[i + 1] + reference[i + 2]) / 3;
      min = Math.min(min, value); max = Math.max(max, value);
    }
  }
  if (max - min < 20) throw new Error("Tracking feature has too little contrast. Choose a more detailed point.");
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < radius || ny < radius || nx >= width - radius || ny >= height - radius) continue;
      let sum = 0;
      for (let py = -radius; py <= radius; py++) {
        for (let px = -radius; px <= radius; px++) {
          const a = ((y + py) * width + x + px) * 4;
          const b = ((ny + py) * width + nx + px) * 4;
          for (let c = 0; c < 3; c++) sum += Math.abs(reference[a + c] - frame[b + c]);
        }
      }
      if (sum < best || sum === best && dx * dx + dy * dy < (bestX - x) ** 2 + (bestY - y) ** 2) {
        best = sum; bestX = nx; bestY = ny;
      }
    }
  }
  return { x: bestX, y: bestY, confidence: 1 - best / ((radius * 2 + 1) ** 2 * 3 * 255) };
}

export function interpolateTrack(points: TrackPoint[], time: number) {
  if (!points.length) throw new Error("Run the tracker before rendering.");
  const first = points[0];
  if (time <= first.time) return { x: 0, y: 0 };
  const last = points[points.length - 1];
  if (time >= last.time) return { x: last.x - first.x, y: last.y - first.y };
  const end = points.findIndex((point) => point.time >= time);
  const a = points[end - 1], b = points[end];
  const amount = (time - a.time) / (b.time - a.time);
  return { x: a.x + (b.x - a.x) * amount - first.x, y: a.y + (b.y - a.y) * amount - first.y };
}
