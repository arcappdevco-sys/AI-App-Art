import { normalizeMediaAssetMetadata, type MediaAssetMetadata } from "./project-media";
import type {
  StoryboardCharacterAppearance,
  StoryboardCharacterCandidate,
} from "./storyboard-character-analysis";

export const STORYBOARD_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "21:9"] as const;
export const STORYBOARD_SHOT_TYPES = [
  "Title card",
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

export type StoryboardGeneratedTake = {
  id: string;
  sourceId: string;
  workflowId: string;
  nodeId: string;
  outputPort: string;
  videoType: string;
  videoUrl: string;
  mediaAssetId?: string;
  model: string;
  prompt: string;
  createdAt: number;
};

export type StoryboardShot = {
  id: string;
  title: string;
  description: string;
  prompt: string;
  characterIds?: string[];
  shotType: StoryboardShotType;
  cameraMove: StoryboardCameraMove;
  durationSeconds: number | null;
  notes: string;
  frame: string | null;
  generatedTakes?: StoryboardGeneratedTake[];
  frameMetadata?: MediaAssetMetadata;
};

export type StoryboardScene = {
  id: string;
  title: string;
  collapsed: boolean;
  shots: StoryboardShot[];
};

export type StoryboardStyleBible = {
  visualStyle: string;
  recurringCharacter: string;
  recurringLocation: string;
};

export type StoryboardCharacter = StoryboardCharacterCandidate & {
  id: string;
  referenceImageMediaAssetId?: string;
  referenceImageApproved?: boolean;
  referenceImageSource?: "uploaded" | "generated";
  referenceImageModel?: string;
};

export type StoryboardCharacterDraft = Omit<StoryboardCharacter, "id">;

export type StoryboardData = {
  version: 1;
  title: string;
  aspectRatio: StoryboardAspectRatio;
  styleBible?: StoryboardStyleBible;
  characters?: StoryboardCharacter[];
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
  return {
    version: 1,
    title: "Untitled storyboard",
    aspectRatio: "16:9",
    styleBible: { visualStyle: "", recurringCharacter: "", recurringLocation: "" },
    characters: [],
    scenes: [],
  };
}

export function createStoryboardShot(): StoryboardShot {
  return {
    id: createId(),
    title: "",
    description: "",
    prompt: "",
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

export function extractStoryboardStyleBible(scenes: readonly StoryboardScene[]): StoryboardStyleBible {
  const values: Record<keyof StoryboardStyleBible, string[]> = {
    visualStyle: [],
    recurringCharacter: [],
    recurringLocation: [],
  };
  const marker = /^\s*\*{0,2}(Visual style|Character continuity|Recurring character|Location continuity|Recurring location)\*{0,2}\s*:\s*/gim;
  for (const shot of scenes.flatMap((scene) => scene.shots)) {
    const matches = Array.from(shot.description.matchAll(marker));
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const markerName = match[1].toLowerCase();
      const key: keyof StoryboardStyleBible = markerName === "visual style"
        ? "visualStyle"
        : markerName.includes("character") ? "recurringCharacter" : "recurringLocation";
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? shot.description.length;
      const value = shot.description.slice(start, end).replace(/\s*\*{1,2}\s*$/, "").trim();
      if (value && !values[key].some((existing) => existing.toLowerCase() === value.toLowerCase())) {
        values[key].push(value.slice(0, 8000));
      }
    }
  }
  return {
    visualStyle: values.visualStyle.join("\n"),
    recurringCharacter: values.recurringCharacter.join("\n"),
    recurringLocation: values.recurringLocation.join("\n"),
  };
}

export function stripStoryboardContinuityBlocks(description: string) {
  const marker = /^\s*\*{0,2}(?:Visual style|Character continuity|Recurring character|Location continuity|Recurring location)\*{0,2}\s*:/im;
  const markerIndex = description.search(marker);
  return (markerIndex < 0 ? description : description.slice(0, markerIndex)).trim();
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
  const characterIds = Array.isArray(value.characterIds)
    ? [...new Set(value.characterIds.flatMap((id) =>
      typeof id === "string" && id.trim() ? [id.trim()] : []))].slice(0, 3)
    : [];
  const generatedTakes = Array.isArray(value.generatedTakes)
    ? value.generatedTakes.flatMap((take) => {
      if (!isRecord(take)
        || typeof take.sourceId !== "string" || !take.sourceId.trim()
        || typeof take.workflowId !== "string" || !take.workflowId.trim()
        || typeof take.nodeId !== "string" || !take.nodeId.trim()
        || typeof take.outputPort !== "string" || !take.outputPort.trim()
        || typeof take.videoType !== "string" || !take.videoType.trim()
        || typeof take.videoUrl !== "string"
        || typeof take.model !== "string"
        || typeof take.prompt !== "string"
        || typeof take.createdAt !== "number" || !Number.isFinite(take.createdAt)
        || take.createdAt < 0 || take.createdAt > 8_640_000_000_000_000) {
        return [];
      }
      let videoUrl: URL;
      try { videoUrl = new URL(take.videoUrl); }
      catch { return []; }
      if (videoUrl.protocol !== "http:" && videoUrl.protocol !== "https:") return [];
      return [{
        id: addUniqueId(take.id, usedIds),
        sourceId: take.sourceId,
        workflowId: take.workflowId,
        nodeId: take.nodeId,
        outputPort: take.outputPort,
        videoType: take.videoType,
        videoUrl: videoUrl.toString(),
        ...(typeof take.mediaAssetId === "string" && take.mediaAssetId.trim()
          ? { mediaAssetId: take.mediaAssetId }
          : {}),
        model: take.model.trim() || "Video model",
        prompt: take.prompt,
        createdAt: take.createdAt,
      }];
    })
    : [];
  return {
    id,
    title: typeof value.title === "string" ? value.title : "",
    description: typeof value.description === "string" ? value.description : "",
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    ...(characterIds.length ? { characterIds } : {}),
    shotType: typeof value.shotType === "string" && STORYBOARD_SHOT_TYPES.includes(value.shotType as (typeof STORYBOARD_SHOT_TYPES)[number])
      ? value.shotType as StoryboardShotType
      : EMPTY_SHOT_TYPE,
    cameraMove: typeof value.cameraMove === "string" && STORYBOARD_CAMERA_MOVES.includes(value.cameraMove as (typeof STORYBOARD_CAMERA_MOVES)[number])
      ? value.cameraMove as StoryboardCameraMove
      : EMPTY_CAMERA_MOVE,
    durationSeconds,
    notes: typeof value.notes === "string" ? value.notes : "",
    frame,
    ...(generatedTakes.length ? { generatedTakes } : {}),
    ...(frameMetadata ? { frameMetadata } : {}),
  };
}

function normalizeCharacter(value: unknown, usedIds: Set<string>): StoryboardCharacter | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()
    || typeof value.visualDescription !== "string") return null;
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.flatMap((alias) =>
      typeof alias === "string" && alias.trim() && alias.length <= 120 ? [alias.trim()] : [])
      .slice(0, 20)
    : [];
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.flatMap((excerpt) =>
      typeof excerpt === "string" && excerpt.trim() && excerpt.length <= 1000 ? [excerpt.trim()] : [])
      .slice(0, 12)
    : [];
  const appearances: StoryboardCharacterAppearance[] = Array.isArray(value.appearances)
    ? value.appearances.flatMap((appearance) => {
      if (!isRecord(appearance) || typeof appearance.evidence !== "string"
        || !appearance.evidence.trim() || appearance.evidence.length > 1000
        || typeof appearance.sceneHeading !== "string") return [];
      const shotNumber = appearance.shotNumber === null
        ? null
        : typeof appearance.shotNumber === "number" && Number.isInteger(appearance.shotNumber)
          && appearance.shotNumber >= 1 && appearance.shotNumber <= 120
          ? appearance.shotNumber
          : null;
      return [{
        shotNumber,
        sceneHeading: appearance.sceneHeading.slice(0, 300),
        evidence: appearance.evidence.trim(),
      }];
    }).slice(0, 120)
    : [];
  const referenceImageMediaAssetId = typeof value.referenceImageMediaAssetId === "string"
    && value.referenceImageMediaAssetId.trim()
    ? value.referenceImageMediaAssetId.trim()
    : "";
  const referenceImageSource = value.referenceImageSource === "uploaded" || value.referenceImageSource === "generated"
    ? value.referenceImageSource
    : undefined;
  const referenceImageModel = typeof value.referenceImageModel === "string" && value.referenceImageModel.trim()
    ? value.referenceImageModel.trim().slice(0, 200)
    : undefined;
  return {
    id: addUniqueId(value.id, usedIds),
    name: value.name.trim().slice(0, 120),
    aliases,
    visualDescription: value.visualDescription.trim().slice(0, 3000),
    evidence,
    appearances,
    ...(referenceImageMediaAssetId ? {
      referenceImageMediaAssetId,
      referenceImageApproved: value.referenceImageApproved === true,
      ...(referenceImageSource ? { referenceImageSource } : {}),
      ...(referenceImageModel ? { referenceImageModel } : {}),
    } : {}),
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
  const extractedStyleBible = extractStoryboardStyleBible(scenes);
  const savedStyleBible = isRecord(value.styleBible) ? value.styleBible : {};
  const normalizeStyleBibleValue = (key: keyof StoryboardStyleBible) => isRecord(value.styleBible)
    && typeof savedStyleBible[key] === "string"
    ? savedStyleBible[key] as string
    : extractedStyleBible[key];
  const characters = Array.isArray(value.characters)
    ? value.characters.flatMap((character) => {
      const normalized = normalizeCharacter(character, usedIds);
      return normalized ? [normalized] : [];
    }).slice(0, 60)
    : [];
  return {
    version: 1,
    title: typeof value.title === "string" && value.title.trim() ? value.title : "Untitled storyboard",
    aspectRatio: typeof value.aspectRatio === "string"
      && STORYBOARD_ASPECT_RATIOS.includes(value.aspectRatio as StoryboardAspectRatio)
      ? value.aspectRatio as StoryboardAspectRatio
      : "16:9",
    styleBible: {
      visualStyle: normalizeStyleBibleValue("visualStyle"),
      recurringCharacter: normalizeStyleBibleValue("recurringCharacter"),
      recurringLocation: normalizeStyleBibleValue("recurringLocation"),
    },
    characters,
    scenes,
  };
}
