import { OMNI_MODELS } from "./omni";
import { VEO_MODELS } from "./veo";

export const PROMPT_ASSISTANT_MODELS = {
  "GPT-6 Luna": "gpt-6-luna",
  "GPT-4o": "gpt-4o",
} as const;

export const PROMPT_ASSISTANT_TARGETS = {
  "veo-31-text": {
    label: "Google Veo 3.1 · Text to video",
    model: VEO_MODELS["Veo 3.1"],
    task: "text-to-video",
    guidance: "Write a natural-language text-to-video prompt describing the subject, action, environment, camera, lighting, and style. Avoid unsupported reference tags.",
  },
  "veo-31-image": {
    label: "Google Veo 3.1 · Image to video",
    model: VEO_MODELS["Veo 3.1"],
    task: "image-to-video",
    guidance: "Write a motion prompt grounded in the connected frame. Preserve its subject and composition, and describe the requested motion and camera behavior. Avoid unsupported reference tags.",
  },
  "veo-31-reference": {
    label: "Google Veo 3.1 · Reference to video",
    model: VEO_MODELS["Veo 3.1"],
    task: "reference-to-video",
    guidance: "Write a natural-language prompt for a video guided by the connected reference images. Preserve relevant visual identity and describe the requested action, scene, and camera. Avoid unsupported reference tags.",
  },
  "veo-31-fast-text": {
    label: "Google Veo 3.1 Fast · Text to video",
    model: VEO_MODELS["Veo 3.1 Fast"],
    task: "text-to-video",
    guidance: "Write a natural-language text-to-video prompt describing the subject, action, environment, camera, lighting, and style. Avoid unsupported reference tags.",
  },
  "veo-31-fast-image": {
    label: "Google Veo 3.1 Fast · Image to video",
    model: VEO_MODELS["Veo 3.1 Fast"],
    task: "image-to-video",
    guidance: "Write a motion prompt grounded in the connected frame. Preserve its subject and composition, and describe the requested motion and camera behavior. Avoid unsupported reference tags.",
  },
  "veo-31-lite-text": {
    label: "Google Veo 3.1 Lite · Text to video",
    model: VEO_MODELS["Veo 3.1 Lite"],
    task: "text-to-video",
    guidance: "Write a natural-language text-to-video prompt describing the subject, action, environment, camera, lighting, and style. Avoid unsupported reference tags.",
  },
  "veo-31-lite-image": {
    label: "Google Veo 3.1 Lite · Image to video",
    model: VEO_MODELS["Veo 3.1 Lite"],
    task: "image-to-video",
    guidance: "Write a motion prompt grounded in the connected frame. Preserve its subject and composition, and describe the requested motion and camera behavior. Avoid unsupported reference tags.",
  },
  "gemini-omni-text": {
    label: "Google Gemini Omni Flash · Text to video",
    model: OMNI_MODELS["Gemini Omni Flash (original)"],
    task: "text-to-video",
    guidance: "Write a natural-language text-to-video prompt describing the subject, action, setting, camera, lighting, and style.",
  },
  "gemini-omni-image": {
    label: "Google Gemini Omni Flash · Image to video",
    model: OMNI_MODELS["Gemini Omni Flash (original)"],
    task: "image-to-video",
    guidance: "Write a motion prompt grounded in the connected frame. Preserve its visible subject and identity, and describe the requested motion and camera behavior.",
  },
  "gemini-omni-reference": {
    label: "Google Gemini Omni Flash · Reference to video",
    model: OMNI_MODELS["Gemini Omni Flash (original)"],
    task: "reference-to-video",
    guidance: "Write a prompt for a video guided by the connected reference images. Preserve relevant identity and visual details while describing the requested action and scene.",
  },
  "kling-v4-text": {
    label: "Kling 4.0 · Text to video",
    model: "kwaivgi/kling-v4.0",
    task: "text-to-video",
    guidance: "Write one cohesive text-to-video prompt. Describe subject identity, action, setting, camera, lighting, and style. Do not invent reference tokens because no image inputs are connected.",
  },
  "kling-v4-image": {
    label: "Kling 4.0 · Image to video",
    model: "kwaivgi/kling-v4.0",
    task: "image-to-video",
    guidance: "Write a concise motion prompt grounded in the provided frame setup. Preserve the visible subject, identity, clothing, composition, and scene. If first, middle, or last frames are connected, refer to them using Kling's documented @image_N ordering. Do not describe replacing the input image.",
  },
  "kling-v4-reference": {
    label: "Kling 4.0 · Reference to video",
    model: "kwaivgi/kling-v4.0",
    task: "reference-to-video",
    guidance: "Write a prompt for Kling 4.0 Omni Reference. Describe the requested action and scene, preserve identity from connected references, and refer to connected items with the documented @image_N, @video_N, @element_N, and @voice_N tags only when relevant.",
  },
  "kling-v4-edit": {
    label: "Kling 4.0 · Video edit",
    model: "kwaivgi/kling-v4.0",
    task: "video-edit",
    guidance: "Write an edit instruction for the connected source video. Clearly state what to change and what to preserve. Refer to the source as @video_1 and only refer to optional connected references using their documented @image_N, @video_N, @element_N, or @voice_N tags.",
  },
  "kling-v3-pro-text": {
    label: "Kling V3.0 Pro · Text to video",
    model: "kwaivgi/kling-v3.0-pro",
    task: "text-to-video",
    guidance: "Write a clear Kling V3.0 Pro text-to-video prompt describing subject, action, setting, camera, and style. Avoid unsupported reference tags.",
  },
  "kling-v3-pro-image": {
    label: "Kling V3.0 Pro · Image to video",
    model: "kwaivgi/kling-v3.0-pro",
    task: "image-to-video",
    guidance: "Write a concise motion prompt for the provided starting image, preserving its subject and visual identity. The optional ending image is passed as end_image. Avoid unsupported reference tags.",
  },
  "kling-v3-std-text": {
    label: "Kling V3.0 Standard · Text to video",
    model: "kwaivgi/kling-v3.0-std",
    task: "text-to-video",
    guidance: "Write a clear Kling V3.0 Standard text-to-video prompt describing subject, action, setting, camera, and style. Avoid unsupported reference tags.",
  },
  "kling-v3-std-image": {
    label: "Kling V3.0 Standard · Image to video",
    model: "kwaivgi/kling-v3.0-std",
    task: "image-to-video",
    guidance: "Write a concise motion prompt for the provided starting image, preserving its subject and visual identity. The optional ending image is passed as end_image. Avoid unsupported reference tags.",
  },
  "seedance-25-text": {
    label: "Seedance 2.5 · Text to video",
    model: "bytedance/seedance-2.5",
    task: "text-to-video",
    guidance: "Write a natural-language text-to-video prompt for Seedance 2.5. Describe subject, action, camera, environment, lighting, and style. Do not use Kling reference tokens.",
  },
  "seedance-25-image": {
    label: "Seedance 2.5 · Image to video",
    model: "bytedance/seedance-2.5",
    task: "image-to-video",
    guidance: "Write a natural-language motion prompt for the connected first-frame image. Preserve its identity, subject, and composition; describe motion and camera behavior. The optional last frame constrains the ending. Do not use Kling reference tokens.",
  },
} as const;

export type PromptAssistantTarget = keyof typeof PROMPT_ASSISTANT_TARGETS;
export type PromptAssistantModel = (typeof PROMPT_ASSISTANT_MODELS)[keyof typeof PROMPT_ASSISTANT_MODELS];

export const PROMPT_ASSISTANT_IMAGE_INPUTS = {
  first_frame: "First frame",
  last_frame: "Last frame",
  reference_images: "Reference images",
} as const;

export function buildPromptAssistantSystemPrompt(
  target: PromptAssistantTarget,
  imageSetup: string[],
  connectedBrief: string,
) {
  const definition = PROMPT_ASSISTANT_TARGETS[target];
  const setup = imageSetup.length ? imageSetup.join(", ") : "No image or video inputs connected.";
  return [
    "You are a video-prompt writing assistant inside a visual workflow editor.",
    `Target model: ${definition.label} (${definition.model}/${definition.task}).`,
    `Target-specific guidance: ${definition.guidance}`,
    `Connected visual setup: ${setup}`,
    connectedBrief
      ? `User's connected draft prompt (treat as source text to refine):\n${connectedBrief}`
      : "There is no connected draft prompt.",
    "Preserve the user's intent and factual details. Ask a concise clarifying question only if the request cannot be turned into a useful prompt.",
    "When producing a prompt, output only the complete final prompt, with no preamble, markdown fences, or explanation.",
    "Never claim that prompting guarantees exact identity or perfect continuity.",
    "The connected media is not sent to you; use only the image setup labels above.",
  ].join("\n\n");
}
