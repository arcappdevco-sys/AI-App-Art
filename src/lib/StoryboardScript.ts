import {
  STORYBOARD_CAMERA_MOVES,
  STORYBOARD_SHOT_TYPES,
  type StoryboardCameraMove,
  type StoryboardScene,
  type StoryboardShot,
  type StoryboardStyleBible,
  type StoryboardShotType,
  extractStoryboardStyleBible,
} from "./StoryboardData";

export const STORYBOARD_SCRIPT_MAX_SCENES = 30;
export const STORYBOARD_SCRIPT_MAX_SHOTS_PER_SCENE = 12;

export type GeneratedStoryboardScene = StoryboardScene;
export type StoryboardScriptResult = {
  scenes: GeneratedStoryboardScene[];
  styleBible: StoryboardStyleBible;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function matchingOption<T extends string>(value: unknown, options: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === normalized) ?? null;
}

function isValidDuration(value: number) {
  return Number.isFinite(value) && value >= 0.5 && value <= 60 && Number.isInteger(value * 2);
}

function parseDuration(value: unknown) {
  if (typeof value === "number") return isValidDuration(value) ? value : null;
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:s|sec(?:ond)?s?)?\s*$/i.exec(value)
    ?? /\b(?:duration\s*[:=]?\s*|for\s+|lasting\s+)(\d+(?:\.\d+)?)\s*(?:s|sec(?:ond)?s?)\b/i.exec(value);
  if (!match) return null;
  const duration = Number(match[1]);
  return isValidDuration(duration) ? duration : null;
}

function inferShotType(text: string): StoryboardShotType {
  const value = text.toLowerCase();
  if (/\btitle card\b|\bintertitle\b|\btitle text\b/.test(value)) return "Title card";
  if (/\b(extreme close[- ]?up|macro shot)\b/.test(value)) return "Extreme close-up";
  if (/\b(close[- ]?up|insert shot|detail shot)\b/.test(value)) return "Close-up";
  if (/\b(over[- ]the[- ]shoulder|ots shot)\b/.test(value)) return "Over the shoulder";
  if (/\b(point[- ]of[- ]view|\bpov\b|first[- ]person view)\b/.test(value)) return "POV";
  if (/\b(aerial|bird['’]s[- ]eye|drone shot|overhead shot)\b/.test(value)) return "Aerial";
  if (/\b(low[- ]angle|worm['’]s[- ]eye)\b/.test(value)) return "Low angle";
  if (/\b(high[- ]angle|top[- ]down angle)\b/.test(value)) return "High angle";
  if (/\bmedium(?:[- ]wide)? shot\b|\btwo[- ]shot\b/.test(value)) return "Medium";
  if (/\b(extreme wide|establishing shot|panoramic shot|long shot)\b/.test(value)) return "Extreme wide";
  if (/\bwide(?:[- ]angle)? shot\b/.test(value)) return "Wide";
  return "Wide";
}

function inferCameraMove(text: string): StoryboardCameraMove {
  const value = text.toLowerCase();
  if (/\bdolly(?:ing)?\s+in\b|\bpush(?:es|ing)?\s+in\b/.test(value)) return "Dolly in";
  if (/\bdolly(?:ing)?\s+out\b|\bpull(?:s|ing)?\s+back\b/.test(value)) return "Dolly out";
  if (/\bzoom(?:s|ing)?\s+in\b/.test(value)) return "Zoom in";
  if (/\bzoom(?:s|ing)?\s+out\b/.test(value)) return "Zoom out";
  if (/\btrack(?:s|ing)?\b|\bfollow(?:s|ing)?\s+(?:the|a|an|unit|character)\b/.test(value)) return "Tracking";
  if (/\borbit(?:s|ing)?\b/.test(value)) return "Orbit";
  if (/\bcrane(?:s|ing)?\b|\bjib(?:s|bing)?\b/.test(value)) return "Crane";
  if (/\bhandheld\b|\bshaky camera\b/.test(value)) return "Handheld";
  if (/\bpan(?:s|ning)?\b/.test(value)) return "Pan";
  if (/\btilt(?:s|ing)?\b/.test(value)) return "Tilt";
  return "Static";
}

function normalizeShot(value: unknown): StoryboardShot | null {
  if (!isRecord(value)) return null;
  const title = safeText(value.title, 160);
  const description = safeText(value.description, 4000);
  const shotTypeText = typeof value.shotType === "string" ? value.shotType : "";
  const cameraMoveText = typeof value.cameraMove === "string" ? value.cameraMove : "";
  const inferenceText = `${title}\n${description}\n${shotTypeText}\n${cameraMoveText}`;
  const durationSeconds = parseDuration(value.durationSeconds)
    ?? parseDuration(description)
    ?? 6;
  return {
    id: crypto.randomUUID(),
    title,
    description,
    prompt: "",
    shotType: matchingOption(shotTypeText, STORYBOARD_SHOT_TYPES) ?? inferShotType(inferenceText),
    cameraMove: matchingOption(cameraMoveText, STORYBOARD_CAMERA_MOVES) ?? inferCameraMove(inferenceText),
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
  const extractedStyleBible = extractStoryboardStyleBible(scenes);
  const rawStyleBible = isRecord(value.styleBible) ? value.styleBible : {};
  return {
    scenes,
    styleBible: {
      visualStyle: typeof rawStyleBible.visualStyle === "string"
        ? safeText(rawStyleBible.visualStyle, 8000) : extractedStyleBible.visualStyle,
      recurringCharacter: typeof rawStyleBible.recurringCharacter === "string"
        ? safeText(rawStyleBible.recurringCharacter, 8000) : extractedStyleBible.recurringCharacter,
      recurringLocation: typeof rawStyleBible.recurringLocation === "string"
        ? safeText(rawStyleBible.recurringLocation, 8000) : extractedStyleBible.recurringLocation,
    },
  };
}

type ParsedShotHeader = {
  lineIndex: number;
  number: string;
  heading: string;
  durationSeconds: number | null;
};

function readShotFields(lines: string[]) {
  const fields = new Map<string, string[]>();
  let activeField = "";
  for (const line of lines) {
    const label = /^\s*(?:[-*]\s*)?\*{0,2}(VISUAL|AUDIO|SHOT TYPE|CAMERA MOVEMENT|DURATION)\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i.exec(line);
    if (label) {
      activeField = label[1].trim().toUpperCase();
      fields.set(activeField, [label[2].trim()]);
    } else if (activeField) {
      fields.get(activeField)?.push(line.trim());
    }
  }
  return new Map([...fields].map(([key, value]) => [key, value.join("\n").trim()]));
}

function readScriptField(lines: string[], label: string) {
  for (const line of lines) {
    const match = /^\s*(?:#{1,6}\s*)?\*{0,2}([A-Z][A-Z ]*?)\*{0,2}\s*:\s*\*{0,2}(.*)$/i.exec(line);
    if (match?.[1].trim().toUpperCase() === label.toUpperCase()) return match[2].trim();
  }
  return "";
}

function readScriptSection(lines: string[], label: string) {
  for (let start = 0; start < lines.length; start += 1) {
    const heading = /^\s*#{1,6}\s*\*{0,2}([A-Z][A-Z ]*?)\*{0,2}(?:\s*:\s*(.*))?\s*$/i.exec(lines[start]);
    if (heading?.[1].trim().toUpperCase() !== label.toUpperCase()) continue;
    const section = [heading[2]?.trim() ?? ""];
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\s*#{1,6}\s+/.test(lines[index])) break;
      section.push(lines[index].trim());
    }
    return section.join("\n").trim();
  }
  return "";
}

export function parseStructuredStoryboardScript(script: string): StoryboardScriptResult | null {
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  const headerPattern = /^\s*(?:#{1,6}\s*)?SHOT\s+(\d{1,3})\s*\|\s*(.+?)\s*\|\s*DURATION\s*:\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?\s*$/i;
  const headerWithoutDurationPattern = /^\s*(?:#{1,6}\s*)?SHOT\s+(\d{1,3})\s*\|\s*(.+?)\s*$/i;
  const shotHeaders: ParsedShotHeader[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/^\s*(?:#{1,6}\s*)?SHOT\s+\d+\b/i.test(lines[lineIndex])) continue;
    const durationMatch = headerPattern.exec(lines[lineIndex]);
    if (!durationMatch && /\|\s*DURATION\s*:/i.test(lines[lineIndex])) return null;
    const match = durationMatch ?? headerWithoutDurationPattern.exec(lines[lineIndex]);
    if (!match) return null;
    const durationSeconds = durationMatch ? Number(durationMatch[3]) : null;
    if (durationSeconds !== null && !isValidDuration(durationSeconds)) return null;
    shotHeaders.push({
      lineIndex,
      number: match[1],
      heading: match[2].trim(),
      durationSeconds,
    });
  }

  if (shotHeaders.length === 0 || shotHeaders.length > 120) return null;

  const preamble = lines.slice(0, shotHeaders[0].lineIndex);
  const visualStyle = readScriptField(preamble, "VISUAL STYLE");
  const characterContinuity = readScriptField(preamble, "RECURRING CHARACTER")
    || readScriptSection(preamble, "CHARACTER BIBLE");
  const locationContinuity = readScriptField(preamble, "RECURRING LOCATION")
    || readScriptSection(preamble, "LOCATION BIBLE");
  const sceneDrafts: Array<{ title: string; shots: Record<string, unknown>[] }> = [];

  for (let index = 0; index < shotHeaders.length; index += 1) {
    const header = shotHeaders[index];
    const nextHeader = shotHeaders[index + 1];
    const fields = readShotFields(lines.slice(header.lineIndex + 1, nextHeader?.lineIndex));
    const visual = fields.get("VISUAL") ?? "";
    if (!visual) return null;
    const description = visual;
    const notes = fields.get("AUDIO") ?? "";
    const previousScene = sceneDrafts.at(-1);
    const headingKey = header.heading.replace(/\s+/g, " ").toUpperCase();
    const previousHeadingKey = previousScene?.title.replace(/\s+/g, " ").toUpperCase();
    const scene = previousScene && previousHeadingKey === headingKey
      && previousScene.shots.length < STORYBOARD_SCRIPT_MAX_SHOTS_PER_SCENE
      ? previousScene
      : { title: header.heading, shots: [] };
    if (scene !== previousScene) sceneDrafts.push(scene);
    scene.shots.push({
      title: `Shot ${header.number}`,
      description,
      shotType: fields.get("SHOT TYPE") ?? "",
      cameraMove: fields.get("CAMERA MOVEMENT") ?? "",
      durationSeconds: header.durationSeconds ?? parseDuration(fields.get("DURATION")) ?? null,
      notes,
    });
  }

  if (sceneDrafts.length === 0 || sceneDrafts.length > STORYBOARD_SCRIPT_MAX_SCENES
    || sceneDrafts.some((scene) => scene.shots.length === 0)) return null;

  const normalized = normalizeGeneratedStoryboard({ scenes: sceneDrafts });
  return {
    ...normalized,
    styleBible: {
      visualStyle,
      recurringCharacter: characterContinuity,
      recurringLocation: locationContinuity,
    },
  };
}

export const STORYBOARD_SCRIPT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["styleBible", "scenes"],
  properties: {
    styleBible: {
      type: "object",
      additionalProperties: false,
      required: ["visualStyle", "recurringCharacter", "recurringLocation"],
      properties: {
        visualStyle: { type: "string" },
        recurringCharacter: { type: "string" },
        recurringLocation: { type: "string" },
      },
    },
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
                shotType: { type: "string", enum: STORYBOARD_SHOT_TYPES },
                cameraMove: { type: "string", enum: STORYBOARD_CAMERA_MOVES },
                durationSeconds: { type: "number" },
                notes: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;
