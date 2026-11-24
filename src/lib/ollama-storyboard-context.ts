import {
  extractStoryboardStyleBible,
  stripStoryboardContinuityBlocks,
  type StoryboardAspectRatio,
  type StoryboardData,
  type StoryboardStyleBible,
} from "./StoryboardData";

export const OLLAMA_STORYBOARD_CONTEXT_MAX_LENGTH = 40_000;
export const OLLAMA_STORYBOARD_PROMPT_MAX_LENGTH = 10_000;

export type OllamaStoryboardShot = {
  id: string;
  number: number;
  sceneId: string;
  sceneTitle: string;
  title: string;
  description: string;
  prompt: string;
  shotType: string;
  cameraMove: string;
  durationSeconds: number | null;
  notes: string;
};

export type OllamaStoryboardContext = {
  workflowId: string;
  scopeId: string;
  aspectRatio: StoryboardAspectRatio;
  styleBible: StoryboardStyleBible;
  text: string;
  shots: OllamaStoryboardShot[];
  tooLong: boolean;
};

export function formatOllamaStoryboardPromptContext(
  context: OllamaStoryboardContext,
  shot: OllamaStoryboardShot,
) {
  const description = stripStoryboardContinuityBlocks(shot.description);
  const bible = [
    context.styleBible.visualStyle ? `Visual style: ${context.styleBible.visualStyle}` : "",
    context.styleBible.recurringCharacter ? `Recurring character: ${context.styleBible.recurringCharacter}` : "",
    context.styleBible.recurringLocation ? `Recurring location: ${context.styleBible.recurringLocation}` : "",
  ].filter(Boolean);
  const text = [
    `STORYBOARD ASPECT RATIO: ${context.aspectRatio}`,
    "GLOBAL STYLE BIBLE (reference only; use details only when visible in this shot):",
    bible.length ? bible.join("\n") : "No additional style or continuity notes.",
    `REQUESTED SHOT ${String(shot.number).padStart(2, "0")}:`,
    `SHOT TYPE: ${shot.shotType || "Not specified"}`,
    `DESCRIPTION: ${description || "(empty)"}`,
  ].join("\n");
  return {
    text,
    tooLong: text.length > OLLAMA_STORYBOARD_CONTEXT_MAX_LENGTH,
  };
}

export const STORYBOARD_PROMPT_OPENINGS: Record<StoryboardAspectRatio, string> = {
  "16:9": "A painterly 3D sci-fi render, 16:9 widescreen,",
  "9:16": "A painterly 3D sci-fi render, 9:16 portrait,",
  "1:1": "A painterly 3D sci-fi render, 1:1 square,",
  "4:3": "A painterly 3D sci-fi render, 4:3 aspect ratio,",
  "21:9": "A painterly 3D sci-fi render, 21:9 ultrawide,",
};

export function normalizeOllamaStoryboardPrompt(
  response: string,
  aspectRatio: StoryboardAspectRatio,
): string {
  const prompt = response.trim()
    .replace(/^(?:(?:here(?:'s| is)(?: the| your)?(?: final)? prompt|final prompt|prompt)\s*[:\-]\s*|sure[,!:]\s*)/i, "")
    .trim();
  const opening = STORYBOARD_PROMPT_OPENINGS[aspectRatio];
  if (prompt.startsWith(opening)) return prompt;

  const styledOpening = /^A painterly 3D sci-fi (?:render|illustration),\s*[^,]{1,60},\s*/i;
  const match = prompt.match(styledOpening);
  if (match) return `${opening} ${prompt.slice(match[0].length)}`.trim();
  return `${opening} ${prompt}`.trim();
}

export function validateOllamaStoryboardPrompt(
  response: string,
  aspectRatio: StoryboardAspectRatio,
): string | null {
  const prompt = response.trim();
  const wordCount = prompt ? prompt.split(/\s+/).length : 0;
  if (!prompt.startsWith(STORYBOARD_PROMPT_OPENINGS[aspectRatio])) {
    return `The prompt must start with "${STORYBOARD_PROMPT_OPENINGS[aspectRatio]}"`;
  }
  if (/[\r\n]/.test(prompt)
    || /[{}|]/.test(prompt)
    || /```|`|^\s*(?:#{1,6}\s|[-*]\s)|(?:\*\*|__|\[[^\]]+\]\()/.test(prompt)) {
    return "The prompt must be a single paragraph with no Markdown.";
  }
  if (wordCount < 90 || wordCount > 150) {
    return "The prompt must contain 90-150 words.";
  }
  if (/\banimat(?:ion|ed)\b/i.test(prompt)) {
    return "The prompt must use render or illustration, not animation or animated.";
  }
  if (/\bshot\s*#?\s*\d+\b|\b(?:INT|EXT)\.(?:\s|$)/i.test(prompt)) {
    return "The prompt must not include shot numbers or scene headings.";
  }
  return null;
}

export function createOllamaStoryboardContext(
  storyboard: StoryboardData,
  workflowId: string,
  scopeId: string,
): OllamaStoryboardContext {
  const shots = storyboard.scenes.flatMap((scene) => scene.shots.map((shot) => ({
    id: shot.id,
    sceneId: scene.id,
    sceneTitle: scene.title,
    title: shot.title,
    description: shot.description,
    prompt: typeof shot.prompt === "string" ? shot.prompt : "",
    shotType: shot.shotType,
    cameraMove: shot.cameraMove,
    durationSeconds: shot.durationSeconds,
    notes: shot.notes,
  }))).map((shot, index) => ({ ...shot, number: index + 1 }));
  const text = JSON.stringify({
    title: storyboard.title,
    aspectRatio: storyboard.aspectRatio,
    shots: shots.map((shot) => ({
      shot: `Shot ${String(shot.number).padStart(2, "0")}`,
      scene: shot.sceneTitle,
      title: shot.title,
      description: shot.description,
      prompt: shot.prompt,
      shotType: shot.shotType,
      cameraMove: shot.cameraMove,
      durationSeconds: shot.durationSeconds,
      notes: shot.notes,
    })),
  });
  return {
    workflowId,
    scopeId,
    aspectRatio: storyboard.aspectRatio,
    styleBible: storyboard.styleBible ?? extractStoryboardStyleBible(storyboard.scenes),
    text,
    shots,
    tooLong: text.length > OLLAMA_STORYBOARD_CONTEXT_MAX_LENGTH,
  };
}

export function resolveOllamaStoryboardShot(
  request: string,
  shots: OllamaStoryboardShot[],
): OllamaStoryboardShot | null {
  const numbers = Array.from(request.matchAll(/\bshot\s*#?\s*0*(\d+)\b/gi), (match) => Number(match[1]));
  const uniqueNumbers = new Set(numbers);
  if (uniqueNumbers.size !== 1) return null;
  return shots.find((shot) => shot.number === numbers[0]) ?? null;
}

export function extractOllamaStoryboardPrompt(response: string): string | null {
  const blocks = Array.from(response.matchAll(/```shot-prompt\s*\r?\n([\s\S]*?)```/gi));
  if (blocks.length !== 1) return null;
  const prompt = blocks[0][1].trim();
  return prompt && prompt.length <= OLLAMA_STORYBOARD_PROMPT_MAX_LENGTH ? prompt : null;
}
