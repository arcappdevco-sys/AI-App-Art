import type { PortType } from "./types";

export type PreviewMediaType = "image" | "video";

export function previewMediaType(value: unknown, declaredType?: PortType): PreviewMediaType | null {
  if (typeof value !== "string" || !value) return null;
  if (declaredType === "image" || declaredType === "video") return declaredType;
  if (/^data:video\//i.test(value) || /\.(mp4|webm|mov)([?#]|$)/i.test(value)) return "video";
  if (/^data:image\//i.test(value) || /\.(png|jpe?g|webp|gif)([?#]|$)/i.test(value)) return "image";
  return null;
}

export function outputPreviewType(
  outputName: string,
  outputs: Record<string, PortType>,
  previewInputType?: PortType,
): PortType | undefined {
  if (outputName === "media") return previewInputType;
  if (outputName in outputs) return outputs[outputName];
  if (/^variation_\d+$/.test(outputName) && outputs.video === "video") return "video";
  return undefined;
}

export function isAtlasVideoNode(type: string): boolean {
  return [
    "video/wan-3.0", "video/minimax-h3", "video/flux-3", "video/seedance",
    "video/kling", "video/veo", "video/google-omni",
  ].includes(type);
}
