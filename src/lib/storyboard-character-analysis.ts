export const STORYBOARD_CHARACTER_ANALYSIS_MAX_CHARACTERS = 60;
export const STORYBOARD_CHARACTER_ANALYSIS_MAX_APPEARANCES = 120;

export type StoryboardCharacterAppearance = {
  shotNumber: number | null;
  sceneHeading: string;
  evidence: string;
};

export type StoryboardCharacterCandidate = {
  name: string;
  aliases: string[];
  visualDescription: string;
  evidence: string[];
  appearances: StoryboardCharacterAppearance[];
};

export type StoryboardCharacterNameHint = {
  name: string;
  evidence: string[];
};

const STORYBOARD_CHARACTER_HINT_MAX = 30;
const STORYBOARD_CHARACTER_HINT_EVIDENCE_MAX = 5;
const NON_CHARACTER_CUES = new Set([
  "audio",
  "camera",
  "camera movement",
  "characters",
  "cut to",
  "day",
  "duration",
  "ext",
  "extreme close up",
  "int",
  "int ext",
  "location",
  "morning",
  "night",
  "scene",
  "scene heading",
  "shot",
  "shot type",
  "visual",
  "visual style",
]);

export const STORYBOARD_CHARACTER_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["characters"],
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "aliases", "visualDescription", "evidence", "appearances"],
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          visualDescription: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          appearances: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["reference", "evidence"],
              properties: {
                reference: { type: "string" },
                evidence: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

function addCharacterNameHint(
  hints: Map<string, StoryboardCharacterNameHint>,
  name: string,
  evidence: string,
) {
  const cleanName = name.trim().replace(/\s+/g, " ");
  const sourceEvidence = evidence.trim();
  const nameIndex = sourceEvidence.toLocaleLowerCase().indexOf(cleanName.toLocaleLowerCase());
  const evidenceStart = sourceEvidence.length > 1000 && nameIndex >= 0
    ? Math.max(0, nameIndex - 450)
    : 0;
  const cleanEvidence = sourceEvidence.slice(evidenceStart, evidenceStart + 1000).trim();
  if (!cleanName || !cleanEvidence || NON_CHARACTER_CUES.has(cleanName.toLocaleLowerCase())) return;
  const key = cleanName.toLocaleLowerCase();
  const hint = hints.get(key);
  if (hint) {
    if (!hint.evidence.includes(cleanEvidence) && hint.evidence.length < STORYBOARD_CHARACTER_HINT_EVIDENCE_MAX) {
      hint.evidence.push(cleanEvidence);
    }
    return;
  }
  if (hints.size < STORYBOARD_CHARACTER_HINT_MAX) {
    hints.set(key, { name: cleanName, evidence: [cleanEvidence] });
  }
}

export function findStoryboardCharacterNameHints(script: string): StoryboardCharacterNameHint[] {
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  const hints = new Map<string, StoryboardCharacterNameHint>();
  const identifierPattern = /\b[\p{Lu}][\p{Lu}\p{N}]{0,15}(?:[-_][\p{Lu}\p{N}]{1,15})+\b/giu;
  const characterCuePattern = /^([\p{Lu}][\p{Lu}\p{N}'’._-]*(?:\s+[\p{Lu}][\p{Lu}\p{N}'’._-]*){0,2})(?:\s+\((?:V\.O\.|O\.S\.|CONT['’]?D|CONTINUED)\))?$/u;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    identifierPattern.lastIndex = 0;
    for (const match of line.matchAll(identifierPattern)) {
      const name = match[0];
      const prefix = name.split(/[-_]/, 1)[0].toLocaleLowerCase();
      if (prefix === "shot" || prefix === "scene") continue;
      addCharacterNameHint(hints, name, line);
    }

    const cue = characterCuePattern.exec(line);
    if (!cue) continue;
    const name = cue[1].trim();
    const normalizedName = name.toLocaleLowerCase();
    if (NON_CHARACTER_CUES.has(normalizedName) || /^(?:int|ext)\b/i.test(name)
      || /^(?:shot|scene)\s+\d+$/i.test(name)) continue;
    const followingLine = lines.slice(index + 1).find((candidate) => candidate.trim());
    if (!followingLine || /^\s*(?:#{1,6}\s*)?(?:shot\s+\d+|int\.|ext\.|visual\s*:|audio\s*:)/i.test(followingLine)) {
      continue;
    }
    addCharacterNameHint(hints, name, `${line}\n${followingLine.trim()}`);
  }

  return [...hints.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sourceContains(script: string, excerpt: string) {
  return normalizeText(script).includes(normalizeText(excerpt));
}

function readStringArray(value: unknown, maximumItems: number, maximumLength: number, field: string) {
  if (!Array.isArray(value) || value.length > maximumItems
    || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maximumLength)) {
    throw new Error(`Character analysis contains invalid ${field}.`);
  }
  return value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim());
}

function parseAppearance(value: unknown, script: string): StoryboardCharacterAppearance {
  if (!isRecord(value) || typeof value.reference !== "string" || !value.reference.trim()
    || value.reference.length > 300 || typeof value.evidence !== "string"
    || !value.evidence.trim() || value.evidence.length > 1000) {
    throw new Error("Character analysis contains an invalid appearance reference.");
  }
  if (!sourceContains(script, value.evidence)) {
    throw new Error("Character analysis included appearance evidence not found in the script.");
  }
  const reference = value.reference.trim();
  const shotMatch = /\bshot\s*#?\s*0*(\d+)\b/i.exec(reference);
  const shotNumber = shotMatch ? Number(shotMatch[1]) : null;
  if (shotNumber !== null && (shotNumber < 1 || shotNumber > STORYBOARD_CHARACTER_ANALYSIS_MAX_APPEARANCES)) {
    throw new Error("Character analysis contains an out-of-range shot reference.");
  }
  return {
    shotNumber,
    sceneHeading: shotMatch ? reference.replace(shotMatch[0], "").replace(/^[\s|:-]+|[\s|:-]+$/g, "").trim() : reference,
    evidence: value.evidence.trim(),
  };
}

export function normalizeStoryboardCharacterAnalysis(value: unknown, script: string) {
  if (!isRecord(value) || !Array.isArray(value.characters)
    || value.characters.length > STORYBOARD_CHARACTER_ANALYSIS_MAX_CHARACTERS) {
    throw new Error("Ollama returned an invalid character list.");
  }
  const characters: StoryboardCharacterCandidate[] = value.characters.map((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 120
      || typeof item.visualDescription !== "string" || item.visualDescription.length > 3000
      || !Array.isArray(item.appearances)
      || item.appearances.length > STORYBOARD_CHARACTER_ANALYSIS_MAX_APPEARANCES) {
      throw new Error("Character analysis contains an invalid character.");
    }
    const name = item.name.trim();
    if (!sourceContains(script, name)) {
      throw new Error(`Character "${name}" could not be verified in the script.`);
    }
    const aliases = readStringArray(item.aliases, 20, 120, "aliases");
    if (aliases.some((alias) => !sourceContains(script, alias))) {
      throw new Error(`Character "${name}" has an alias that could not be verified in the script.`);
    }
    const evidence = readStringArray(item.evidence, 12, 1000, "evidence");
    if (!evidence.length || evidence.some((excerpt) => !sourceContains(script, excerpt))) {
      throw new Error(`Character "${name}" has missing or unverified evidence.`);
    }
    return {
      name,
      aliases,
      visualDescription: item.visualDescription.trim(),
      evidence,
      appearances: item.appearances.map((appearance) => parseAppearance(appearance, script)),
    };
  });
  return { characters };
}
