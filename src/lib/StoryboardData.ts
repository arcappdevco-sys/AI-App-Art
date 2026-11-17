import { normalizeMediaAssetMetadata, type MediaAssetMetadata } from "./project-media";

export const STORYBOARD_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "21:9"] as const;
export const STORYBOARD_SHOT_TYPES = [
  "Extreme wide",
  "Wide",
  "Medium",
  "Close-up",
  "Extreme close-up",
  "Over the shoulder",
  "POV",
  "Aerial",
  "Low angle",
  "High angle",
] as const;
export const STORYBOARD_CAMERA_MOVES = [
  "Static",
  "Pan",
  "Tilt",
  "Dolly in",
  "Dolly out",
  "Tracking",
  "Handheld",
  "Zoom in",
  "Zoom out",
  "Orbit",
  "Crane",
] as const;
export const STORYBOARD_SCRIPT_MAX_CHARACTERS = 40000;

export type StoryboardAspectRatio = (typeof STORYBOARD_ASPECT_RATIOS)[number];
export type StoryboardShotType = (typeof STORYBOARD_SHOT_TYPES)[number] | "";
export type StoryboardCameraMove = (typeof STORYBOARD_CAMERA_MOVES)[number] | "";

export type StoryboardShot = {
  id: string;
  title: string;
  description: string;
  shotType: StoryboardShotType;
  cameraMove: StoryboardCameraMove;
  durationSeconds: number | null;
  notes: string;
  frame: string | null;
  frameMetadata?: MediaAssetMetadata;
};

export type StoryboardScene = {
  id: string;
  title: string;
  collapsed: boolean;
  shots: StoryboardShot[];
};

export type StoryboardData = {
  version: 1;
  title: string;
  aspectRatio: StoryboardAspectRatio;
  scenes: StoryboardScene[];
};

const EMPTY_SHOT_TYPE: StoryboardShotType = "";
const EMPTY_CAMERA_MOVE: StoryboardCameraMove = "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId() {
  return crypto.randomUUID();
}

function addUniqueId(candidate: unknown, usedIds: Set<string>) {
  let id = typeof candidate === "string" && candidate.trim() ? candidate : createId();
  while (usedIds.has(id)) id = createId();
  usedIds.add(id);
  return id;
}

export function createEmptyStoryboard(): StoryboardData {
  return { version: 1, title: "Untitled storyboard", aspectRatio: "16:9", scenes: [] };
}

export function createStoryboardShot(): StoryboardShot {
  return {
    id: createId(),
    title: "",
    description: "",
    shotType: EMPTY_SHOT_TYPE,
    cameraMove: EMPTY_CAMERA_MOVE,
    durationSeconds: null,
    notes: "",
    frame: null,
  };
}

export function createStoryboardScene(sceneNumber: number): StoryboardScene {
  return { id: createId(), title: `Scene ${sceneNumber}`, collapsed: false, shots: [] };
}

function normalizeShot(value: unknown, usedIds: Set<string>): StoryboardShot | null {
  if (!isRecord(value)) return null;
  const id = addUniqueId(value.id, usedIds);
  const duration = value.durationSeconds;
  const durationSeconds = typeof duration === "number" && Number.isFinite(duration)
    && duration >= 0.5 && duration <= 60 && Number.isInteger(duration * 2)
    ? duration
    : null;
  const frame = typeof value.frame === "string"
    && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value.frame)
    ? value.frame
    : null;
  const frameMetadata = frame ? normalizeMediaAssetMetadata(value.frameMetadata) : undefined;
  return {
    id,
    title: typeof value.title === "string" ? value.title : "",
    description: typeof value.description === "string" ? value.description : "",
    shotType: typeof value.shotType === "string" && STORYBOARD_SHOT_TYPES.includes(value.shotType as (typeof STORYBOARD_SHOT_TYPES)[number])
      ? value.shotType as StoryboardShotType
      : EMPTY_SHOT_TYPE,
    cameraMove: typeof value.cameraMove === "string" && STORYBOARD_CAMERA_MOVES.includes(value.cameraMove as (typeof STORYBOARD_CAMERA_MOVES)[number])
      ? value.cameraMove as StoryboardCameraMove
      : EMPTY_CAMERA_MOVE,
    durationSeconds,
    notes: typeof value.notes === "string" ? value.notes : "",
    frame,
    ...(frameMetadata ? { frameMetadata } : {}),
  };
}

export function normalizeStoryboard(value: unknown): StoryboardData {
  if (!isRecord(value) || value.version !== 1) return createEmptyStoryboard();
  const scenes: StoryboardScene[] = [];
  const usedIds = new Set<string>();
  if (Array.isArray(value.scenes)) {
    for (const rawScene of value.scenes) {
      if (!isRecord(rawScene)) continue;
      const id = addUniqueId(rawScene.id, usedIds);
      const shots = Array.isArray(rawScene.shots)
        ? rawScene.shots.flatMap((shot) => {
          const normalized = normalizeShot(shot, usedIds);
          return normalized ? [normalized] : [];
        })
        : [];
      scenes.push({
        id,
        title: typeof rawScene.title === "string" && rawScene.title.trim()
          ? rawScene.title
          : `Scene ${scenes.length + 1}`,
        collapsed: rawScene.collapsed === true,
        shots,
      });
    }
  }
  return {
    version: 1,
    title: typeof value.title === "string" && value.title.trim() ? value.title : "Untitled storyboard",
    aspectRatio: typeof value.aspectRatio === "string"
      && STORYBOARD_ASPECT_RATIOS.includes(value.aspectRatio as StoryboardAspectRatio)
      ? value.aspectRatio as StoryboardAspectRatio
      : "16:9",
    scenes,
  };
}
