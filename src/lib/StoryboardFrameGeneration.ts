import { getFlux3Prediction, submitFlux3Prediction } from "./flux3-api";
import {
  FLUX3_MODEL_PREFIX,
  FLUX3_RATIOS,
  buildFlux3Request,
} from "./flux3";
import { storyboardImageDataUrl } from "./StoryboardImages";
import {
  stripStoryboardContinuityBlocks,
  type StoryboardAspectRatio,
  type StoryboardScene,
  type StoryboardShot,
  type StoryboardStyleBible,
} from "./StoryboardData";

export const STORYBOARD_FRAME_MODELS = [
  { id: "gpt-image-2.6-sunburst", label: "GPT Image 2.6 · Sunburst", provider: "OpenAI" },
  { id: "gpt-image-2.6-flare", label: "GPT Image 2.6 · Flare", provider: "OpenAI" },
  { id: "gemini-2.5-flash-image", label: "Nano Banana · Gemini API", provider: "Google Gemini" },
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2 · Gemini API", provider: "Google Gemini" },
  { id: "fal-ai/nano-banana", label: "Nano Banana · fal", provider: "fal" },
  { id: "fal-ai/nano-banana-pro", label: "Nano Banana Pro · fal", provider: "fal" },
  { id: "fal-ai/nano-banana-2", label: "Nano Banana 2 · fal", provider: "fal" },
  { id: "google/nano-banana-2.1", label: "Nano Banana 2.1 · fal", provider: "fal" },
  { id: `${FLUX3_MODEL_PREFIX}text-to-image`, label: "FLUX 3 · Atlas Cloud", provider: "Atlas Cloud" },
] as const;

export type StoryboardFrameModelId = (typeof STORYBOARD_FRAME_MODELS)[number]["id"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(payload: unknown, fallback: string) {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : fallback;
}

function extractImageUrl(value: unknown): string | null {
  if (typeof value === "string" && /^https:\/\/\S+$/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractImageUrl(item);
      if (url) return url;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const key of ["url", "image", "images", "outputs", "output", "data"]) {
      const url = extractImageUrl(value[key]);
      if (url) return url;
    }
  }
  return null;
}

function aspectRatioForFlux3(aspectRatio: StoryboardAspectRatio) {
  return FLUX3_RATIOS.includes(aspectRatio as (typeof FLUX3_RATIOS)[number]) ? aspectRatio : "auto";
}

export function buildStoryboardFramePrompt(
  scene: StoryboardScene,
  shot: StoryboardShot,
  aspectRatio: StoryboardAspectRatio,
  styleBible?: StoryboardStyleBible,
) {
  const actionPrompt = shot.prompt?.trim() || stripStoryboardContinuityBlocks(shot.description);
  const sharedContinuity = [
    styleBible?.visualStyle ? `Visual style: ${styleBible.visualStyle}` : "",
    styleBible?.recurringCharacter ? `Recurring character: ${styleBible.recurringCharacter}` : "",
    styleBible?.recurringLocation ? `Recurring location: ${styleBible.recurringLocation}` : "",
  ].filter(Boolean);
  const details = [
    `Create one polished storyboard frame for ${aspectRatio} video.`,
    `Scene: ${scene.title.trim() || "Untitled scene"}.`,
    shot.title.trim() ? `Shot: ${shot.title.trim()}.` : "",
    actionPrompt ? `Action and composition: ${actionPrompt}` : "",
    sharedContinuity.length
      ? `Global style bible (apply only details visible in this shot): ${sharedContinuity.join(" ")}`
      : "",
    shot.shotType ? `Shot type: ${shot.shotType}.` : "",
    shot.cameraMove ? `Camera movement: ${shot.cameraMove}.` : "",
    "Cinematic, coherent with the described action, a single frame, no captions, lettering, panel borders, or storyboard labels.",
  ];
  const prompt = details.filter(Boolean).join(" ");
  if (prompt.length > 20000) throw new Error("Shot details are too long to use as an image prompt.");
  return prompt;
}

async function jsonPost(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseError(payload, `Image generation failed (${response.status}).`));
  return payload;
}

async function generateOpenAiImage(model: string, prompt: string, aspectRatio: StoryboardAspectRatio) {
  const size = aspectRatio === "1:1" ? "1024x1024"
    : aspectRatio === "9:16" ? "1024x1536"
      : "1536x1024";
  const result = await jsonPost("/api/openai/image", {
    model,
    prompt,
    size,
    quality: "medium",
    complexity: "high",
  });
  if (!isRecord(result) || typeof result.image !== "string" || !result.image.startsWith("data:image/")) {
    throw new Error("OpenAI did not return an image.");
  }
  return normalizeImageDataUrl(result.image);
}

async function generateGeminiImage(model: string, prompt: string, aspectRatio: StoryboardAspectRatio) {
  const result = await jsonPost("/api/gemini", {
    model,
    prompt,
    images: [],
    aspectRatio,
  });
  if (!isRecord(result) || typeof result.image !== "string" || !result.image.startsWith("data:image/")) {
    throw new Error("Gemini did not return an image.");
  }
  return normalizeImageDataUrl(result.image);
}

async function generateFalImage(model: string, prompt: string, aspectRatio: StoryboardAspectRatio) {
  const { fal } = await import("@fal-ai/client");
  fal.config({ proxyUrl: "/api/fal/proxy" });
  const result = await fal.subscribe(model, {
    input: { prompt, num_images: 1, aspect_ratio: aspectRatio },
  });
  const url = extractImageUrl(result.data);
  if (!url) throw new Error("fal did not return an image URL.");
  return downloadImage(url);
}

async function generateFlux3Image(prompt: string, aspectRatio: StoryboardAspectRatio) {
  const request = buildFlux3Request({
    params: {
      task: "text-to-image",
      model: `${FLUX3_MODEL_PREFIX}text-to-image`,
      aspect_ratio: aspectRatioForFlux3(aspectRatio),
      resolution: "1k",
      enable_prompt_expansion: false,
      output_format: "jpeg",
      safety_tolerance: 2,
    },
  }, { prompt });
  if (request.errors.length) throw new Error(request.errors[0]);

  const submitted = await submitFlux3Prediction(request.body);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    const prediction = await getFlux3Prediction(submitted.predictionId);
    const status = prediction.status.toLowerCase();
    if (status === "completed" || status === "succeeded") {
      const url = extractImageUrl(prediction.outputs);
      if (!url) throw new Error("Atlas completed generation without returning an image.");
      return downloadImage(url);
    }
    if (status === "failed") {
      throw new Error(typeof prediction.error === "string" ? prediction.error : "Atlas image generation failed.");
    }
  }
  throw new Error("Timed out waiting for FLUX 3. Check Atlas before retrying.");
}

async function downloadImage(url: string) {
  const response = await fetch("/api/media/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(responseError(payload, `Could not download the generated image (${response.status}).`));
  }
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
    throw new Error("The image provider returned an unsupported image format.");
  }
  if (!response.body) throw new Error("The image provider returned an empty image.");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 20 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Generated images must be 20 MB or smaller.");
      }
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const file = new File(chunks, "storyboard-frame", { type });
  return storyboardImageDataUrl(file);
}

async function normalizeImageDataUrl(dataUrl: string) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const file = new File([blob], "storyboard-frame", { type: blob.type });
  return storyboardImageDataUrl(file);
}

export async function generateStoryboardFrame(
  model: StoryboardFrameModelId,
  prompt: string,
  aspectRatio: StoryboardAspectRatio,
) {
  if (!STORYBOARD_FRAME_MODELS.some((item) => item.id === model)) {
    throw new Error("Choose a supported storyboard image model.");
  }
  if (model.startsWith("gpt-image-")) return generateOpenAiImage(model, prompt, aspectRatio);
  if (model.startsWith("gemini-")) return generateGeminiImage(model, prompt, aspectRatio);
  if (model.startsWith("black-forest-labs/flux-3/")) return generateFlux3Image(prompt, aspectRatio);
  return generateFalImage(model, prompt, aspectRatio);
}
