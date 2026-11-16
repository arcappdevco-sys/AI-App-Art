import type { CompositorParams } from "./compositor";

export type CurvePoint = { x: number; y: number };
export type CurveChannel = "master" | "red" | "green" | "blue";

export const CURVE_CHANNELS: CurveChannel[] = ["master", "red", "green", "blue"];
export const IDENTITY_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

function isCurvePointArray(value: unknown): value is CurvePoint[] {
  return Array.isArray(value) && value.every((point) => point && typeof point.x === "number" && typeof point.y === "number");
}

export function getCurve(params: CompositorParams, channel: CurveChannel): CurvePoint[] {
  const value = params[`curve_${channel}`];
  if (value === undefined) return IDENTITY_CURVE;
  if (!isCurvePointArray(value) || value.length < 2 || value.length > 12 ||
      value.some((point, index) => !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        point.x < 0 || point.x > 255 || point.y < 0 || point.y > 255 ||
        (index > 0 && point.x <= value[index - 1].x)) ||
      value[0].x !== 0 || value[value.length - 1].x !== 255) {
    throw new Error(`Invalid ${channel} color curve.`);
  }
  return value;
}

function setting(params: CompositorParams, name: string, fallback: number, min: number, max: number): number {
  const value = params[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid color setting: ${name}.`);
  return Math.max(min, Math.min(max, value));
}

export function curveTable(points: CurvePoint[]): Float32Array {
  const table = new Float32Array(256);
  let segment = 0;
  for (let x = 0; x <= 255; x++) {
    while (segment < points.length - 2 && x > points[segment + 1].x) segment++;
    const a = points[segment], b = points[segment + 1];
    table[x] = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
  }
  return table;
}

function lookup(table: Float32Array, value: number): number {
  const v = Math.max(0, Math.min(255, value));
  const low = Math.floor(v), high = Math.min(255, low + 1);
  return table[low] + (table[high] - table[low]) * (v - low);
}

export function applyColorCorrection(pixels: Uint8ClampedArray, params: CompositorParams): void {
  const brightness = setting(params, "brightness", 0, -Infinity, Infinity);
  const contrast = setting(params, "contrast", 100, -Infinity, Infinity) / 100;
  const saturation = setting(params, "saturation", 100, -Infinity, Infinity) / 100;
  const exposure = 2 ** setting(params, "exposure", 0, -4, 4);
  const gamma = 1 / setting(params, "gamma", 1, 0.1, 4);
  const temperature = setting(params, "temperature", 0, -100, 100);
  const tint = setting(params, "tint", 0, -100, 100);
  const shadows = setting(params, "shadows", 0, -100, 100);
  const highlights = setting(params, "highlights", 0, -100, 100);
  const gains = ["redGain", "greenGain", "blueGain"].map((key) => setting(params, key, 100, 0, 300) / 100);
  const tables = CURVE_CHANNELS.map((channel) => curveTable(getCurve(params, channel)));

  for (let i = 0; i < pixels.length; i += 4) {
    const gray = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    for (let c = 0; c < 3; c++) {
      let value = ((gray + (pixels[i + c] - gray) * saturation - 128) * contrast + 128 + brightness) * exposure;
      value = 255 * Math.pow(Math.max(0, value) / 255, gamma);
      const tone = Math.max(0, Math.min(1, value / 255));
      value += shadows * (1 - tone) ** 2 + highlights * tone ** 2;
      value += c === 0 ? temperature * 0.5 + tint * 0.25 : c === 1 ? -tint * 0.5 : -temperature * 0.5 + tint * 0.25;
      value *= gains[c];
      pixels[i + c] = lookup(tables[c + 1], lookup(tables[0], value));
    }
  }
}
