import {
  scaleTrackingMatrix,
  transformTrackingPoint,
  warpTrackingCanvas,
  type TrackingMatrix,
  type TrackingPoint,
} from "./compositor-tracking";

export type MaskShapeKind = "rectangle" | "ellipse" | "polygon" | "freehand" | "bezier";
export type MaskCombineMode = "add" | "subtract" | "intersect";
export type MaskPoint = { x: number; y: number; inX: number; inY: number; outX: number; outY: number };
export type MaskGeometry =
  | { kind: "rectangle" | "ellipse"; x: number; y: number; width: number; height: number }
  | { kind: "polygon" | "freehand" | "bezier"; points: MaskPoint[] };
export type MaskKeyframe = { time: number; geometry: MaskGeometry };
export type MaskLayer = {
  id: string;
  geometry: MaskGeometry;
  operation: MaskCombineMode;
  feather: number;
  keyframes: MaskKeyframe[];
};

const MASK_WIDTH = 640;
const MASK_HEIGHT = 360;
const MIN_POINT_DISTANCE = 1;
const clampAlpha = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function boxFor(geometry: MaskGeometry) {
  if ("x" in geometry) return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
  if (!geometry.points.length) return { x: 200, y: 90, width: 240, height: 180 };
  const xs = geometry.points.map((point) => point.x), ys = geometry.points.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
}

export function projectedMaskPath(geometry: MaskGeometry, matrix: TrackingMatrix): string {
  const points: TrackingPoint[] = [];
  let closed = true;
  if ("x" in geometry) {
    if (geometry.kind === "rectangle") {
      points.push(...rectanglePoints(geometry));
    } else {
      for (let i = 0; i < 64; i++) {
        const angle = i * Math.PI * 2 / 64;
        points.push({ x: geometry.x + geometry.width * (1 + Math.cos(angle)) / 2,
          y: geometry.y + geometry.height * (1 + Math.sin(angle)) / 2 });
      }
    }
  } else {
    const anchors = geometry.points;
    if (anchors.length < 2) return "";
    closed = anchors.length >= 3;
    points.push(anchors[0]);
    const segments = closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segments; i++) {
      const current = anchors[i], next = anchors[(i + 1) % anchors.length];
      if (geometry.kind === "bezier") {
        for (let step = 1; step <= 16; step++) {
          const t = step / 16, s = 1 - t;
          points.push({
            x: s ** 3 * current.x + 3 * s * s * t * (current.x + current.outX)
              + 3 * s * t * t * (next.x + next.inX) + t ** 3 * next.x,
            y: s ** 3 * current.y + 3 * s * s * t * (current.y + current.outY)
              + 3 * s * t * t * (next.y + next.inY) + t ** 3 * next.y,
          });
        }
      } else points.push(next);
    }
  }
  return points.map((point, index) => {
    const projected = transformTrackingPoint(matrix, point);
    return `${index ? "L" : "M"} ${projected.x} ${projected.y}`;
  }).join(" ") + (closed ? " Z" : "");
}

export function validateMaskProjection(geometry: MaskGeometry, matrix: TrackingMatrix): void {
  const points: TrackingPoint[] = "x" in geometry ? rectanglePoints(geometry) : geometry.points.flatMap((point) => [
    point, { x: point.x + point.inX, y: point.y + point.inY }, { x: point.x + point.outX, y: point.y + point.outY },
  ]);
  if (points.some((point) => matrix[6] * point.x + matrix[7] * point.y + matrix[8] <= 1e-6)) {
    throw new Error("The mask crosses the tracked perspective horizon. Adjust the mask or tracking surface.");
  }
}

function rectanglePoints({ x, y, width, height }: { x: number; y: number; width: number; height: number }): MaskPoint[] {
  return [
    { x, y, inX: 0, inY: 0, outX: 0, outY: 0 },
    { x: x + width, y, inX: 0, inY: 0, outX: 0, outY: 0 },
    { x: x + width, y: y + height, inX: 0, inY: 0, outX: 0, outY: 0 },
    { x, y: y + height, inX: 0, inY: 0, outX: 0, outY: 0 },
  ];
}

function bezierEllipse({ x, y, width, height }: { x: number; y: number; width: number; height: number }): MaskPoint[] {
  const cx = x + width / 2, cy = y + height / 2;
  const rx = width / 2, ry = height / 2, k = 0.5522847498;
  return [
    { x: cx, y, inX: -rx * k, inY: 0, outX: rx * k, outY: 0 },
    { x: x + width, y: cy, inX: 0, inY: -ry * k, outX: 0, outY: ry * k },
    { x: cx, y: y + height, inX: rx * k, inY: 0, outX: -rx * k, outY: 0 },
    { x, y: cy, inX: 0, inY: ry * k, outX: 0, outY: -ry * k },
  ];
}

export function createMaskGeometry(kind: MaskShapeKind): MaskGeometry {
  const box = { x: 0, y: 0, width: 0, height: 0 };
  if (kind === "rectangle" || kind === "ellipse") return { kind, ...box };
  return { kind, points: [] };
}

export function createMaskLayer(kind: MaskShapeKind, id: string): MaskLayer {
  return { id, geometry: createMaskGeometry(kind), operation: "add", feather: 0, keyframes: [] };
}

export function convertMaskGeometry(geometry: MaskGeometry, kind: MaskShapeKind): MaskGeometry {
  if (geometry.kind === kind) return geometry;
  if (kind === "rectangle" || kind === "ellipse") return { kind, ...boxFor(geometry) };
  if (kind === "freehand" && "points" in geometry) return { kind, points: geometry.points.map((point) => ({ ...point })) };
  const box = boxFor(geometry);
  if (kind === "bezier") return { kind, points: bezierEllipse(box) };
  return { kind: "polygon", points: "points" in geometry && geometry.points.length
    ? geometry.points.map(({ x, y }) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 }))
    : rectanglePoints(box) };
}

function isMaskPoint(value: unknown): value is MaskPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return ["x", "y", "inX", "inY", "outX", "outY"].every((key) => typeof point[key] === "number" && Number.isFinite(point[key]));
}

function isMaskGeometry(value: unknown): value is MaskGeometry {
  if (!value || typeof value !== "object") return false;
  const geometry = value as Record<string, unknown>;
  if (geometry.kind === "rectangle" || geometry.kind === "ellipse") {
    return ["x", "y", "width", "height"].every((key) => typeof geometry[key] === "number" && Number.isFinite(geometry[key]));
  }
  return ["polygon", "freehand", "bezier"].includes(String(geometry.kind))
    && Array.isArray(geometry.points) && geometry.points.every(isMaskPoint);
}

function isMaskLayer(value: unknown): value is MaskLayer {
  if (!value || typeof value !== "object") return false;
  const layer = value as Record<string, unknown>;
  return typeof layer.id === "string" && isMaskGeometry(layer.geometry)
    && ["add", "subtract", "intersect"].includes(String(layer.operation))
    && typeof layer.feather === "number" && Number.isFinite(layer.feather) && layer.feather >= 0
    && Array.isArray(layer.keyframes) && layer.keyframes.every((frame) => Boolean(frame) && typeof frame === "object"
      && typeof (frame as MaskKeyframe).time === "number" && Number.isFinite((frame as MaskKeyframe).time)
      && isMaskGeometry((frame as MaskKeyframe).geometry));
}

export function getMaskLayers(params: Record<string, unknown>): MaskLayer[] {
  if (params.layers === undefined) {
    const geometry: MaskGeometry = {
      kind: "rectangle",
      x: finite(params.x, 320) - finite(params.width, 240) / 2,
      y: finite(params.y, 180) - finite(params.height, 180) / 2,
      width: Math.max(0, finite(params.width, 240)),
      height: Math.max(0, finite(params.height, 180)),
    };
    return [{ id: "mask-layer-1", geometry, operation: "add", feather: 0, keyframes: [] }];
  }
  if (!Array.isArray(params.layers) || !params.layers.every(isMaskLayer)) {
    throw new Error("The compositor contains invalid mask layer data.");
  }
  return params.layers;
}

function interpolateGeometry(a: MaskGeometry, b: MaskGeometry, amount: number): MaskGeometry {
  const mix = (left: number, right: number) => left + (right - left) * amount;
  if (a.kind !== b.kind) return a;
  if ("x" in a && "x" in b) {
    return { kind: a.kind, x: mix(a.x, b.x), y: mix(a.y, b.y),
      width: mix(a.width, b.width), height: mix(a.height, b.height) };
  }
  if ("points" in a && "points" in b && a.points.length === b.points.length) {
    return { kind: a.kind, points: a.points.map((point, index) => {
      const other = b.points[index];
      return {
        x: mix(point.x, other.x), y: mix(point.y, other.y),
        inX: mix(point.inX, other.inX), inY: mix(point.inY, other.inY),
        outX: mix(point.outX, other.outX), outY: mix(point.outY, other.outY),
      };
    }) };
  }
  return a;
}

export function maskGeometryAt(layer: MaskLayer, time: number): MaskGeometry {
  const frames = [...layer.keyframes].sort((a, b) => a.time - b.time);
  if (!frames.length || time <= frames[0].time) return frames[0]?.geometry ?? layer.geometry;
  const last = frames[frames.length - 1];
  if (time >= last.time) return last.geometry;
  const nextIndex = frames.findIndex((frame) => frame.time >= time);
  const before = frames[nextIndex - 1], after = frames[nextIndex];
  const span = after.time - before.time;
  return span > 0 ? interpolateGeometry(before.geometry, after.geometry, (time - before.time) / span) : after.geometry;
}

export function scaleMaskGeometry(geometry: MaskGeometry, scaleX: number, scaleY: number): MaskGeometry {
  if ("x" in geometry) {
    return {
      ...geometry,
      x: geometry.x * scaleX,
      y: geometry.y * scaleY,
      width: geometry.width * scaleX,
      height: geometry.height * scaleY,
    };
  }
  return {
    ...geometry,
    points: geometry.points.map((point) => ({
      x: point.x * scaleX,
      y: point.y * scaleY,
      inX: point.inX * scaleX,
      inY: point.inY * scaleY,
      outX: point.outX * scaleX,
      outY: point.outY * scaleY,
    })),
  };
}

function upsertKeyframe(layer: MaskLayer, time: number, geometry: MaskGeometry): MaskKeyframe[] {
  const frames = layer.keyframes.filter((frame) => Math.abs(frame.time - time) > 0.001);
  frames.push({ time, geometry });
  return frames.sort((a, b) => a.time - b.time);
}

export function updateMaskGeometry(layer: MaskLayer, geometry: MaskGeometry, time: number): MaskLayer {
  return { ...layer, geometry, keyframes: layer.keyframes.length ? upsertKeyframe(layer, time, geometry) : [] };
}

export function setMaskKeyframe(layer: MaskLayer, time: number): MaskLayer {
  return { ...layer, keyframes: upsertKeyframe(layer, time, maskGeometryAt(layer, time)) };
}

export function hasMaskKeyframeAt(layer: MaskLayer, time: number): boolean {
  return layer.keyframes.some((frame) => Math.abs(frame.time - time) <= 0.001);
}

export function removeMaskKeyframe(layer: MaskLayer, time: number): MaskLayer {
  const geometry = maskGeometryAt(layer, time);
  return { ...layer, geometry, keyframes: layer.keyframes.filter((frame) => Math.abs(frame.time - time) > 0.001) };
}

export function combineMaskAlpha(current: number, incoming: number, operation: MaskCombineMode): number {
  const a = clampAlpha(current), b = clampAlpha(incoming);
  if (operation === "subtract") return a * (1 - b);
  if (operation === "intersect") return a * b;
  return b + a * (1 - b);
}

export function maskGeometryPath(geometry: MaskGeometry): string {
  if ("x" in geometry) {
    if (geometry.kind === "rectangle") {
      return `M ${geometry.x} ${geometry.y} h ${geometry.width} v ${geometry.height} h ${-geometry.width} Z`;
    }
    const rx = geometry.width / 2, ry = geometry.height / 2, cx = geometry.x + rx, cy = geometry.y + ry;
    return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${2 * rx} 0 a ${rx} ${ry} 0 1 0 ${-2 * rx} 0 Z`;
  }
  const { points } = geometry;
  if (points.length < 2) return "";
  let path = `M ${points[0].x} ${points[0].y}`;
  if (geometry.kind === "bezier") {
    for (let index = 0; index < (points.length >= 3 ? points.length : points.length - 1); index++) {
      const current = points[index], next = points[(index + 1) % points.length];
      path += ` C ${current.x + current.outX} ${current.y + current.outY}`
        + ` ${next.x + next.inX} ${next.y + next.inY} ${next.x} ${next.y}`;
    }
  } else {
    path += points.slice(1).map((point) => ` L ${point.x} ${point.y}`).join("");
  }
  return points.length >= 3 ? `${path} Z` : path;
}

function hasMaskArea(geometry: MaskGeometry): boolean {
  return "points" in geometry ? geometry.points.length >= 3 : geometry.width > 0 && geometry.height > 0;
}

function traceGeometry(ctx: CanvasRenderingContext2D, geometry: MaskGeometry) {
  if ("x" in geometry) {
    if (geometry.kind === "rectangle") ctx.rect(geometry.x, geometry.y, geometry.width, geometry.height);
    else ctx.ellipse(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2,
      Math.max(0, geometry.width / 2), Math.max(0, geometry.height / 2), 0, 0, Math.PI * 2);
    return;
  }
  if (geometry.points.length < 2) return;
  ctx.moveTo(geometry.points[0].x, geometry.points[0].y);
  if (geometry.kind === "bezier") {
    for (let index = 0; index < geometry.points.length; index++) {
      const current = geometry.points[index], next = geometry.points[(index + 1) % geometry.points.length];
      ctx.bezierCurveTo(current.x + current.outX, current.y + current.outY,
        next.x + next.inX, next.y + next.inY, next.x, next.y);
    }
  } else {
    for (const point of geometry.points.slice(1)) ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

function createCanvas(width: number, height: number) {
  const result = document.createElement("canvas");
  result.width = width; result.height = height;
  return result;
}

function canvasContext(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is not available in this browser.");
  return ctx;
}

export function applyCompositorMask(
  source: HTMLCanvasElement,
  layers: MaskLayer[],
  time: number,
  invert: boolean,
  motion: { x: number; y: number } | TrackingMatrix = { x: 0, y: 0 },
): HTMLCanvasElement {
  const activeLayers = layers.map((layer) => ({ layer, geometry: maskGeometryAt(layer, time) }))
    .filter(({ geometry }) => hasMaskArea(geometry));
  if (!activeLayers.length) return source;
  const scaleX = source.width / MASK_WIDTH;
  const scaleY = source.height / MASK_HEIGHT;
  const combined = createCanvas(source.width, source.height);
  const combinedContext = canvasContext(combined);
  const sourceMatrix: TrackingMatrix = Array.isArray(motion) ? motion : [1, 0, motion.x, 0, 1, motion.y, 0, 0, 1];
  const matrix = scaleTrackingMatrix(sourceMatrix, scaleX, scaleY);
  const perspective = Math.abs(matrix[6]) > 1e-10 || Math.abs(matrix[7]) > 1e-10;
  activeLayers.forEach(({ layer, geometry: sourceGeometry }, index) => {
    const geometry = scaleMaskGeometry(sourceGeometry, scaleX, scaleY);
    const shape = createCanvas(source.width, source.height);
    const shapeContext = canvasContext(shape);
    shapeContext.save();
    if (!perspective) shapeContext.transform(matrix[0], matrix[3], matrix[1], matrix[4], matrix[2], matrix[5]);
    const feather = layer.feather * Math.sqrt(scaleX * scaleY);
    shapeContext.filter = feather > 0 ? `blur(${feather}px)` : "none";
    shapeContext.fillStyle = "#fff";
    shapeContext.beginPath();
    traceGeometry(shapeContext, geometry);
    shapeContext.fill();
    shapeContext.restore();
    if (index > 0) combinedContext.globalCompositeOperation =
      layer.operation === "subtract" ? "destination-out" : layer.operation === "intersect" ? "destination-in" : "source-over";
    combinedContext.drawImage(shape, 0, 0);
    combinedContext.globalCompositeOperation = "source-over";
  });

  const transformed = perspective ? warpTrackingCanvas(combined, matrix) : combined;
  let matte = transformed;
  if (invert) {
    matte = createCanvas(source.width, source.height);
    const invertedContext = canvasContext(matte);
    invertedContext.fillStyle = "#fff";
    invertedContext.fillRect(0, 0, source.width, source.height);
    invertedContext.globalCompositeOperation = "destination-out";
    invertedContext.drawImage(transformed, 0, 0);
  }
  const result = createCanvas(source.width, source.height);
  const resultContext = canvasContext(result);
  resultContext.drawImage(source, 0, 0);
  resultContext.globalCompositeOperation = "destination-in";
  resultContext.drawImage(matte, 0, 0);
  return result;
}

export function addFreehandPoint(points: MaskPoint[], x: number, y: number): MaskPoint[] {
  const previous = points[points.length - 1];
  if (previous && Math.hypot(previous.x - x, previous.y - y) < MIN_POINT_DISTANCE) return points;
  return [...points, { x, y, inX: 0, inY: 0, outX: 0, outY: 0 }];
}

export function moveMaskGeometry(geometry: MaskGeometry, dx: number, dy: number): MaskGeometry {
  if ("x" in geometry) return { ...geometry, x: geometry.x + dx, y: geometry.y + dy };
  return { ...geometry, points: geometry.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })) };
}

export function maskCanvasSize() {
  return { width: MASK_WIDTH, height: MASK_HEIGHT };
}
