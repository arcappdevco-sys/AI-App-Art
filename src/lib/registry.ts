"use client";
import { fal } from "@fal-ai/client";
import type { NodeDef, PortType } from "./types";
import { SEEDANCE_MODELS, buildSeedanceRequest } from "./seedance";
import { VEO_MODELS, buildVeoRequest } from "./veo";

fal.config({ proxyUrl: "/api/fal/proxy" });

async function callFal(endpoint: string, input: Record<string, unknown>, log: (m: string) => void, signal?: AbortSignal) {
  try {
    const result = await fal.subscribe(endpoint, {
      input, logs: true, abortSignal: signal,
      onQueueUpdate: (u) => {
        if (u.status === "IN_QUEUE") log(`Queued (position ${u.queue_position ?? "?"})`);
        if (u.status === "IN_PROGRESS") u.logs?.forEach((l) => log(l.message));
      },
    });
    return result.data ?? {};
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const body = typeof e === "object" && e !== null && "body" in e ? e.body : undefined;
    const detail = typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string"
      ? body.detail
      : "";
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
}

export const PORT_COLORS: Record<PortType, string> = {
  text: "#e2b04a",
  image: "#4fb3a9",
  video: "#9a86e0",
  audio: "#d68ac7",
  number: "#6aa6e8",
  any: "#8b97a3",
};

// Replace "{{name}}" string values anywhere in a JSON body with connected inputs.
function fill(value: any, inputs: Record<string, any>): any {
  if (typeof value === "string") {
    const m = value.match(/^\{\{(\w+)\}\}$/);
    return m && inputs[m[1]] !== undefined ? inputs[m[1]] : value;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, inputs));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, inputs)]));
  return value;
}

const prompt: NodeDef = {
  type: "input/prompt", label: "Prompt", category: "Input",
  inputs: {}, outputs: { text: "text" },
  params: [{ key: "text", label: "Text", kind: "textarea", default: "" }],
  execute: async ({ params }) => ({ text: params.text }),
};

const number: NodeDef = {
  type: "input/number", label: "Number", category: "Input",
  inputs: {}, outputs: { value: "number" },
  params: [{ key: "value", label: "Value", kind: "number", default: 0 }],
  execute: async ({ params }) => ({ value: Number(params.value) }),
};

const image: NodeDef = {
  type: "input/image", label: "Image", category: "Input",
  inputs: {}, outputs: { image: "image" },
  params: [{ key: "url", label: "Image (upload or paste URL)", kind: "file", default: "" }],
  execute: async ({ params }) => {
    if (!params.url) throw new Error("Choose an image or paste a URL");
    return { image: params.url };
  },
};

// One generic node that can call ANY fal endpoint. Make presets later by
// copying this and pre-filling endpoint + extra JSON.
const falModel: NodeDef = {
  type: "fal/model", label: "fal model", category: "fal",
  inputs: { prompt: "text", image: "image", seed: "number" },
  outputs: { video: "video", image: "image", json: "text" },
  params: [
    { key: "endpoint", label: "Endpoint ID", kind: "text", default: "fal-ai/flux/dev" },
    {
      key: "input", label: "Extra input (JSON)", kind: "textarea",
      default: '{\n  "prompt": "{{prompt}}"\n}',
    },
  ],
  execute: async ({ inputs, params, log, signal }) => {
    const endpoint = String(params.endpoint || "").trim();
    if (!endpoint) throw new Error("Set an endpoint ID, e.g. fal-ai/flux/dev");

    let body: any;
    try { body = JSON.parse(params.input || "{}"); }
    catch { throw new Error("Extra input is not valid JSON"); }

    body = fill(body, inputs);
    // Sensible defaults if the JSON doesn't mention a connected input
    if (inputs.prompt != null && body.prompt === undefined) body.prompt = inputs.prompt;
    if (inputs.image != null && body.image_url === undefined) body.image_url = inputs.image;
    if (inputs.seed != null && body.seed === undefined) body.seed = inputs.seed;

    const d = await callFal(endpoint, body, log, signal);
    return {
      video: d.video?.url ?? null,
      image: d.images?.[0]?.url ?? d.image?.url ?? null,
      json: JSON.stringify(d),
    };
  },
};

const NANO_MODELS: Record<string, string> = {
  "Nano Banana": "fal-ai/nano-banana",
  "Nano Banana Pro": "fal-ai/nano-banana-pro",
  "Nano Banana 2": "fal-ai/nano-banana-2",
  "Nano Banana 2.1": "google/nano-banana-2.1",
};

const nanoBanana: NodeDef = {
  type: "fal/nano-banana", label: "Nano Banana · Paid", category: "fal",
  autoPrompt: true,
  inputs: { prompt: "text", image1: "image", image2: "image", image3: "image" },
  outputs: { image: "image", json: "text" },
  params: [
    { key: "model", label: "Model", kind: "select", options: Object.keys(NANO_MODELS), default: "Nano Banana" },
    { key: "aspect_ratio", label: "Aspect ratio", kind: "select",
      options: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"], default: "auto" },
    { key: "num_images", label: "Images", kind: "number", default: 1 },
  ],
  execute: async ({ inputs, params, log, signal }) => {
    if (!inputs.prompt) throw new Error("Connect a prompt");
    const refs = [inputs.image1, inputs.image2, inputs.image3].filter(Boolean);
    const base = NANO_MODELS[params.model] ?? NANO_MODELS["Nano Banana"];
    const edit = refs.length > 0;

    const body: Record<string, unknown> = {
      prompt: inputs.prompt,
      num_images: Math.max(1, Number(params.num_images) || 1),
    };
    if (edit) body.image_urls = refs;
    if (params.aspect_ratio && (edit || params.aspect_ratio !== "auto")) body.aspect_ratio = params.aspect_ratio;

    const d = await callFal(edit ? `${base}/edit` : base, body, log, signal);
    return { image: d.images?.[0]?.url ?? null, json: JSON.stringify(d) };
  },
};

const preview: NodeDef = {
  type: "output/preview", label: "Preview", category: "Output",
  inputs: { media: "any" }, outputs: {},
  params: [],
  execute: async ({ inputs }) => ({ media: inputs.media ?? null }),
};

const GEMINI_MODELS: Record<string, string> = {
  "Nano Banana": "gemini-2.5-flash-image",
  "Nano Banana 2": "gemini-3.1-flash-image-preview",
};

const geminiImage: NodeDef = {
  type: "google/gemini-image", label: "Nano Banana · Free tier", category: "Google",
  autoPrompt: true,
  inputs: { prompt: "text", image1: "image", image2: "image", image3: "image" },
  outputs: { image: "image" },
  params: [
    { key: "model", label: "Model", kind: "select", options: Object.keys(GEMINI_MODELS), default: "Nano Banana" },
    { key: "aspect_ratio", label: "Aspect ratio", kind: "select",
      options: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"], default: "auto" },
  ],
  execute: async ({ inputs, params, signal }) => {
    if (!inputs.prompt) throw new Error("Connect a prompt");
    const images = [inputs.image1, inputs.image2, inputs.image3].filter(Boolean);
    const res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: GEMINI_MODELS[params.model] ?? GEMINI_MODELS["Nano Banana"],
        prompt: inputs.prompt,
        images,
        aspectRatio: params.aspect_ratio,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return { image: data.image };
  },
};

const OPENAI_IMAGE_MODELS = {
  "GPT Image 2.6 · Sunburst": "gpt-image-2.6-sunburst",
  "GPT Image 2.6 · Flare": "gpt-image-2.6-flare",
};

const gptImage: NodeDef = {
    type: "openai/gpt-image",
    label: "GPT Image",
    category: "OpenAI",
    integration: "pending",
    autoPrompt: true,
    inputs: { prompt: "text" },
    outputs: { image: "image" },
    params: [
      { key: "model", label: "Model", kind: "select", options: Object.keys(OPENAI_IMAGE_MODELS), default: "GPT Image 2.6 · Sunburst" },
      { key: "size", label: "Size", kind: "select", options: ["auto", "1024x1024", "1536x1024", "1024x1536"], default: "auto" },
      { key: "quality", label: "Quality", kind: "select", options: ["auto", "low", "medium", "high"], default: "auto" },
      { key: "complexity", label: "Complexity", kind: "select", options: ["low", "medium", "high"], default: "high" },
    ],
    execute: async () => {
      throw new Error("OpenAI image generation is a UI placeholder until API setup is complete.");
    },
  };

function videoPlaceholder(type: string, label: string, models: string[] = []): NodeDef {
  return {
    type,
    label,
    category: "Video",
    integration: "pending",
    autoPrompt: true,
    inputs: { prompt: "text" },
    outputs: { video: "video" },
    params: models.length > 0
      ? [{ key: "model", label: "Model", kind: "select", options: models, default: models[0] }]
      : [],
    execute: async () => {
      throw new Error(`${label} video generation is a UI placeholder until API setup is complete.`);
    },
  };
}

const seedanceVideo: NodeDef = {
  ...videoPlaceholder("video/seedance", "Seedance"),
  inputs: {
    prompt: "text",
    image: "image",
    last_image: "image",
    reference_images: "image",
    reference_videos: "video",
    reference_audios: "audio",
  },
  conditionalInputs: {
    image: { param: "task", value: "image-to-video" },
    last_image: { param: "task", value: "image-to-video" },
    reference_images: { param: "task", value: "reference-to-video" },
    reference_videos: { param: "task", value: "reference-to-video" },
    reference_audios: { param: "task", value: "reference-to-video" },
  },
  disabledInputs: {
    reference_audios: "Audio connections are coming soon.",
  },
  params: [
    {
      key: "model",
      label: "Model",
      kind: "select",
      options: Object.values(SEEDANCE_MODELS),
      optionLabels: Object.fromEntries(Object.entries(SEEDANCE_MODELS).map(([label, value]) => [value, label])),
      default: SEEDANCE_MODELS["Seedance 2.5"],
    },
    {
      key: "task",
      label: "Task",
      kind: "select",
      options: ["text-to-video", "image-to-video", "reference-to-video"],
      optionLabels: {
        "text-to-video": "Text to video",
        "image-to-video": "Image to video",
        "reference-to-video": "Ingredients to video",
      },
      default: "text-to-video",
    },
    {
      key: "duration",
      label: "Duration",
      kind: "select",
      options: ["-1", ...Array.from({ length: 27 }, (_, index) => String(index + 4))],
      optionLabels: Object.fromEntries([
        ["-1", "Auto"],
        ...Array.from({ length: 27 }, (_, index) => {
          const seconds = String(index + 4);
          return [seconds, `${seconds} seconds`];
        }),
      ]),
      optionsByParam: {
        param: "model",
        values: {
          [SEEDANCE_MODELS["Seedance 2.5"]]: ["-1", ...Array.from({ length: 27 }, (_, index) => String(index + 4))],
          [SEEDANCE_MODELS["Seedance 2.0"]]: ["-1", ...Array.from({ length: 12 }, (_, index) => String(index + 4))],
          [SEEDANCE_MODELS["Seedance 2.0 Fast"]]: ["-1", ...Array.from({ length: 12 }, (_, index) => String(index + 4))],
          [SEEDANCE_MODELS["Seedance 2.0 Mini"]]: ["-1", ...Array.from({ length: 12 }, (_, index) => String(index + 4))],
        },
      },
      default: "5",
      disabledWhen: { param: "omni_reference_task_type", value: "edit" },
    },
    {
      key: "ratio",
      label: "Aspect ratio",
      kind: "select",
      options: ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
      optionLabels: { adaptive: "Adaptive" },
      default: "adaptive",
    },
    {
      key: "resolution",
      label: "Resolution",
      kind: "select",
      options: ["480p", "720p", "1080p", "720p-sr", "720p-esr", "1080p-sr", "1080p-esr", "1080p-esr-60fps", "1440p-sr", "1440p-esr", "4k-esr"],
      optionLabels: { "1080p-esr-60fps": "1080p-esr & 60fps" },
      optionGroups: [
        { label: "Native", options: ["480p", "720p", "1080p"] },
        { label: "Enhanced (upscaled, costs more)", options: ["720p-sr", "720p-esr", "1080p-sr", "1080p-esr", "1080p-esr-60fps", "1440p-sr", "1440p-esr", "4k-esr"] },
      ],
      optionsByParam: {
        param: "model",
        values: {
          [SEEDANCE_MODELS["Seedance 2.5"]]: ["480p", "720p", "1080p", "720p-sr", "720p-esr", "1080p-sr", "1080p-esr", "1080p-esr-60fps", "1440p-sr", "1440p-esr", "4k-esr"],
          [SEEDANCE_MODELS["Seedance 2.0"]]: ["480p", "720p"],
          [SEEDANCE_MODELS["Seedance 2.0 Fast"]]: ["480p", "720p"],
          [SEEDANCE_MODELS["Seedance 2.0 Mini"]]: ["480p", "720p"],
        },
      },
      default: "720p",
      disabledWhen: { param: "draft", value: true },
      helperText: "4k-esr is enhanced from 1080p, not native 4K.",
    },
    { key: "generate_audio", label: "Generate audio", kind: "toggle", default: true },
    { key: "watermark", label: "Watermark", kind: "toggle", default: false },
    { key: "return_last_frame", label: "Return last frame", kind: "toggle", default: false },
    {
      key: "omni_reference_task_type",
      label: "Reference task",
      kind: "select",
      options: ["auto", "reference", "edit", "extend"],
      optionLabels: { auto: "Auto", reference: "Reference", edit: "Edit", extend: "Extend" },
      default: "auto",
      visibleWhen: { param: "task", value: "reference-to-video" },
    },
    {
      key: "draft",
      label: "Draft preview",
      kind: "toggle",
      default: false,
      visibleWhen: { param: "model", value: SEEDANCE_MODELS["Seedance 2.5"] },
      helperText: "Draft: renders at 480p, can be finished at 1080p later",
    },
    {
      key: "output_format",
      label: "Output format",
      kind: "select",
      options: ["mp4", "mov"],
      default: "mp4",
      visibleWhen: { param: "model", value: SEEDANCE_MODELS["Seedance 2.5"] },
    },
    {
      key: "bitrate_mode",
      label: "Bitrate mode",
      kind: "select",
      options: ["standard", "high"],
      optionLabels: { standard: "Standard", high: "High" },
      default: "standard",
    },
    {
      key: "variations",
      label: "Variations",
      kind: "select",
      options: ["1", "2", "3", "4"],
      default: "1",
      helperText: "Each variation is a separate paid generation.",
    },
  ],
  execute: async ({ inputs, params }) => {
    buildSeedanceRequest({ params }, inputs);
    throw new Error("Seedance generation is a UI placeholder until API setup is complete.");
  },
};
const klingVideo = videoPlaceholder("video/kling", "Kling");
const veoVideo: NodeDef = {
  ...videoPlaceholder("video/veo", "Veo"),
  inputs: {
    prompt: "text",
    first_frame: "image",
    last_frame: "image",
    ingredient_1: "image",
    ingredient_2: "image",
    ingredient_3: "image",
  },
  conditionalInputs: {
    first_frame: { param: "task", value: "image-to-video" },
    last_frame: { param: "task", value: "image-to-video" },
    ingredient_1: { param: "task", value: "reference-to-video" },
    ingredient_2: { param: "task", value: "reference-to-video" },
    ingredient_3: { param: "task", value: "reference-to-video" },
  },
  params: [
    {
      key: "model",
      label: "Model",
      kind: "select",
      options: Object.values(VEO_MODELS),
      optionLabels: Object.fromEntries(Object.entries(VEO_MODELS).map(([label, value]) => [value, label])),
      default: VEO_MODELS["Veo 3.1"],
    },
    {
      key: "task",
      label: "Task",
      kind: "select",
      options: ["text-to-video", "image-to-video", "reference-to-video"],
      optionLabels: {
        "text-to-video": "Text to video",
        "image-to-video": "Image to video",
        "reference-to-video": "Ingredients to video",
      },
      optionsByParam: {
        param: "model",
        values: {
          [VEO_MODELS["Veo 3.1"]]: ["text-to-video", "image-to-video", "reference-to-video"],
          [VEO_MODELS["Veo 3.1 Fast"]]: ["text-to-video", "image-to-video"],
          [VEO_MODELS["Veo 3.1 Lite"]]: ["text-to-video", "image-to-video"],
        },
      },
      default: "text-to-video",
    },
    {
      key: "duration",
      label: "Duration",
      kind: "select",
      options: ["4", "6", "8"],
      optionLabels: { "4": "4 seconds", "6": "6 seconds", "8": "8 seconds" },
      default: "8",
    },
    {
      key: "aspect_ratio",
      label: "Aspect ratio",
      kind: "select",
      options: ["16:9", "9:16"],
      default: "16:9",
    },
    {
      key: "resolution",
      label: "Resolution",
      kind: "select",
      options: ["720p", "1080p"],
      optionsByParam: {
        param: "model",
        values: {
          [VEO_MODELS["Veo 3.1"]]: ["720p", "1080p", "4K"],
          [VEO_MODELS["Veo 3.1 Fast"]]: ["720p", "1080p", "4K"],
          [VEO_MODELS["Veo 3.1 Lite"]]: ["720p", "1080p"],
        },
      },
      default: "1080p",
    },
    {
      key: "seed",
      label: "Seed",
      kind: "number",
      default: "",
    },
    {
      key: "count",
      label: "Count",
      kind: "select",
      options: ["1", "2", "3", "4"],
      default: "1",
    },
    {
      key: "generate_audio",
      label: "Generate audio",
      kind: "toggle",
      default: true,
    },
  ],
  execute: async ({ inputs, params }) => {
    buildVeoRequest({ params }, inputs);
    throw new Error("Veo generation is a UI placeholder until API setup is complete.");
  },
};
const googleOmniVideo = videoPlaceholder("video/google-omni", "Google Omni");

export const registry: Record<string, NodeDef> = Object.fromEntries(
  [
    prompt, number, image, falModel, nanoBanana, geminiImage, gptImage,
    seedanceVideo, klingVideo, veoVideo, googleOmniVideo, preview,
  ].map((d) => [d.type, d])
);
