export const MINIMAX_NODE_TYPE = "video/minimax-h3";

export const MINIMAX_MODELS = {
  "MiniMax H3": "minimax/h3",
  "MiniMax H3 Fast": "minimax/h3-fast",
  "MiniMax H3 Max": "minimax/h3-max",
  "MiniMax H3 Max Turbo": "minimax/h3-max-turbo",
} as const;

export type MiniMaxModel = (typeof MINIMAX_MODELS)[keyof typeof MINIMAX_MODELS];

export const MINIMAX_TASKS = {
  "Text to video": "text-to-video",
  "Image to video": "image-to-video",
  "Reference to video": "reference-to-video",
} as const;

export type MiniMaxTask = (typeof MINIMAX_TASKS)[keyof typeof MINIMAX_TASKS];

type MiniMaxVariant = {
  label: string;
  minDuration: number;
  defaultResolution: string;
  tasks: Partial<Record<MiniMaxTask, readonly string[]>>;
};

export const MINIMAX_RATES: Record<string, number> = {
  [MINIMAX_MODELS["MiniMax H3"]]: 0.038,
  // Unverified on Atlas: another H3 Fast page lists $0.046/s.
  [MINIMAX_MODELS["MiniMax H3 Fast"]]: 0.044,
  [MINIMAX_MODELS["MiniMax H3 Max"]]: 0.048,
  [MINIMAX_MODELS["MiniMax H3 Max Turbo"]]: 0.024,
};

export const MINIMAX_CONFIRM_ABOVE_USD = 1.0;
export const MINIMAX_MAX_REFS_IMAGES: number | null = null;
export const MINIMAX_MAX_REFS_VIDEOS: number | null = null;
export const MINIMAX_MAX_REFS_AUDIO: number | null = null;

export const MINIMAX_VARIANTS: Record<MiniMaxModel, MiniMaxVariant> = {
  [MINIMAX_MODELS["MiniMax H3"]]: {
    label: "MiniMax H3",
    minDuration: 4,
    defaultResolution: "2K",
    tasks: {
      "text-to-video": ["480P", "768P", "2K"],
      "image-to-video": ["480P", "768P", "2K", "1080p-esr", "1440p-esr", "4k-esr"],
      "reference-to-video": ["480P", "768P", "2K", "1080p-esr", "1440p-esr", "4k-esr"],
    },
  },
  [MINIMAX_MODELS["MiniMax H3 Fast"]]: {
    label: "MiniMax H3 Fast",
    minDuration: 5,
    defaultResolution: "480P",
    tasks: {
      "text-to-video": ["480P"],
      // Unverified on Atlas: the H3 Fast Image to video schema was not fully read.
      "image-to-video": ["480P"],
      "reference-to-video": ["480P"],
    },
  },
  [MINIMAX_MODELS["MiniMax H3 Max"]]: {
    label: "MiniMax H3 Max",
    minDuration: 5,
    defaultResolution: "768P",
    tasks: {
      "text-to-video": ["480P", "768P", "1440p-sr", "4k-sr"],
      // Unverified on Atlas: image/reference schemas were not fully read.
      "image-to-video": ["480P", "768P"],
      "reference-to-video": ["480P", "768P"],
    },
  },
  [MINIMAX_MODELS["MiniMax H3 Max Turbo"]]: {
    label: "MiniMax H3 Max Turbo",
    minDuration: 5,
    defaultResolution: "768P",
    tasks: {
      "text-to-video": ["480P", "768P"],
      // Unverified on Atlas: the image task page conflicts on resolution.
      "image-to-video": ["480P", "768P"],
    },
  },
} as const;

export const MINIMAX_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const MINIMAX_DEFAULTS = {
  model: MINIMAX_MODELS["MiniMax H3"],
  task: MINIMAX_TASKS["Text to video"],
  resolution: "2K",
  duration: 8,
  ratio: "1:1",
  prompt_expansion: false,
  reference_image_count: 1,
  prediction_id: "",
  last_status: "",
  last_output_url: "",
} as const;

export const MINIMAX_UPLOAD_TYPES = {
  image: new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]),
  video: new Set(["video/mp4", "video/quicktime"]),
  audio: new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"]),
} as const;

export type MiniMaxReference = {
  type: "image" | "video" | "audio";
  value: unknown;
};

export type MiniMaxResolvedInputs = {
  prompt?: unknown;
  image?: unknown;
  end_image?: unknown;
  refers?: MiniMaxReference[];
};

export type MiniMaxNodeLike = { params: Record<string, unknown> };
const MODEL_VALUES = Object.values(MINIMAX_MODELS) as MiniMaxModel[];
const TASK_VALUES = Object.values(MINIMAX_TASKS) as MiniMaxTask[];
const PREDICTION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const HTTP_URL = /^https?:\/\/\S+$/i;

export const MINIMAX_ALLOWED_ENDPOINTS = MODEL_VALUES.flatMap((model) =>
  TASK_VALUES
    .filter((task) => MINIMAX_VARIANTS[model].tasks[task] !== undefined)
    .map((task) => `${model}/${task}`),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMiniMaxModel(value: string): value is MiniMaxModel {
  return MODEL_VALUES.includes(value as MiniMaxModel);
}

export function minimaxTaskSupported(model: string, task: string): boolean {
  return isMiniMaxModel(model)
    && TASK_VALUES.includes(task as MiniMaxTask)
    && MINIMAX_VARIANTS[model].tasks[task as MiniMaxTask] !== undefined;
}

export function minimaxResolutions(model: string, task: string): readonly string[] {
  if (!minimaxTaskSupported(model, task)) return [];
  return MINIMAX_VARIANTS[model as MiniMaxModel].tasks[task as MiniMaxTask] ?? [];
}

export function minimaxDefaultResolution(model: string) {
  return isMiniMaxModel(model) ? MINIMAX_VARIANTS[model].defaultResolution : MINIMAX_DEFAULTS.resolution;
}

export function minimaxDefaultRatio(model: string, task: string) {
  if (task === MINIMAX_TASKS["Text to video"]) return "1:1";
  if (task === MINIMAX_TASKS["Image to video"]) return "adaptive";
  if (model === MINIMAX_MODELS["MiniMax H3 Fast"]) return "16:9";
  return "adaptive";
}

export function normalizeMiniMaxParams(params: Record<string, unknown> = {}) {
  const model: MiniMaxModel = isMiniMaxModel(String(params.model ?? ""))
    ? String(params.model) as MiniMaxModel
    : MINIMAX_DEFAULTS.model;
  const taskValue = String(params.task ?? MINIMAX_DEFAULTS.task);
  const task: MiniMaxTask = minimaxTaskSupported(model, taskValue)
    ? taskValue as MiniMaxTask
    : MINIMAX_DEFAULTS.task;
  const duration = Number(params.duration);
  const minDuration = MINIMAX_VARIANTS[model].minDuration;
  const durationValid = Number.isInteger(duration) && duration >= minDuration && duration <= 15;
  const resolutions = minimaxResolutions(model, task);
  const defaultResolution = minimaxDefaultResolution(model);
  const resolution = typeof params.resolution === "string" && resolutions.includes(params.resolution)
    ? params.resolution
    : resolutions.includes(defaultResolution) ? defaultResolution : resolutions[0] ?? defaultResolution;
  const ratioValue = String(params.ratio ?? minimaxDefaultRatio(model, task));
  const ratio = task === MINIMAX_TASKS["Image to video"]
    ? "adaptive"
    : supportedRatio(model, task, ratioValue)
      ? ratioValue
      : minimaxDefaultRatio(model, task);
  const referenceCount = Number(params.reference_image_count);
  return {
    ...MINIMAX_DEFAULTS,
    model,
    task,
    duration: durationValid ? duration : MINIMAX_DEFAULTS.duration,
    resolution,
    ratio,
    prompt_expansion: model !== MINIMAX_MODELS["MiniMax H3 Max Turbo"] && params.prompt_expansion === true,
    reference_image_count: Number.isSafeInteger(referenceCount) && referenceCount >= 1 ? referenceCount : 1,
    prediction_id: typeof params.prediction_id === "string" && PREDICTION_ID.test(params.prediction_id)
      ? params.prediction_id
      : "",
    last_status: typeof params.last_status === "string" ? params.last_status : "",
    last_output_url: typeof params.last_output_url === "string" && HTTP_URL.test(params.last_output_url)
      ? params.last_output_url
      : "",
  };
}

function describeMiniMaxMedia(value: unknown): string | null {
  if (typeof value === "string") {
    return HTTP_URL.test(value) ? value : value.startsWith("data:") ? "[local file uploaded during generation]" : null;
  }
  if (typeof File !== "undefined" && value instanceof File) return "[local file uploaded during generation]";
  if (!isRecord(value)) return null;
  if (typeof value.url === "string") return describeMiniMaxMedia(value.url);
  if (typeof value.dataUrl === "string" || value.local === true || typeof value.id === "string") {
    return "[local file uploaded during generation]";
  }
  if (typeof value.value === "string") return describeMiniMaxMedia(value.value);
  return null;
}

function resolveReferenceUrl(value: unknown, type: MiniMaxReference["type"]) {
  const url = describeMiniMaxMedia(value);
  if (!url) return null;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  return `[local ${type} uploaded during generation]`;
}

function hasMiniMaxInput(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}

function supportedRatio(model: string, task: string, ratio: string) {
  if (task === MINIMAX_TASKS["Text to video"]) return MINIMAX_RATIOS.includes(ratio as never);
  if (task !== MINIMAX_TASKS["Reference to video"]) return true;
  return model === MINIMAX_MODELS["MiniMax H3 Fast"]
    ? MINIMAX_RATIOS.includes(ratio as never)
    : ratio === "adaptive" || MINIMAX_RATIOS.includes(ratio as never);
}

export function buildMiniMaxRequest(
  node: MiniMaxNodeLike,
  resolvedInputs: MiniMaxResolvedInputs,
) {
  const rawModel = String(node.params.model ?? "");
  const rawTask = String(node.params.task ?? "");
  const rawDuration = Number(node.params.duration);
  const rawResolution = String(node.params.resolution ?? "");
  const rawRatio = String(node.params.ratio ?? "");
  const params = normalizeMiniMaxParams(node.params);
  const model = params.model;
  const task = params.task;
  const endpoint = `${model}/${task}`;
  const prompt = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  const errors: string[] = [];
  const warnings: string[] = [];
  const variant = MINIMAX_VARIANTS[model];
  const minDuration = variant.minDuration;

  if (!isMiniMaxModel(rawModel)) errors.push("Choose a supported MiniMax H3 variant.");
  if (!minimaxTaskSupported(rawModel, rawTask)) errors.push(`${variant.label} does not support ${rawTask || "this task"}.`);
  if (!minimaxTaskSupported(model, task)) errors.push(`${variant.label} does not support ${task}.`);
  if (!prompt.trim()) errors.push("A non-empty prompt is required.");
  if (!Number.isInteger(rawDuration) || rawDuration < minDuration || rawDuration > 15) {
    errors.push(`Duration must be between ${minDuration} and 15 seconds for ${variant.label}.`);
  }
  if (!minimaxResolutions(rawModel, rawTask).includes(rawResolution)) {
    errors.push("Choose a resolution supported by this model and task.");
  }
  if (rawTask === MINIMAX_TASKS["Text to video"] && rawRatio === "adaptive") {
    errors.push("Adaptive ratio is not valid for Text to video.");
  } else if (rawTask !== MINIMAX_TASKS["Image to video"]
    && !supportedRatio(rawModel, rawTask, rawRatio)) {
    errors.push("Choose a supported aspect ratio.");
  }

  const body: Record<string, unknown> = {
    model: endpoint,
    prompt,
    resolution: params.resolution,
    duration: Number(params.duration),
  };
  if (task === MINIMAX_TASKS["Text to video"]) {
    body.ratio = params.ratio;
  } else if (task === MINIMAX_TASKS["Image to video"]) {
    const image = describeMiniMaxMedia(resolvedInputs.image);
    const endImage = describeMiniMaxMedia(resolvedInputs.end_image);
    if (!image) warnings.push("A first-frame image is recommended; the Atlas schema marks it optional but its docs table marks it required.");
    else body.image = image;
    if (hasMiniMaxInput(resolvedInputs.end_image) && !endImage) {
      errors.push("The end-frame image must be a public HTTP(S) URL or a local image file.");
    }
    if (endImage) body.end_image = endImage;
  } else if (task === MINIMAX_TASKS["Reference to video"]) {
    const references = (resolvedInputs.refers ?? []).flatMap((reference) => {
      const url = resolveReferenceUrl(reference.value, reference.type);
      return url ? [{ url, type: reference.type }] : [];
    });
    if ((resolvedInputs.refers ?? []).some((reference) => !resolveReferenceUrl(reference.value, reference.type))) {
      errors.push("Each reference must be a public HTTP(S) URL or a local file.");
    }
    if (!references.some((reference) => reference.type === "image" || reference.type === "video")) {
      errors.push("At least one image or video reference is required; audio alone is not allowed.");
    }
    body.refers = references;
    body.ratio = params.ratio;
  }
  if (model !== MINIMAX_MODELS["MiniMax H3 Max Turbo"]) {
    body.prompt_expansion = params.prompt_expansion;
  }

  if (model === MINIMAX_MODELS["MiniMax H3 Fast"]) {
    warnings.push("The H3 Fast rate and Image to video schema are unverified on Atlas.");
  }
  if (model === MINIMAX_MODELS["MiniMax H3 Max"] && task !== MINIMAX_TASKS["Text to video"]) {
    warnings.push("The H3 Max schema for this task is unverified on Atlas.");
  }
  if (model === MINIMAX_MODELS["MiniMax H3 Max Turbo"] && task === MINIMAX_TASKS["Image to video"]) {
    warnings.push("The H3 Max Turbo Image to video resolution is unverified on Atlas.");
  }
  if (task === MINIMAX_TASKS["Reference to video"]
    && model !== MINIMAX_MODELS["MiniMax H3"] && model !== MINIMAX_MODELS["MiniMax H3 Fast"]) {
    warnings.push("Reference to video ratio options are unverified on Atlas for this variant.");
  }
  if (task === MINIMAX_TASKS["Reference to video"] && (resolvedInputs.refers ?? []).some((reference) => reference.type === "video")) {
    warnings.push("Input video seconds may be billed too (unverified on Atlas).");
  }
  return { model, task, endpoint, body, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function validateMiniMaxRequestBody(value: unknown) {
  if (!isRecord(value) || typeof value.model !== "string" || !MINIMAX_ALLOWED_ENDPOINTS.includes(value.model)) {
    return ["Only the supported MiniMax H3 model/task endpoints are available."];
  }
  const task = value.model.slice(value.model.lastIndexOf("/") + 1);
  const model = value.model.slice(0, value.model.lastIndexOf("/"));
  const params: Record<string, unknown> = {
    model,
    task,
    resolution: value.resolution,
    duration: value.duration,
    ratio: value.ratio,
    prompt_expansion: value.prompt_expansion,
  };
  const resolvedInputs: MiniMaxResolvedInputs = {
    prompt: value.prompt,
    image: value.image,
    end_image: value.end_image,
    refers: Array.isArray(value.refers)
      ? value.refers.filter(isRecord).flatMap((reference) =>
        (["image", "video", "audio"] as const).includes(reference.type as never)
          ? [{ type: reference.type as MiniMaxReference["type"], value: reference.url }]
          : [])
      : [],
  };
  const allowedFields = new Set(["model", "prompt", "resolution", "duration"]);
  if (task === MINIMAX_TASKS["Text to video"]) allowedFields.add("ratio");
  if (task === MINIMAX_TASKS["Image to video"]) {
    allowedFields.add("image");
    allowedFields.add("end_image");
  }
  if (task === MINIMAX_TASKS["Reference to video"]) {
    allowedFields.add("refers");
    allowedFields.add("ratio");
  }
  if (model !== MINIMAX_MODELS["MiniMax H3 Max Turbo"]) allowedFields.add("prompt_expansion");
  const errors = Object.keys(value).some((key) => !allowedFields.has(key))
    ? ["Request contains fields not supported by this MiniMax task."]
    : [];
  const built = buildMiniMaxRequest({ params }, resolvedInputs);
  errors.push(...built.errors);
  if (!minimaxResolutions(model, task).includes(String(value.resolution ?? ""))) {
    errors.push("Choose a resolution supported by this model and task.");
  }
  const minDuration = MINIMAX_VARIANTS[model as MiniMaxModel].minDuration;
  if (typeof value.duration !== "number" || !Number.isInteger(value.duration)
    || value.duration < minDuration || value.duration > 15) {
    errors.push(`Duration must be between ${minDuration} and 15 seconds for ${MINIMAX_VARIANTS[model as MiniMaxModel].label}.`);
  }
  if (task === MINIMAX_TASKS["Text to video"] && value.ratio === "adaptive") {
    errors.push("Adaptive ratio is not valid for Text to video.");
  } else if (task !== MINIMAX_TASKS["Image to video"]
    && (typeof value.ratio !== "string" || !supportedRatio(model, task, value.ratio))) {
    errors.push("Choose a supported aspect ratio.");
  }
  if (task === MINIMAX_TASKS["Image to video"] && value.image !== undefined
    && (typeof value.image !== "string" || !HTTP_URL.test(value.image))) {
    errors.push("The first-frame image must be a public HTTP(S) URL.");
  }
  if (task === MINIMAX_TASKS["Image to video"] && value.end_image !== undefined
    && (typeof value.end_image !== "string" || !HTTP_URL.test(value.end_image))) {
    errors.push("The end-frame image must be a public HTTP(S) URL.");
  }
  if (task === MINIMAX_TASKS["Reference to video"]) {
    if (!Array.isArray(value.refers)) errors.push("References must be an array.");
    else if (value.refers.some((reference) =>
      !isRecord(reference)
      || Object.keys(reference).some((key) => key !== "url" && key !== "type")
      || typeof reference.url !== "string"
      || !HTTP_URL.test(reference.url)
      || !["image", "video", "audio"].includes(String(reference.type)))) {
      errors.push("Each reference must contain a public URL and an explicit image, video, or audio type.");
    }
  }
  if (typeof value.prompt !== "string") errors.push("Prompt must be a string.");
  if (typeof value.resolution !== "string") errors.push("Resolution must be a string.");
  if (typeof value.duration !== "number") errors.push("Duration must be a number.");
  if (task !== MINIMAX_TASKS["Image to video"] && typeof value.ratio !== "string") {
    errors.push("Aspect ratio must be a string for this task.");
  }
  if (model !== MINIMAX_MODELS["MiniMax H3 Max Turbo"] && typeof value.prompt_expansion !== "boolean") {
    errors.push("Prompt expansion must be a boolean.");
  }
  return [...new Set(errors)];
}

export function validateMiniMaxUpload(file: { name: string; type: string }, kind: string) {
  if (!(kind in MINIMAX_UPLOAD_TYPES)) return ["Choose an image, video, or audio file."];
  const type = file.type.toLowerCase();
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const allowedExtensions: Record<string, string[]> = {
    image: ["png", "jpg", "jpeg", "webp"],
    video: ["mp4", "mov"],
    audio: ["mp3", "wav"],
  };
  const allowedMimes = MINIMAX_UPLOAD_TYPES[kind as keyof typeof MINIMAX_UPLOAD_TYPES];
  if (!allowedExtensions[kind].includes(extension) || !allowedMimes.has(type as never)) {
    return [`Choose a supported ${kind} file (${allowedExtensions[kind].join(", ")}).`];
  }
  return [];
}
