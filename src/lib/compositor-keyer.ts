import { applyMatteClip, getKeyColorChroma, refineMatte, RGB_LUMA_WEIGHTS } from "./chroma-key";
import type { CompositorParams } from "./compositor";

function value(params: CompositorParams, key: string, fallback: number, min: number, max: number) {
  const raw = params[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`Invalid keyer setting: ${key}.`);
  return Math.max(min, Math.min(max, raw));
}

export function applyCompositorKeyer(pixels: Uint8ClampedArray, width: number, height: number, params: CompositorParams) {
  const color = typeof params.color === "string" && /^#[0-9a-f]{6}$/i.test(params.color) ? params.color : "#00ff00";
  const rgb = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16)) as [number, number, number];
  const tolerance = value(params, "tolerance", 100, 0, Infinity);
  const softness = value(params, "softness", 35, 1, Infinity);
  const spill = value(params, "spillSuppression", 0, 0, 100) / 100;
  const black = value(params, "clipBlack", 0, 0, 99) / 100;
  const white = value(params, "clipWhite", 100, 1, 100) / 100;
  if (black >= white) throw new Error("Clip white must be greater than clip black.");
  const choke = value(params, "edgeChoke", 0, -20, 20);
  const feather = value(params, "edgeFeather", 0, 0, 20);
  const matte = new Uint8Array(width * height);
  const clampedMatte = new Uint8ClampedArray(matte.buffer);
  const originalAlpha = new Uint8Array(width * height);
  for (let n = 0; n < matte.length; n++) {
    const i = n * 4;
    const distance = Math.hypot(pixels[i] - rgb[0], pixels[i + 1] - rgb[1], pixels[i + 2] - rgb[2]);
    originalAlpha[n] = pixels[i + 3];
    clampedMatte[n] = pixels[i + 3] * Math.max(0, Math.min(1, (distance - tolerance) / softness));
  }
  if (choke || feather) refineMatte(matte, new Uint8Array(matte.length), new Int32Array(Math.max(width, height)), width, height, choke, feather);
  const chroma = getKeyColorChroma(rgb);
  for (let n = 0; n < matte.length; n++) {
    const i = n * 4, alpha = matte[n] / 255;
    if (spill > 0 && chroma.magnitudeSquared >= 0.001 && alpha > 0 && alpha < 1) {
      const channels = [pixels[i], pixels[i + 1], pixels[i + 2]];
      const luma = channels[0] * RGB_LUMA_WEIGHTS[0] + channels[1] * RGB_LUMA_WEIGHTS[1] + channels[2] * RGB_LUMA_WEIGHTS[2];
      const projection = Math.max(0, channels.reduce((sum, channel, c) => sum + (channel - luma) * chroma.vector[c], 0) / chroma.magnitudeSquared);
      let limit = Infinity;
      chroma.vector.forEach((component, c) => {
        if (component > 0) limit = Math.min(limit, channels[c] / component);
        else if (component < 0) limit = Math.min(limit, (255 - channels[c]) / -component);
      });
      const correction = Math.min(projection * spill * 4 * alpha * (1 - alpha), limit);
      for (let c = 0; c < 3; c++) pixels[i + c] = channels[c] - chroma.vector[c] * correction;
    }
    pixels[i + 3] = Math.min(originalAlpha[n], Math.round(applyMatteClip(alpha, black, white) * 255));
  }
}
