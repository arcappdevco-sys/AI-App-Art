export const VIDEO_EXPORT_RESOLUTIONS = [
  { value: "720p", label: "720p", width: 1280, height: 720 },
  { value: "1080p", label: "1080p", width: 1920, height: 1080 },
  { value: "4k", label: "4K UHD", width: 3840, height: 2160 },
] as const;

export type VideoExportResolution = typeof VIDEO_EXPORT_RESOLUTIONS[number]["value"];

export const VIDEO_EXPORT_ORIENTATIONS = ["landscape", "portrait"] as const;
export type VideoExportOrientation = typeof VIDEO_EXPORT_ORIENTATIONS[number];

export function isVideoExportResolution(value: unknown): value is VideoExportResolution {
  return typeof value === "string" && VIDEO_EXPORT_RESOLUTIONS.some(({ value: resolution }) => resolution === value);
}

export function isVideoExportOrientation(value: unknown): value is VideoExportOrientation {
  return typeof value === "string" && VIDEO_EXPORT_ORIENTATIONS.some((orientation) => orientation === value);
}

export function getVideoExportDimensions(
  resolution: unknown,
  orientation: unknown,
): { width: number; height: number } {
  if (!isVideoExportResolution(resolution)) throw new Error("Choose a supported video export resolution.");
  if (!isVideoExportOrientation(orientation)) throw new Error("Choose landscape or portrait orientation.");
  const preset = VIDEO_EXPORT_RESOLUTIONS.find(({ value }) => value === resolution);
  if (!preset) throw new Error("Choose a supported video export resolution.");
  return orientation === "portrait"
    ? { width: preset.height, height: preset.width }
    : { width: preset.width, height: preset.height };
}
