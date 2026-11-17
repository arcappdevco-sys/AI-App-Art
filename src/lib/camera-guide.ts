export type CameraTrackKeyframe = {
  frame: number;
  position: [number, number, number];
  rotationDegrees: [number, number, number];
  focalLengthMm?: number;
};

export type CameraTrack = {
  version: 1;
  frameRate: number;
  handedness: "left" | "right";
  upAxis: "Y" | "Z";
  keyframes: CameraTrackKeyframe[];
};

const MAX_KEYFRAMES = 16;
const MAX_JSON_LENGTH = 32_000;
export const CAMERA_TRACK_JSON_EXAMPLE = JSON.stringify({
  version: 1,
  frameRate: 24,
  handedness: "right",
  upAxis: "Y",
  keyframes: [
    { frame: 0, position: [0, 1.6, 0], rotationDegrees: [0, 0, 0], focalLengthMm: 35 },
    { frame: 48, position: [0, 1.6, -2], rotationDegrees: [0, 15, 0], focalLengthMm: 35 },
  ],
}, null, 2);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vector(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} must contain three finite numbers between -100000 and 100000.`);
  }
  const [x, y, z] = value;
  if (![x, y, z].every((item) =>
    typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100_000)) {
    throw new Error(`${label} must contain three finite numbers between -100000 and 100000.`);
  }
  return [x, y, z];
}

export function parseCameraTrack(value: unknown): CameraTrack {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste camera track JSON.");
  if (value.length > MAX_JSON_LENGTH) throw new Error("Camera track JSON must be 32,000 characters or smaller.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Camera track must be valid JSON.");
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error("Camera track must be an object with version 1.");
  }
  const frameRate = parsed.frameRate;
  if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 240) {
    throw new Error("Camera track frameRate must be greater than 0 and no more than 240.");
  }
  const handedness = parsed.handedness ?? "right";
  if (handedness !== "left" && handedness !== "right") {
    throw new Error('Camera track handedness must be "left" or "right".');
  }
  const upAxis = parsed.upAxis ?? "Y";
  if (upAxis !== "Y" && upAxis !== "Z") {
    throw new Error('Camera track upAxis must be "Y" or "Z".');
  }
  if (!Array.isArray(parsed.keyframes) || parsed.keyframes.length === 0 || parsed.keyframes.length > MAX_KEYFRAMES) {
    throw new Error(`Camera track must contain 1 to ${MAX_KEYFRAMES} keyframes.`);
  }
  let previousFrame = -1;
  const keyframes = parsed.keyframes.map((value, index): CameraTrackKeyframe => {
    if (!isRecord(value) || typeof value.frame !== "number" || !Number.isSafeInteger(value.frame)
      || value.frame < 0 || value.frame <= previousFrame) {
      throw new Error(`Camera keyframe ${index + 1} must have a unique, increasing non-negative integer frame.`);
    }
    previousFrame = value.frame;
    const focalLengthMm = value.focalLengthMm;
    if (focalLengthMm !== undefined
      && (typeof focalLengthMm !== "number" || !Number.isFinite(focalLengthMm) || focalLengthMm <= 0 || focalLengthMm > 1000)) {
      throw new Error(`Camera keyframe ${index + 1} focalLengthMm must be greater than 0 and no more than 1000.`);
    }
    return {
      frame: previousFrame,
      position: vector(value.position, `Camera keyframe ${index + 1} position`),
      rotationDegrees: vector(value.rotationDegrees, `Camera keyframe ${index + 1} rotationDegrees`),
      ...(typeof focalLengthMm === "number" ? { focalLengthMm } : {}),
    };
  });
  return {
    version: 1,
    frameRate,
    handedness,
    upAxis,
    keyframes,
  };
}

function formatNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

export function formatCameraTrackGuide(value: unknown): string {
  const track = parseCameraTrack(value);
  const frames = track.keyframes.map((keyframe) =>
    `frame ${keyframe.frame}: position [${keyframe.position.map(formatNumber).join(", ")}], `
    + `Euler XYZ [${keyframe.rotationDegrees.map(formatNumber).join(", ")}] degrees`
    + (keyframe.focalLengthMm === undefined ? "" : `, focal length ${formatNumber(keyframe.focalLengthMm)} mm`));
  return [
    "Camera path guide (approximate prompt guidance, not a hard 3D constraint).",
    `Track: ${track.frameRate} fps, ${track.handedness}-handed, ${track.upAxis}-up; positions use scene units.`,
    `Keyframes: ${frames.join("; ")}.`,
  ].join(" ");
}
