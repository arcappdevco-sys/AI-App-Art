import { WAN_MODELS, WAN_NODE_TYPE } from "./wan";
import { MINIMAX_MODELS, MINIMAX_NODE_TYPE } from "./minimax";
import { FLUX3_NODE_TYPE } from "./flux3";
import { FLUX3_VIDEO_NODE_TYPE } from "./flux3-video";
import { KLING_MODELS } from "./kling";
import { SEEDANCE_MODELS } from "./seedance";
import { VEO_MODELS } from "./veo";
import { OMNI_MODELS } from "./omni";

type Fact<T> = { value: T; verified: boolean };
type Profile = {
  label: string;
  medium: "image" | "video";
  models?: Record<string, string>;
  maxPromptChars?: Fact<number>;
  nonEnglishMaxPromptChars?: Fact<number>;
  nativeAudio?: Fact<boolean>;
  hasNegativePromptField?: Fact<boolean>;
  referenceTagSyntax?: Fact<string | null>;
  promptRequired?: Record<string, Fact<boolean>>;
  notes?: Fact<string>[];
  variants?: Record<string, Partial<Profile>>;
  tasks?: Record<string, Partial<Profile>>;
};

const modelNames = (models: Record<string, string>) =>
  Object.fromEntries(Object.entries(models).map(([label, value]) => [value, label]));
const verified = <T>(value: T): Fact<T> => ({ value, verified: true });
const unverified = <T>(value: T): Fact<T> => ({ value, verified: false });

export const PROMPT_ASSISTANT_PROFILES: Record<string, Profile> = {
  [WAN_NODE_TYPE]: {
    label: "Wan 3.0", medium: "video", models: modelNames(WAN_MODELS),
    // The limit is enforced in wan.ts.
    maxPromptChars: verified(20000), nativeAudio: verified(true), hasNegativePromptField: verified(false),
    referenceTagSyntax: verified(null),
    promptRequired: { "text-to-video": verified(true), "image-to-video": verified(true), "reference-to-video": verified(true) },
    notes: [verified("Describe references by role and connected order. Do not put seed values in the prompt."),
      verified("Document or webpage inputs require deep thinking.")],
  },
  [MINIMAX_NODE_TYPE]: {
    label: "MiniMax H3", medium: "video", models: modelNames(MINIMAX_MODELS),
    nativeAudio: verified(true), hasNegativePromptField: verified(false), referenceTagSyntax: verified(null),
    promptRequired: { "text-to-video": verified(true), "image-to-video": verified(true), "reference-to-video": verified(true) },
    notes: [verified("Reference-to-video needs at least one image or video reference.")],
  },
  [FLUX3_NODE_TYPE]: {
    label: "FLUX 3 Image", medium: "image", hasNegativePromptField: verified(false),
    notes: [verified("Describe the subject first, then requested action, setting, composition and style. Quote exact text to render.")],
    tasks: { edit: { notes: [verified("Keep edits short and direct; refer to inputs as image 1, image 2 in connected order.")] } },
  },
  [FLUX3_VIDEO_NODE_TYPE]: {
    label: "FLUX 3 Video", medium: "video",
    // Prompt requirements are defined in flux3-video.ts.
    promptRequired: { "text-to-video": verified(true), "edit-video": verified(true) },
  },
  "fal/nano-banana": { label: "Nano Banana", medium: "image" },
  "google/gemini-image": { label: "Nano Banana", medium: "image" },
  "openai/gpt-image": { label: "ChatGPT Image", medium: "image" },
  "video/seedance": {
    label: "Seedance", medium: "video", models: modelNames(SEEDANCE_MODELS),
    // seedance.ts requires a prompt for the supported text task.
    promptRequired: { "text-to-video": verified(true) },
    tasks: {
      "text-to-video": { notes: [verified("Describe subject, action, camera, environment, lighting and style when requested.")] },
      "image-to-video": { notes: [verified("Describe motion grounded in the first frame; the optional last frame constrains the ending.")] },
    },
  },
  "video/veo": {
    label: "Veo", medium: "video", models: modelNames(VEO_MODELS),
    // veo.ts requires a prompt.
    promptRequired: { "text-to-video": verified(true), "image-to-video": verified(true), "reference-to-video": verified(true) },
    tasks: {
      "image-to-video": { notes: [verified("Describe requested motion grounded in the first frame.")] },
      "reference-to-video": { notes: [verified("Describe the requested action using the connected references.")] },
    },
  },
  "video/google-omni": {
    label: "Gemini Omni", medium: "video", models: modelNames(OMNI_MODELS),
    // The limit is enforced in omni.ts.
    maxPromptChars: verified(20000),
    tasks: { "image-to-video": { notes: [verified("Describe requested motion grounded in the connected frame.")] } },
  },
  "video/kling": {
    label: "Kling", medium: "video", models: modelNames(KLING_MODELS),
    variants: {
      [KLING_MODELS["Kling 4.0"]]: {
        // kling.ts enforces these limits, including for non-ASCII text.
        maxPromptChars: verified(26000), nonEnglishMaxPromptChars: unverified(11000),
        nativeAudio: verified(true), hasNegativePromptField: verified(false),
        referenceTagSyntax: unverified("@image_N, @video_N, @element_N, @voice_N"),
        notes: [unverified("In Ingredients, connected references may be used automatically when not mentioned.")],
      },
      [KLING_MODELS["Kling V3.0 Pro"]]: {
        // kling.ts enforces this limit; Atlas Pro documentation says no negative_prompt field.
        maxPromptChars: verified(2500), hasNegativePromptField: verified(false),
        notes: [verified("Audio is controlled by the sound toggle.")],
      },
      [KLING_MODELS["Kling V3.0 Std"]]: {
        // kling.ts enforces this limit; Atlas Std documentation says no negative_prompt field.
        maxPromptChars: verified(2500), hasNegativePromptField: verified(false),
        notes: [verified("Audio is controlled by the sound toggle.")],
      },
      [KLING_MODELS["Kling 2.6 Pro Motion Control"]]: {
        // Motion-control prompt limit in kling.ts.
        maxPromptChars: verified(2500),
      },
    },
    promptRequired: { "text-to-video": verified(true), "image-to-video": verified(false),
      "reference-to-video": verified(true), "video-edit": verified(true), "motion-control": verified(false) },
  },
};

export type PromptAssistantConnectedTarget = {
  type: string;
  model: string;
  task: string;
  promptExpansion: boolean;
};

type GraphNode = { id: string; data: Record<string, unknown> };
type GraphEdge = { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null };

export function findPromptAssistantTargets(id: string, nodes: GraphNode[], edges: GraphEdge[]): PromptAssistantConnectedTarget[] {
  const targets = new Set(edges.filter((edge) => edge.source === id && edge.sourceHandle === "text"
    && edge.targetHandle === "prompt").map((edge) => edge.target));
  return nodes.flatMap((node) => {
    if (!targets.has(node.id) || typeof node.data.type !== "string") return [];
    const raw = node.data.params;
    const params = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return [{
      type: node.data.type,
      model: typeof params.model === "string" ? params.model : "",
      task: typeof params.task === "string" ? params.task : "",
      promptExpansion: params.prompt_expansion === true || params.enable_prompt_expansion === true,
    }];
  });
}

export function resolvePromptAssistantProfile(target: PromptAssistantConnectedTarget) {
  const base = PROMPT_ASSISTANT_PROFILES[target.type];
  if (!base) return null;
  const variant = base.variants?.[target.model];
  const task = variant?.tasks?.[target.task] ?? base.tasks?.[target.task];
  return {
    ...base, ...variant, ...task,
    notes: [...(base.notes ?? []), ...(variant?.notes ?? []), ...(task?.notes ?? [])],
    label: base.models?.[target.model] ?? base.label,
    promptRequired: variant?.promptRequired?.[target.task] ?? base.promptRequired?.[target.task],
  };
}

export function promptAssistantTargetContext(targets: PromptAssistantConnectedTarget[]) {
  const known = targets.flatMap((target) => {
    const profile = resolvePromptAssistantProfile(target);
    return profile ? [{ target, profile }] : [];
  });
  if (!known.length) return null;
  const limits = known.flatMap(({ profile }) => profile.maxPromptChars ? [profile.maxPromptChars.value] : []);
  const nonEnglishLimits = known.flatMap(({ profile }) => profile.nonEnglishMaxPromptChars ? [profile.nonEnglishMaxPromptChars.value] : []);
  const maxLength = limits.length ? Math.min(...limits) : null;
  const nonEnglishMaxLength = nonEnglishLimits.length ? Math.min(...nonEnglishLimits, ...(maxLength ? [maxLength] : [])) : maxLength;
  const lines = known.map(({ target, profile }) => {
    const notes = profile.notes.map((note) => `${note.verified ? "" : "Unverified: "}${note.value}`);
    const required = profile.promptRequired;
    return [
      `${profile.label} (${profile.medium}, task: ${target.task || "unknown"})`,
      required ? `Prompt ${required.value ? "required" : "optional"}${required.verified ? "" : " (unverified)"}.` : "",
      profile.nativeAudio ? `Native audio: ${profile.nativeAudio.value ? "yes" : "no"}${profile.nativeAudio.verified ? "" : " (unverified)"}.` : "",
      profile.hasNegativePromptField ? `Separate negative prompt field: ${profile.hasNegativePromptField.value ? "yes" : "no"}${profile.hasNegativePromptField.verified ? "" : " (unverified)"}.` : "",
      profile.referenceTagSyntax?.value ? `Unverified reference syntax: ${profile.referenceTagSyntax.value}.` : "",
      target.promptExpansion && [MINIMAX_NODE_TYPE, FLUX3_NODE_TYPE].includes(target.type)
        ? "Prompt expansion is enabled; avoid unnecessary verbosity." : "",
      ...notes,
    ].filter(Boolean).join(" ");
  });
  return {
    known, maxLength, nonEnglishMaxLength,
    instructions: [
      `Connected target models:\n${lines.join("\n")}`,
      targets.length > 1 ? "Use only guidance compatible with every target; do not introduce model-specific reference syntax." : "",
      targets.length > known.length ? "Some connected targets are unknown; avoid assuming their special syntax or limits." : "",
      maxLength ? `The final prompt must be at most ${maxLength} characters.` : "",
      nonEnglishLimits.length ? `For non-ASCII text, the app enforces a ${nonEnglishMaxLength}-character limit (provider limit unverified).` : "",
      "Preserve the user's intent, subject, language and all existing reference tags exactly. Never invent reference tags or unrequested details.",
      known.some(({ profile }) => profile.hasNegativePromptField?.value)
        ? "Do not put avoidances in the prompt; mention the separate negative-prompt field in the notice."
        : known.length === targets.length && known.every(({ profile }) => profile.hasNegativePromptField?.value === false)
          ? "When the user requests avoidances, express them in the prompt in plain language."
          : "Preserve requested avoidances without assuming an unknown target has a separate negative-prompt field.",
    ].filter(Boolean).join("\n"),
  };
}
