import { trackPatch, type TrackPoint } from "./compositor";

export type TrackingMode = "point" | "two-point" | "planar";
export type TrackingPoint = { x: number; y: number };
export type TrackingMatrix = [number, number, number, number, number, number, number, number, number];
export type TrackingSample = {
  time: number;
  matrix: TrackingMatrix;
  anchors: TrackingPoint[];
  confidence: number;
};
export type TrackingResult = {
  mode: TrackingMode;
  samples: TrackingSample[];
  complete: boolean;
  endTime: number;
};
export type TrackingData = TrackPoint[] | TrackingResult;

export const IDENTITY_TRACKING_MATRIX: TrackingMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function trackerMode(params: Record<string, unknown>): TrackingMode {
  return params.mode === "two-point" || params.mode === "planar" ? params.mode : "point";
}

export function trackerAnchors(params: Record<string, unknown>): TrackingPoint[] {
  const mode = trackerMode(params);
  const number = (key: string, fallback: number) => {
    const value = params[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  if (mode === "planar") {
    return [
      { x: number("planeX1", 160), y: number("planeY1", 90) },
      { x: number("planeX2", 480), y: number("planeY2", 90) },
      { x: number("planeX3", 480), y: number("planeY3", 270) },
      { x: number("planeX4", 160), y: number("planeY4", 270) },
    ];
  }
  const points = [{ x: number("x", 320), y: number("y", 180) }];
  if (mode === "two-point") points.push({ x: number("x2", 420), y: number("y2", 180) });
  return points;
}

export function validateTrackingProjection(matrix: TrackingMatrix): void {
  const denominators = [matrix[8], matrix[6] * 640 + matrix[8],
    matrix[7] * 360 + matrix[8], matrix[6] * 640 + matrix[7] * 360 + matrix[8]];
  if (denominators.some((value) => !Number.isFinite(value) || value <= 1e-6)) {
    throw new Error("The tracked perspective crosses the image horizon. Adjust the tracking surface.");
  }
}

export function validateTrackingSurface(points: TrackingPoint[]): void {
  if (points.length !== 4) throw new Error("A planar surface requires four corners.");
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 4 || sign && Math.sign(cross) !== sign) {
      throw new Error("Planar corners must form a non-intersecting, convex surface.");
    }
    sign = Math.sign(cross);
  }
}

export function transformTrackingPoint(matrix: TrackingMatrix, point: TrackingPoint): TrackingPoint {
  const d = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(d) < 1e-10) throw new Error("Tracking perspective crosses infinity.");
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / d,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / d,
  };
}

export function multiplyTrackingMatrices(a: TrackingMatrix, b: TrackingMatrix): TrackingMatrix {
  const result = Array.from({ length: 9 }, (_, i) =>
    a[Math.floor(i / 3) * 3] * b[i % 3]
    + a[Math.floor(i / 3) * 3 + 1] * b[3 + i % 3]
    + a[Math.floor(i / 3) * 3 + 2] * b[6 + i % 3]);
  return [result[0], result[1], result[2], result[3], result[4], result[5], result[6], result[7], result[8]];
}

export function invertTrackingMatrix(m: TrackingMatrix): TrackingMatrix {
  const [a, b, c, d, e, f, g, h, i] = m;
  const result: TrackingMatrix = [
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ];
  const determinant = a * result[0] + b * result[3] + c * result[6];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) throw new Error("Tracking transform is singular.");
  return [result[0] / determinant, result[1] / determinant, result[2] / determinant,
    result[3] / determinant, result[4] / determinant, result[5] / determinant,
    result[6] / determinant, result[7] / determinant, result[8] / determinant];
}

export function similarityTrackingMatrix(from: TrackingPoint[], to: TrackingPoint[]): TrackingMatrix {
  if (from.length !== to.length || from.length < 1 || from.length > 2) throw new Error("Tracking requires one or two matched points.");
  if (from.length === 1) return [1, 0, to[0].x - from[0].x, 0, 1, to[0].y - from[0].y, 0, 0, 1];
  const dx = from[1].x - from[0].x, dy = from[1].y - from[0].y;
  const ux = to[1].x - to[0].x, uy = to[1].y - to[0].y;
  const denominator = dx * dx + dy * dy;
  if (denominator < 1 || ux * ux + uy * uy < 1) throw new Error("Tracking points must be separated.");
  const a = (dx * ux + dy * uy) / denominator, b = (dx * uy - dy * ux) / denominator;
  return [a, -b, to[0].x - a * from[0].x + b * from[0].y,
    b, a, to[0].y - b * from[0].x - a * from[0].y, 0, 0, 1];
}

function solveLinearSystem(rows: number[][]): number[] {
  const n = rows.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-9) throw new Error("Tracking points do not define a usable surface.");
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const value = rows[column][column];
    for (let j = column; j <= n; j++) rows[column][j] /= value;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let j = column; j <= n; j++) rows[row][j] -= factor * rows[column][j];
    }
  }
  return rows.map((row) => row[n]);
}

export function planarTrackingMatrix(from: TrackingPoint[], to: TrackingPoint[]): TrackingMatrix {
  if (from.length !== to.length || from.length < 4) throw new Error("Planar tracking requires at least four matched points.");
  const rows: number[][] = [];
  for (let i = 0; i < from.length; i++) {
    const { x, y } = from[i], u = to[i].x, v = to[i].y;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const normal = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 9 }, (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const [a, b, c, d, e, f, g, h] = solveLinearSystem(normal);
  const matrix: TrackingMatrix = [a, b, c, d, e, f, g, h, 1];
  invertTrackingMatrix(matrix);
  return matrix;
}

export function trackingAt(data: TrackingData, time: number): TrackingSample {
  if (Array.isArray(data)) {
    if (!data.length) throw new Error("Run the tracker before rendering.");
    const first = data[0];
    const index = data.findIndex((sample) => sample.time >= time);
    const next = index < 0 ? data[data.length - 1] : data[index];
    const previous = index <= 0 ? next : data[index - 1];
    const amount = next.time === previous.time ? 0 : (time - previous.time) / (next.time - previous.time);
    const x = previous.x + (next.x - previous.x) * amount;
    const y = previous.y + (next.y - previous.y) * amount;
    return { time, matrix: [1, 0, x - first.x, 0, 1, y - first.y, 0, 0, 1],
      anchors: [{ x, y }], confidence: previous.confidence + (next.confidence - previous.confidence) * amount };
  }
  const samples = data.samples;
  if (!samples.length) throw new Error("Run the tracker before rendering.");
  if (!data.complete && time > samples[samples.length - 1].time + 0.001) {
    throw new Error("Tracking is incomplete at this time. Correct the feature and resume tracking.");
  }
  const index = samples.findIndex((sample) => sample.time >= time);
  if (index <= 0) {
    const sample = index === 0 ? samples[0] : samples[samples.length - 1];
    validateTrackingProjection(sample.matrix);
    return sample;
  }
  const before = samples[index - 1], after = samples[index];
  const amount = (time - before.time) / (after.time - before.time);
  const anchors = before.anchors.map((point, i) => ({
    x: point.x + (after.anchors[i].x - point.x) * amount,
    y: point.y + (after.anchors[i].y - point.y) * amount,
  }));
  const initial = samples[0].anchors;
  if (data.mode === "planar") validateTrackingSurface(anchors);
  const matrix = data.mode === "planar" ? planarTrackingMatrix(initial, anchors) : similarityTrackingMatrix(initial, anchors);
  validateTrackingProjection(matrix);
  return { time, matrix, anchors, confidence: before.confidence + (after.confidence - before.confidence) * amount };
}

function insidePolygon(point: TrackingPoint, polygon: TrackingPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function detectPlanarFeatures(pixels: Uint8ClampedArray, width: number, height: number, polygon: TrackingPoint[]): TrackingPoint[] {
  const candidates: { x: number; y: number; score: number }[] = [];
  const gray = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    return (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
  };
  for (let y = 8; y < height - 8; y += 3) for (let x = 8; x < width - 8; x += 3) {
    if (!insidePolygon({ x, y }, polygon)) continue;
    let xx = 0, yy = 0, xy = 0;
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const gx = gray(x + ox + 1, y + oy) - gray(x + ox - 1, y + oy);
      const gy = gray(x + ox, y + oy + 1) - gray(x + ox, y + oy - 1);
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
    }
    const score = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 2;
    if (score > 5000) candidates.push({ x, y, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected: TrackingPoint[] = [];
  for (const candidate of candidates) {
    if (selected.every((point) => Math.hypot(candidate.x - point.x, candidate.y - point.y) >= 10)) selected.push(candidate);
    if (selected.length >= 40) break;
  }
  if (selected.length < 6) throw new Error("The selected surface needs more visible texture for planar tracking.");
  return selected;
}

export function trackPlanarFeatures(
  previous: Uint8ClampedArray, current: Uint8ClampedArray, width: number, height: number, features: TrackingPoint[],
): { matrix: TrackingMatrix; features: TrackingPoint[]; confidence: number } {
  const from: TrackingPoint[] = [], to: TrackingPoint[] = [], confidences: number[] = [];
  for (const feature of features) {
    if (feature.x < 5 || feature.y < 5 || feature.x >= width - 5 || feature.y >= height - 5) continue;
    let match: ReturnType<typeof trackPatch>;
    try { match = trackPatch(previous, current, width, height, Math.round(feature.x), Math.round(feature.y)); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Tracking feature has too little contrast")) continue;
      throw error;
    }
    if (match.confidence < 0.8) continue;
    from.push(feature); to.push({ x: match.x, y: match.y }); confidences.push(match.confidence);
  }
  if (from.length < 6) throw new Error("Too few surface features remain to track the plane.");
  let best: number[] = [];
  let seed = 1234567;
  for (let attempt = 0; attempt < 120; attempt++) {
    const picked = new Set<number>();
    while (picked.size < 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; picked.add(seed % from.length); }
    const indices = [...picked];
    let matrix: TrackingMatrix;
    try { matrix = planarTrackingMatrix(indices.map((i) => from[i]), indices.map((i) => to[i])); }
    catch { continue; }
    const inliers = from.map((point, i) => {
      try {
        const predicted = transformTrackingPoint(matrix, point);
        return Math.hypot(predicted.x - to[i].x, predicted.y - to[i].y) <= 2 ? i : -1;
      } catch { return -1; }
    }).filter((i) => i >= 0);
    if (inliers.length > best.length) best = inliers;
  }
  if (best.length < 6 || best.length < from.length * 0.5) throw new Error("The surface motion is unreliable. Adjust the tracking area and resume.");
  const matrix = planarTrackingMatrix(best.map((i) => from[i]), best.map((i) => to[i]));
  return { matrix, features: best.map((i) => to[i]), confidence: best.reduce((sum, i) => sum + confidences[i], 0) / from.length };
}

export function warpTrackingPixels(
  source: Uint8ClampedArray, width: number, height: number, matrix: TrackingMatrix,
): Uint8ClampedArray {
  const inverse = invertTrackingMatrix(matrix);
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const denominator = inverse[6] * (x + 0.5) + inverse[7] * (y + 0.5) + inverse[8];
    if (Math.abs(denominator) < 1e-10) continue;
    const sx = (inverse[0] * (x + 0.5) + inverse[1] * (y + 0.5) + inverse[2]) / denominator - 0.5;
    const sy = (inverse[3] * (x + 0.5) + inverse[4] * (y + 0.5) + inverse[5]) / denominator - 0.5;
    if (sx <= -1 || sy <= -1 || sx >= width || sy >= height) continue;
    const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top;
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (let oy = 0; oy <= 1; oy++) for (let ox = 0; ox <= 1; ox++) {
      const px = left + ox, py = top + oy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const weight = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy);
      const index = (py * width + px) * 4;
      const a = source[index + 3] * weight;
      alpha += a; red += source[index] * a; green += source[index + 1] * a; blue += source[index + 2] * a;
    }
    if (!alpha) continue;
    const index = (y * width + x) * 4;
    output[index] = red / alpha; output[index + 1] = green / alpha; output[index + 2] = blue / alpha; output[index + 3] = alpha;
  }
  return output;
}

export function warpTrackingCanvas(source: HTMLCanvasElement, matrix: TrackingMatrix): HTMLCanvasElement {
  const input = source.getContext("2d", { willReadFrequently: true });
  if (!input) throw new Error("Canvas rendering is not available in this browser.");
  const output = document.createElement("canvas");
  output.width = source.width; output.height = source.height;
  const ctx = output.getContext("2d");
  if (!ctx) throw new Error("Canvas rendering is not available in this browser.");
  const image = input.getImageData(0, 0, source.width, source.height);
  image.data.set(warpTrackingPixels(image.data, source.width, source.height, matrix));
  ctx.putImageData(image, 0, 0);
  return output;
}
