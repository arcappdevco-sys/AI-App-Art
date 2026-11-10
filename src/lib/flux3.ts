export const FLUX3_NODE_TYPE = "image/flux-3";
export const FLUX3_MODEL_PREFIX = "black-forest-labs/flux-3/";
// Atlas serves FLUX 3 images from generateImage, not generateVideo.
export const FLUX3_SUBMIT_PATH = "generateImage";

export const FLUX3_TASKS = {
  "Text to image": "text-to-image",
  "Edit image": "edit",
} as const;
export type Flux3Task = (typeof FLUX3_TASKS)[keyof typeof FLUX3_TASKS];

export const FLUX3_ALLOWED_MODELS = Object.values(FLUX3_TASKS).map((task) => `${FLUX3_MODEL_PREFIX}${task}`);

export const FLUX3_RATIOS = [
  "auto", "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2",
] as const;
// Atlas descriptive text also mentions "512sq", but the API schema does not list it, so it is not offered.
export const FLUX3_RESOLUTIONS = ["768sq", "1k", "2k", "4k"] as const;
export const FLUX3_FORMATS = ["jpeg", "png"] as const;
export const FLUX3_SAFETY_MIN = 0;
export const FLUX3_SAFETY_MAX = 4;
export const FLUX3_MAX_REFERENCES = 10;
export const FLUX3_MIN_SIDE_PX = 256;

// Only the "from" rate is published by Atlas; per-resolution prices are unknown.
export const FLUX3_RATES: Record<Flux3Task, number> = {
  "text-to-image": 0.02,
  edit: 0.02,
};
export const FLUX3_CONFIRM_ABOVE_USD = 1.0;

export const FLUX3_DEFAULTS = {
  model: `${FLUX3_MODEL_PREFIX}text-to-image`,
  task: "text-to-image" as Flux3Task,
  aspect_ratio: "auto",
  resolution: "1k",
  enable_prompt_expansion: false,
  output_format: "jpeg",
  safety_tolerance: 2,
  references_initialized: false,
  prediction_id: "",
  last_status: "",
  last_output_urls: [] as string[],
};

export type Flux3ResolvedInputs = {
  prompt?: unknown;
  references?: unknown[];
};
export type Flux3NodeLike = { params: Record<string, unknown> };

const TASK_VALUES = Object.values(FLUX3_TASKS) as Flux3Task[];
const PREDICTION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const HTTP_URL = /^https?:\/\/\S+$/i;
const LOCAL_PLACEHOLDER = /^\[local image \d+ uploaded during generation\]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTask(value: unknown): value is Flux3Task {
  return TASK_VALUES.includes(value as Flux3Task);
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && list.includes(value as T) ? value as T : fallback;
}

export function normalizeFlux3Params(params: Record<string, unknown> = {}) {
  const modelTask = typeof params.model === "string" && params.model.startsWith(FLUX3_MODEL_PREFIX)
    ? params.model.slice(FLUX3_MODEL_PREFIX.length)
    : undefined;
  const task: Flux3Task = isTask(params.task) ? params.task : isTask(modelTask) ? modelTask : FLUX3_DEFAULTS.task;
  const safetyRaw = params.safety_tolerance ?? params.safety;
  const safety = typeof safetyRaw === "number" ? safetyRaw : Number(safetyRaw);
  const legacyUrl = typeof params.last_output_url === "string" ? [params.last_output_url] : [];
  const urls = (Array.isArray(params.last_output_urls) ? params.last_output_urls : legacyUrl)
    .filter((url): url is string => typeof url === "string" && HTTP_URL.test(url));
  return {
    ...FLUX3_DEFAULTS,
    model: `${FLUX3_MODEL_PREFIX}${task}`,
    task,
    aspect_ratio: oneOf(FLUX3_RATIOS, params.aspect_ratio ?? params.ratio, "auto"),
    resolution: oneOf(FLUX3_RESOLUTIONS, params.resolution, "1k"),
    enable_prompt_expansion: (params.enable_prompt_expansion ?? params.prompt_expansion) === true,
    output_format: oneOf(FLUX3_FORMATS, params.output_format ?? params.format, "jpeg"),
    safety_tolerance: Number.isInteger(safety) && safety >= FLUX3_SAFETY_MIN && safety <= FLUX3_SAFETY_MAX
      && params.safety_tolerance !== "" ? safety : FLUX3_DEFAULTS.safety_tolerance,
    references_initialized: params.references_initialized === true,
    prediction_id: typeof params.prediction_id === "string" && PREDICTION_ID.test(params.prediction_id)
      ? params.prediction_id
      : "",
    last_status: typeof params.last_status === "string" ? params.last_status : "",
    last_output_urls: urls,
  };
}

function describeFlux3Image(value: unknown, index: number): string | null {
  const local = `[local image ${index} uploaded during generation]`;
  if (typeof value === "string") {
    return HTTP_URL.test(value) ? value : value.startsWith("data:") ? local : null;
  }
  if (typeof File !== "undefined" && value instanceof File) return local;
  if (!isRecord(value)) return null;
  if (typeof value.url === "string") return describeFlux3Image(value.url, index);
  if (typeof value.dataUrl === "string" || value.local === true || typeof value.id === "string") return local;
  if (typeof value.value === "string") return describeFlux3Image(value.value, index);
  return null;
}

export function buildFlux3Request(node: Flux3NodeLike, resolvedInputs: Flux3ResolvedInputs) {
  const rawTask = node.params.task;
  const rawSafety = node.params.safety_tolerance;
  const params = normalizeFlux3Params(node.params);
  const task = params.task;
  const model = `${FLUX3_MODEL_PREFIX}${task}`;
  const prompt = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  const references = resolvedInputs.references ?? [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isTask(rawTask)) errors.push("Choose a supported FLUX 3 task.");
  if (!prompt.trim()) errors.push("A non-empty prompt is required.");
  if (!FLUX3_RATIOS.includes(node.params.aspect_ratio as never)) errors.push("Choose a supported aspect ratio.");
  if (!FLUX3_RESOLUTIONS.includes(node.params.resolution as never)) errors.push("Choose a supported resolution.");
  if (!FLUX3_FORMATS.includes(node.params.output_format as never)) errors.push("Choose JPEG or PNG output.");
  if (typeof rawSafety !== "number" || !Number.isInteger(rawSafety)
    || rawSafety < FLUX3_SAFETY_MIN || rawSafety > FLUX3_SAFETY_MAX) {
    errors.push("Safety tolerance must be a whole number from 0 to 4.");
  }
  if (typeof node.params.enable_prompt_expansion !== "boolean") errors.push("Prompt expansion must be on or off.");

  const body: Record<string, unknown> = { model, prompt };
  if (task === FLUX3_TASKS["Edit image"]) {
    const described = references.map((reference, index) => describeFlux3Image(reference, index + 1));
    if (references.length === 0) errors.push("Edit image needs at least one reference image.");
    if (references.length > FLUX3_MAX_REFERENCES) {
      errors.push(`Edit image accepts at most ${FLUX3_MAX_REFERENCES} reference images.`);
    }
    described.forEach((entry, index) => {
      if (!entry) errors.push(`Image ${index + 1} has no image yet. Upload one or paste an image URL.`);
    });
    body.reference_images = described.filter((entry): entry is string => Boolean(entry));
    warnings.push("Accepted image formats and file sizes are not documented by Atlas.");
  }
  Object.assign(body, {
    aspect_ratio: params.aspect_ratio,
    resolution: params.resolution,
    enable_prompt_expansion: params.enable_prompt_expansion,
    output_format: params.output_format,
    safety_tolerance: params.safety_tolerance,
  });

  return { model, task, endpoint: model, submitPath: FLUX3_SUBMIT_PATH, body, errors, warnings };
}

// Server-side validation of the exact body the browser may send to generateImage.
export function validateFlux3RequestBody(value: unknown) {
  if (!isRecord(value)) return ["FLUX 3 request body must be an object."];
  const errors: string[] = [];
  const model = value.model;
  if (typeof model !== "string" || !FLUX3_ALLOWED_MODELS.includes(model)) {
    return ["Only the FLUX 3 text-to-image and edit models are supported."];
  }
  const edit = model.endsWith(`/${FLUX3_TASKS["Edit image"]}`);
  const allowed = new Set([
    "model", "prompt", "aspect_ratio", "resolution", "enable_prompt_expansion", "output_format", "safety_tolerance",
    ...(edit ? ["reference_images"] : []),
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${key} is not a valid field for this FLUX 3 task.`);
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim()) errors.push("A non-empty prompt is required.");
  if (!FLUX3_RATIOS.includes(value.aspect_ratio as never)) errors.push("Choose a supported aspect ratio.");
  if (!FLUX3_RESOLUTIONS.includes(value.resolution as never)) errors.push("Choose a supported resolution.");
  if (!FLUX3_FORMATS.includes(value.output_format as never)) errors.push("Choose JPEG or PNG output.");
  if (typeof value.enable_prompt_expansion !== "boolean") errors.push("Prompt expansion must be true or false.");
  const safety = value.safety_tolerance;
  if (typeof safety !== "number" || !Number.isInteger(safety)
    || safety < FLUX3_SAFETY_MIN || safety > FLUX3_SAFETY_MAX) {
    errors.push("Safety tolerance must be a whole number from 0 to 4.");
  }
  if (edit) {
    const references = value.reference_images;
    if (!Array.isArray(references) || references.length < 1 || references.length > FLUX3_MAX_REFERENCES) {
      errors.push(`Edit image needs 1 to ${FLUX3_MAX_REFERENCES} reference image URLs.`);
    } else if (references.some((entry) => typeof entry !== "string" || !HTTP_URL.test(entry)
      || LOCAL_PLACEHOLDER.test(entry))) {
      errors.push("Every reference image must be an uploaded or public http(s) URL.");
    }
  }
  return errors;
}

export function validateFlux3Upload(file: { name: string; type: string; size: number }) {
  if (!file.size) return ["The image file is empty."];
  if (!/^image\//i.test(file.type)) return ["Choose an image file."];
  // Local safety cap for this proxy only; Atlas does not document a size limit.
  if (file.size > 100 * 1024 * 1024) return ["Images must be 100 MB or smaller."];
  return [];
}
