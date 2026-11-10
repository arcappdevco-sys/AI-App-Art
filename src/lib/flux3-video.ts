export const FLUX3_VIDEO_NODE_TYPE = "video/flux-3";
export const FLUX3_VIDEO_MODEL_PREFIX = "black-forest-labs/flux-3/";
// Atlas's model pages document generateVideo; some of its schema files list generateImage, so this is unverified.
export const FLUX3_VIDEO_SUBMIT_PATH = "generateVideo";

export const FLUX3_VIDEO_TASKS = {
  "Text to video": "text-to-video",
  "Image to video": "image-to-video",
  "First and last frame": "first-last-frame-to-video",
  "Keyframes to video": "keyframes-to-video",
  "Extend video": "extend-video",
  "Edit video": "edit-video",
} as const;
export type Flux3VideoTask = (typeof FLUX3_VIDEO_TASKS)[keyof typeof FLUX3_VIDEO_TASKS];

export const FLUX3_VIDEO_ALLOWED_MODELS = Object.values(FLUX3_VIDEO_TASKS).map((task) => `${FLUX3_VIDEO_MODEL_PREFIX}${task}`);

export const FLUX3_VIDEO_RATIOS = ["auto", "21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const FLUX3_VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export const FLUX3_VIDEO_DURATIONS = Array.from({ length: 16 }, (_, index) => index + 5);
export const FLUX3_VIDEO_SAFETY_MIN = 0;
export const FLUX3_VIDEO_SAFETY_MAX = 4;
export const FLUX3_VIDEO_MAX_KEYFRAMES = 10;
export const FLUX3_VIDEO_FPS = 24;
export const FLUX3_VIDEO_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const FLUX3_VIDEO_CONFIRM_ABOVE_USD = 1.0;

// Atlas publishes one per-second rate per task; the edit task's output follows the input clip's length.
export const FLUX3_VIDEO_RATES: Record<Flux3VideoTask, number> = {
  "text-to-video": 0.17,
  "image-to-video": 0.17,
  "first-last-frame-to-video": 0.17,
  "keyframes-to-video": 0.17,
  "extend-video": 0.41,
  "edit-video": 0.03,
};

export type Flux3Keyframe = { image_url: string; frame_index: number };

export const FLUX3_VIDEO_DEFAULTS = {
  model: `${FLUX3_VIDEO_MODEL_PREFIX}text-to-video`,
  task: "text-to-video" as Flux3VideoTask,
  aspect_ratio: "auto",
  resolution: "720p",
  duration: 5,
  generate_audio: true,
  safety_tolerance: 2,
  seed: "",
  image_url: "",
  start_image_url: "",
  end_image_url: "",
  video_url: "",
  keyframes: [] as Flux3Keyframe[],
  prediction_id: "",
  last_status: "",
  last_output_urls: [] as string[],
};

export type Flux3VideoResolvedInputs = {
  prompt?: unknown;
  image?: unknown;
  start_image?: unknown;
  end_image?: unknown;
  video?: unknown;
  keyframes?: { value: unknown; frame_index: number }[];
};
export type Flux3VideoNodeLike = { params: Record<string, unknown> };

const TASK_VALUES = Object.values(FLUX3_VIDEO_TASKS) as Flux3VideoTask[];
const PREDICTION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const HTTP_URL = /^https?:\/\/\S+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTask(value: unknown): value is Flux3VideoTask {
  return TASK_VALUES.includes(value as Flux3VideoTask);
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && list.includes(value as T) ? value as T : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function normalizeFlux3VideoParams(params: Record<string, unknown> = {}) {
  const modelTask = typeof params.model === "string" && params.model.startsWith(FLUX3_VIDEO_MODEL_PREFIX)
    ? params.model.slice(FLUX3_VIDEO_MODEL_PREFIX.length)
    : undefined;
  const task: Flux3VideoTask = isTask(params.task) ? params.task : isTask(modelTask) ? modelTask : FLUX3_VIDEO_DEFAULTS.task;
  const safety = typeof params.safety_tolerance === "number" ? params.safety_tolerance : Number(params.safety_tolerance);
  const duration = typeof params.duration === "number" ? params.duration : Number(params.duration);
  const keyframes = (Array.isArray(params.keyframes) ? params.keyframes : [])
    .filter(isRecord)
    .slice(0, FLUX3_VIDEO_MAX_KEYFRAMES)
    .map((entry) => ({
      image_url: text(entry.image_url),
      frame_index: Number.isInteger(entry.frame_index) ? Number(entry.frame_index) : 0,
    }));
  const urls = (Array.isArray(params.last_output_urls) ? params.last_output_urls : [])
    .filter((url): url is string => typeof url === "string" && HTTP_URL.test(url));
  return {
    ...FLUX3_VIDEO_DEFAULTS,
    model: `${FLUX3_VIDEO_MODEL_PREFIX}${task}`,
    task,
    aspect_ratio: oneOf(FLUX3_VIDEO_RATIOS, params.aspect_ratio, "auto"),
    resolution: oneOf(FLUX3_VIDEO_RESOLUTIONS, params.resolution, "720p"),
    duration: FLUX3_VIDEO_DURATIONS.includes(duration) ? duration : FLUX3_VIDEO_DEFAULTS.duration,
    generate_audio: params.generate_audio !== false,
    safety_tolerance: Number.isInteger(safety) && safety >= FLUX3_VIDEO_SAFETY_MIN && safety <= FLUX3_VIDEO_SAFETY_MAX
      && params.safety_tolerance !== "" ? safety : FLUX3_VIDEO_DEFAULTS.safety_tolerance,
    seed: text(params.seed).trim(),
    image_url: text(params.image_url),
    start_image_url: text(params.start_image_url),
    end_image_url: text(params.end_image_url),
    video_url: text(params.video_url),
    keyframes,
    prediction_id: typeof params.prediction_id === "string" && PREDICTION_ID.test(params.prediction_id)
      ? params.prediction_id
      : "",
    last_status: text(params.last_status),
    last_output_urls: urls,
  };
}

function describeMedia(value: unknown, label: string): string | null {
  const local = `[local ${label} uploaded during generation]`;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return HTTP_URL.test(trimmed) ? trimmed : trimmed.startsWith("data:") ? local : null;
  }
  if (typeof File !== "undefined" && value instanceof File) return local;
  if (!isRecord(value)) return null;
  if (typeof value.url === "string") return describeMedia(value.url, label);
  if (typeof value.dataUrl === "string" || value.local === true || typeof value.id === "string") return local;
  if (typeof value.value === "string") return describeMedia(value.value, label);
  return null;
}

export function buildFlux3VideoRequest(node: Flux3VideoNodeLike, resolvedInputs: Flux3VideoResolvedInputs) {
  const rawTask = node.params.task;
  const params = normalizeFlux3VideoParams(node.params);
  const task = params.task;
  const model = `${FLUX3_VIDEO_MODEL_PREFIX}${task}`;
  const prompt = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  const errors: string[] = [];
  const warnings: string[] = [];
  const body: Record<string, unknown> = { model };

  if (!isTask(rawTask)) errors.push("Choose a supported FLUX 3 video task.");
  const promptRequired = task === "text-to-video" || task === "edit-video";
  if (promptRequired && !prompt.trim()) errors.push("A non-empty prompt is required.");
  if (prompt.trim()) body.prompt = prompt;

  const media = (value: unknown, label: string, missing: string) => {
    const described = describeMedia(value, label);
    if (!described) errors.push(missing);
    return described;
  };
  if (task === "image-to-video") {
    const url = media(resolvedInputs.image, "image", "Image to video needs an image. Connect an Image node or paste an image URL.");
    if (url) body.image_url = url;
  }
  if (task === "first-last-frame-to-video") {
    const start = media(resolvedInputs.start_image, "start image", "Add a start image (connect one or paste a URL).");
    const end = media(resolvedInputs.end_image, "end image", "Add an end image (connect one or paste a URL).");
    if (start) body.start_image_url = start;
    if (end) body.end_image_url = end;
  }
  if (task === "extend-video" || task === "edit-video") {
    const url = media(resolvedInputs.video, "video", "Add a source video (connect a video output or paste a URL).");
    if (url) body.video_url = url;
    warnings.push("Source video must be MP4, under 50 MB and under 15 seconds.");
  }
  if (task === "keyframes-to-video") {
    const frames = resolvedInputs.keyframes ?? [];
    if (frames.length === 0) errors.push("Add at least one keyframe.");
    if (frames.length > FLUX3_VIDEO_MAX_KEYFRAMES) errors.push(`Keyframes accept at most ${FLUX3_VIDEO_MAX_KEYFRAMES} images.`);
    const seen = new Set<number>();
    const maxFrame = params.duration * FLUX3_VIDEO_FPS;
    body.keyframes = frames.map((frame, index) => {
      const url = describeMedia(frame.value, `keyframe ${index + 1}`);
      if (!url) errors.push(`Keyframe ${index + 1} has no image yet. Connect one or paste an image URL.`);
      if (!Number.isInteger(frame.frame_index) || frame.frame_index < 0 || frame.frame_index > maxFrame) {
        errors.push(`Keyframe ${index + 1} frame must be a whole number from 0 to ${maxFrame} (${params.duration} s at ${FLUX3_VIDEO_FPS} fps).`);
      }
      if (seen.has(frame.frame_index)) errors.push(`Keyframe ${index + 1} repeats frame ${frame.frame_index}. Each keyframe needs a unique frame.`);
      seen.add(frame.frame_index);
      return { image_url: url ?? "", frame_index: frame.frame_index };
    });
  }
  if (task !== "edit-video") {
    Object.assign(body, {
      aspect_ratio: params.aspect_ratio,
      resolution: params.resolution,
      duration: params.duration,
      generate_audio: params.generate_audio,
    });
    if (params.seed !== "") {
      const seed = Number(params.seed);
      if (!Number.isInteger(seed) || seed < 0) errors.push("Seed must be a whole number of 0 or more, or blank.");
      else body.seed = seed;
    }
  }
  const rawSafety = node.params.safety_tolerance;
  if (typeof rawSafety !== "number" || !Number.isInteger(rawSafety)
    || rawSafety < FLUX3_VIDEO_SAFETY_MIN || rawSafety > FLUX3_VIDEO_SAFETY_MAX) {
    errors.push("Safety tolerance must be a whole number from 0 to 4.");
  }
  body.safety_tolerance = params.safety_tolerance;

  return { model, task, endpoint: model, submitPath: FLUX3_VIDEO_SUBMIT_PATH, body, errors, warnings };
}

const COMMON_KEYS = ["model", "prompt", "safety_tolerance"];
const TIMED_KEYS = ["aspect_ratio", "resolution", "duration", "generate_audio", "seed"];
const TASK_KEYS: Record<Flux3VideoTask, string[]> = {
  "text-to-video": TIMED_KEYS,
  "image-to-video": [...TIMED_KEYS, "image_url"],
  "first-last-frame-to-video": [...TIMED_KEYS, "start_image_url", "end_image_url"],
  "keyframes-to-video": [...TIMED_KEYS, "keyframes"],
  "extend-video": [...TIMED_KEYS, "video_url"],
  "edit-video": ["video_url"],
};

// Server-side validation of the exact body the browser may send to generateVideo.
export function validateFlux3VideoRequestBody(value: unknown) {
  if (!isRecord(value)) return ["FLUX 3 video request body must be an object."];
  const model = value.model;
  if (typeof model !== "string" || !FLUX3_VIDEO_ALLOWED_MODELS.includes(model)) {
    return ["Only the FLUX 3 video models are supported."];
  }
  const task = model.slice(FLUX3_VIDEO_MODEL_PREFIX.length) as Flux3VideoTask;
  const errors: string[] = [];
  const allowed = new Set([...COMMON_KEYS, ...TASK_KEYS[task]]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`Unsupported field "${key}" for ${task}.`);
  }
  if (value.prompt !== undefined && typeof value.prompt !== "string") errors.push("Prompt must be text.");
  if ((task === "text-to-video" || task === "edit-video") && !text(value.prompt).trim()) {
    errors.push("A non-empty prompt is required.");
  }
  const safety = value.safety_tolerance;
  if (!Number.isInteger(safety) || Number(safety) < FLUX3_VIDEO_SAFETY_MIN || Number(safety) > FLUX3_VIDEO_SAFETY_MAX) {
    errors.push("Safety tolerance must be a whole number from 0 to 4.");
  }
  if (task !== "edit-video") {
    if (!FLUX3_VIDEO_RATIOS.includes(value.aspect_ratio as never)) errors.push("Unsupported aspect ratio.");
    if (!FLUX3_VIDEO_RESOLUTIONS.includes(value.resolution as never)) errors.push("Unsupported resolution.");
    if (!Number.isInteger(value.duration) || !FLUX3_VIDEO_DURATIONS.includes(Number(value.duration))) {
      errors.push("Duration must be a whole number from 5 to 20 seconds.");
    }
    if (typeof value.generate_audio !== "boolean") errors.push("Audio must be on or off.");
    if (value.seed !== undefined && (!Number.isInteger(value.seed) || Number(value.seed) < 0)) {
      errors.push("Seed must be a whole number of 0 or more.");
    }
  }
  const urlField = (key: string) => {
    if (typeof value[key] !== "string" || !HTTP_URL.test(value[key] as string)) errors.push(`${key} must be a public http(s) URL.`);
  };
  if (task === "image-to-video") urlField("image_url");
  if (task === "first-last-frame-to-video") {
    urlField("start_image_url");
    urlField("end_image_url");
  }
  if (task === "extend-video" || task === "edit-video") urlField("video_url");
  if (task === "keyframes-to-video") {
    const frames = value.keyframes;
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > FLUX3_VIDEO_MAX_KEYFRAMES) {
      errors.push(`Keyframes must contain 1 to ${FLUX3_VIDEO_MAX_KEYFRAMES} items.`);
    } else {
      const maxFrame = Number(value.duration) * FLUX3_VIDEO_FPS;
      const seen = new Set<number>();
      frames.forEach((frame, index) => {
        if (!isRecord(frame) || Object.keys(frame).some((key) => key !== "image_url" && key !== "frame_index")
          || typeof frame.image_url !== "string" || !HTTP_URL.test(frame.image_url)) {
          errors.push(`Keyframe ${index + 1} needs a public image URL.`);
          return;
        }
        const position = frame.frame_index;
        if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position > maxFrame || seen.has(position)) {
          errors.push(`Keyframe ${index + 1} needs a unique whole-number frame from 0 to ${maxFrame}.`);
        } else seen.add(position);
      });
    }
  }
  return errors;
}

export function validateFlux3VideoUpload(file: { name: string; type: string; size: number }) {
  const errors: string[] = [];
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const image = ["png", "jpg", "jpeg", "webp"].includes(extension) && file.type.toLowerCase().startsWith("image/");
  const video = extension === "mp4" && file.type.toLowerCase() === "video/mp4";
  if (!image && !video) errors.push("Upload a PNG, JPEG or WebP image, or an MP4 video.");
  if (file.size <= 0) errors.push("The selected file is empty.");
  if (video && file.size >= FLUX3_VIDEO_MAX_SOURCE_BYTES) errors.push("Source video must be under 50 MB.");
  if (image && file.size > 100 * 1024 * 1024) errors.push("Image is larger than the 100 MB local upload limit.");
  return errors;
}
