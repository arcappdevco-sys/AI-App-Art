import {
  STORYBOARD_CAMERA_MOVES,
  STORYBOARD_SHOT_TYPES,
  type StoryboardCameraMove,
  type StoryboardScene,
  type StoryboardShot,
  type StoryboardShotType,
} from "./StoryboardData";

export const STORYBOARD_SCRIPT_MAX_SCENES = 30;
export const STORYBOARD_SCRIPT_MAX_SHOTS_PER_SCENE = 12;

export type GeneratedStoryboardScene = StoryboardScene;
export type StoryboardScriptResult = { scenes: GeneratedStoryboardScene[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeShot(value: unknown): StoryboardShot | null {
  if (!isRecord(value)) return null;
  const duration = value.durationSeconds;
  const durationSeconds = typeof duration === "number" && Number.isFinite(duration)
    && duration >= 0.5 && duration <= 60 && Number.isInteger(duration * 2)
    ? duration
    : null;
  return {
    id: crypto.randomUUID(),
    title: safeText(value.title, 160),
    description: safeText(value.description, 4000),
    shotType: typeof value.shotType === "string"
      && STORYBOARD_SHOT_TYPES.includes(value.shotType as (typeof STORYBOARD_SHOT_TYPES)[number])
      ? value.shotType as StoryboardShotType
      : "",
    cameraMove: typeof value.cameraMove === "string"
      && STORYBOARD_CAMERA_MOVES.includes(value.cameraMove as (typeof STORYBOARD_CAMERA_MOVES)[number])
      ? value.cameraMove as StoryboardCameraMove
      : "",
    durationSeconds,
    notes: safeText(value.notes, 2000),
    frame: null,
  };
}

export function normalizeGeneratedStoryboard(value: unknown): StoryboardScriptResult {
  if (!isRecord(value) || !Array.isArray(value.scenes) || value.scenes.length === 0
    || value.scenes.length > STORYBOARD_SCRIPT_MAX_SCENES) {
    throw new Error("The generated storyboard has an invalid number of scenes.");
  }
  const scenes: GeneratedStoryboardScene[] = [];
  let shotCount = 0;
  for (const rawScene of value.scenes) {
    if (!isRecord(rawScene) || !Array.isArray(rawScene.shots)
      || rawScene.shots.length === 0 || rawScene.shots.length > STORYBOARD_SCRIPT_MAX_SHOTS_PER_SCENE) {
      throw new Error("The generated storyboard contains an invalid scene.");
    }
    const shots: StoryboardShot[] = [];
    for (const rawShot of rawScene.shots) {
      const shot = normalizeShot(rawShot);
      if (!shot) throw new Error("The generated storyboard contains an invalid shot.");
      shots.push(shot);
    }
    shotCount += shots.length;
    if (shotCount > 120) throw new Error("The generated storyboard contains too many shots.");
    scenes.push({
      id: crypto.randomUUID(),
      title: safeText(rawScene.title, 160) || `Scene ${scenes.length + 1}`,
      collapsed: false,
      shots,
    });
  }
  return { scenes };
}

export const STORYBOARD_SCRIPT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scenes"],
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "shots"],
        properties: {
          title: { type: "string" },
          shots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "description", "shotType", "cameraMove", "durationSeconds", "notes"],
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                shotType: { type: "string", enum: ["", ...STORYBOARD_SHOT_TYPES] },
                cameraMove: { type: "string", enum: ["", ...STORYBOARD_CAMERA_MOVES] },
                durationSeconds: { type: ["number", "null"] },
                notes: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;
