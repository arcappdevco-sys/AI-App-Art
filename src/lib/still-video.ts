export const STILL_VIDEO_MOTIONS = ["none", "zoom-in", "zoom-out", "pan-left", "pan-right"] as const;
export type StillVideoMotion = typeof STILL_VIDEO_MOTIONS[number];

export const STILL_VIDEO_FPS = 30;
export const STILL_VIDEO_WIDTH = 1280;
export const STILL_VIDEO_HEIGHT = 720;
export const MAX_STILL_VIDEO_SECONDS = 60;
export const MAX_STILL_IMAGE_BYTES = 200 * 1024 * 1024;
export const MAX_STILL_IMAGE_DIMENSION = 8192;
export const MAX_STILL_IMAGE_PIXELS = 40_000_000;

export function isStillVideoMotion(value: unknown): value is StillVideoMotion {
  return typeof value === "string" && STILL_VIDEO_MOTIONS.some((motion) => motion === value);
}

export function validateStillVideoSettings(duration: unknown, motion: unknown): asserts duration is number {
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1 || duration > MAX_STILL_VIDEO_SECONDS) {
    throw new Error(`Still clips must be between 1 and ${MAX_STILL_VIDEO_SECONDS} seconds.`);
  }
  if (!isStillVideoMotion(motion)) throw new Error("Choose a supported still-image motion.");
}

export function validateStillImage(type: string, size: number, width: number, height: number): void {
  if (!["image/jpeg", "image/png", "image/webp"].includes(type.toLowerCase())) {
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_STILL_IMAGE_BYTES) {
    throw new Error("Still images must be no larger than 200 MB.");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_STILL_IMAGE_DIMENSION || height > MAX_STILL_IMAGE_DIMENSION
    || width * height > MAX_STILL_IMAGE_PIXELS) {
    throw new Error("The image dimensions are too large to prepare safely.");
  }
}

export function stillVideoFilter(
  duration: number,
  motion: StillVideoMotion,
  width = STILL_VIDEO_WIDTH,
  height = STILL_VIDEO_HEIGHT,
): string {
  const fit = motion === "none"
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  if (motion === "none") return `${fit},setsar=1,fps=${STILL_VIDEO_FPS},format=yuv420p`;

  const frames = duration * STILL_VIDEO_FPS;
  const zoom = motion === "zoom-in" ? `1+0.12*on/${frames}`
    : motion === "zoom-out" ? `1.12-0.12*on/${frames}` : "1.12";
  const x = motion === "pan-left" ? `(iw-iw/zoom)*(1-on/${frames})`
    : motion === "pan-right" ? `(iw-iw/zoom)*on/${frames}` : "iw/2-(iw/zoom/2)";
  const y = "ih/2-(ih/zoom/2)";
  return `${fit},zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${STILL_VIDEO_FPS},setsar=1,format=yuv420p`;
}
