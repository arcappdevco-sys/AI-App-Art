export const OMNI_MODELS = {
  "Gemini Omni 1.2 Flash": "google/gemini-omni-1.2-flash",
  "Gemini Omni 1.1 Flash": "google/gemini-omni-1.1-flash",
  "Gemini Omni Flash (original)": "google/gemini-omni-flash",
} as const;

export const OMNI_TASKS = {
  "Text to video": "text-to-video",
  "Image to video": "image-to-video",
  "Ingredients to video": "reference-to-video",
  "Edit video": "video-edit",
  "Extend video": "video-extend",
} as const;

export const OMNI_RATES: Record<string, Record<string, number>> = {
  [OMNI_MODELS["Gemini Omni 1.2 Flash"]]: {
    "text-to-video": 0.023,
    "image-to-video": 0.023,
    "reference-to-video": 0.023,
    "video-edit": 0.023,
    "video-extend": 0.023,
  },
  [OMNI_MODELS["Gemini Omni 1.1 Flash"]]: {
    "text-to-video": 0.037,
    "image-to-video": 0.039,
    "reference-to-video": 0.037,
    "video-edit": 0.037,
    "video-extend": 0.037,
  },
  [OMNI_MODELS["Gemini Omni Flash (original)"]]: {
    "text-to-video": 0.125,
    "image-to-video": 0.13,
    "reference-to-video": 0.135,
    "video-edit": 0.14,
  },
};

export const OMNI_DEFAULTS: Record<string, unknown> = {
  model: OMNI_MODELS["Gemini Omni Flash (original)"],
  task: OMNI_TASKS["Text to video"],
  duration: "10",
  aspect_ratio: "16:9",
  resolution: "720p",
  thinking_level: "default",
  seed: -1,
  variations: "1",
};

const omniKnownFields = Object.keys(OMNI_DEFAULTS);
const omniTaskValues = Object.values(OMNI_TASKS);

export function normalizeOmniParams(params: Record<string, unknown> = {}) {
  const savedModel = String(params.model ?? "");
  const modelAliases: Record<string, string> = {
    "Gemini Omni 1.1 Flash": OMNI_MODELS["Gemini Omni 1.1 Flash"],
    "Gemini Omni 1.2 Flash": OMNI_MODELS["Gemini Omni 1.2 Flash"],
    "Gemini Omni Flash": OMNI_MODELS["Gemini Omni Flash (original)"],
    "Gemini Omni Flash (original)": OMNI_MODELS["Gemini Omni Flash (original)"],
  };
  const model = Object.values(OMNI_MODELS).includes(
    (modelAliases[savedModel] ?? savedModel) as (typeof OMNI_MODELS)[keyof typeof OMNI_MODELS]
  )
    ? modelAliases[savedModel] ?? savedModel
    : OMNI_DEFAULTS.model as string;
  const legacyTasks: Record<string, string> = Object.fromEntries(
    Object.entries(OMNI_TASKS).map(([label, value]) => [label, value])
  );
  const savedTask = legacyTasks[String(params.task)] ?? String(params.task ?? "");
  const allowedTasks = model === OMNI_MODELS["Gemini Omni Flash (original)"]
    ? omniTaskValues.filter((task) => task !== OMNI_TASKS["Extend video"])
    : omniTaskValues;
  const task = allowedTasks.includes(savedTask as (typeof omniTaskValues)[number])
    ? savedTask
    : OMNI_DEFAULTS.task as string;

  const normalized: Record<string, unknown> = { ...OMNI_DEFAULTS };
  for (const key of omniKnownFields) {
    if (params[key] !== undefined) normalized[key] = params[key];
  }
  normalized.model = model;
  normalized.task = task;
  const maxDuration = model === OMNI_MODELS["Gemini Omni 1.2 Flash"]
    && task !== OMNI_TASKS["Extend video"] ? 15 : 10;
  const savedDuration = Number(params.duration);
  normalized.duration = Number.isInteger(savedDuration) && savedDuration >= 3 && savedDuration <= maxDuration
    ? String(params.duration)
    : OMNI_DEFAULTS.duration;
  normalized.aspect_ratio = ["16:9", "9:16"].includes(String(params.aspect_ratio))
    ? params.aspect_ratio
    : OMNI_DEFAULTS.aspect_ratio;
  const validResolutions = model === OMNI_MODELS["Gemini Omni Flash (original)"]
    ? ["720p"]
    : ["360p", "720p", "1080p", "4k"];
  normalized.resolution = validResolutions.includes(String(params.resolution))
    ? params.resolution
    : OMNI_DEFAULTS.resolution;
  normalized.thinking_level = ["low", "default", "high"].includes(String(params.thinking_level))
    ? params.thinking_level
    : OMNI_DEFAULTS.thinking_level;
  const seed = params.seed === "" || params.seed == null ? -1 : Number(params.seed);
  normalized.seed = Number.isInteger(seed) && seed >= -1 ? seed : -1;
  normalized.variations = ["1", "2", "3", "4"].includes(String(params.variations))
    ? String(params.variations)
    : OMNI_DEFAULTS.variations;
  return normalized;
}

type OmniNodeLike = { params: Record<string, unknown> };
type OmniConnectedInputs = Record<string, unknown>;

const omniInputArray = (value: unknown) =>
  value == null ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];

function omniValidatePublicMp4(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a public MP4 URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipv4 = host.split(".").map(Number);
  const isPrivateIpv4 = ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127
      || (ipv4[0] === 169 && ipv4[1] === 254)
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168)
      || (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127)
      || (ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19))
      || ipv4[0] >= 224);
  const isPrivateIpv6 = host === "[::]" || host === "[::1]" || host.startsWith("[fc") || host.startsWith("[fd")
    || /^\[fe[89ab]/i.test(host);
  if (!["http:", "https:"].includes(url.protocol)
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || isPrivateIpv4
    || isPrivateIpv6) {
    throw new Error(`${label} must be a public MP4 URL.`);
  }
}

function omniValidateImages(images: unknown[], maxCount: number) {
  if (images.length > maxCount) throw new Error(`This model supports up to ${maxCount} reference images.`);
  for (const image of images) {
    if (typeof image !== "string") throw new Error("Reference images must be image URLs.");
    const dataMime = image.match(/^data:(image\/[^;,]+)/i)?.[1]?.toLowerCase();
    const path = dataMime ? "" : (() => {
      try { return new URL(image).pathname; } catch { return ""; }
    })();
    if (dataMime && !["image/png", "image/jpeg", "image/webp"].includes(dataMime)) {
      throw new Error("Images must be PNG, JPEG, JPG, or WebP; HEIC is not supported.");
    }
    const extension = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (extension && !["png", "jpg", "jpeg", "webp"].includes(extension)) {
      throw new Error("Images must be PNG, JPEG, JPG, or WebP; HEIC is not supported.");
    }
    const base64 = image.match(/^data:[^,]*;base64,(.*)$/)?.[1];
    if (base64 && Math.floor(base64.length * 3 / 4) > 20 * 1024 * 1024) {
      throw new Error("Each image must be 20 MB or smaller.");
    }
  }
}

export function buildOmniRequest(node: OmniNodeLike, connectedInputs: OmniConnectedInputs) {
  const savedModel = String(node.params.model ?? OMNI_DEFAULTS.model);
  const rawModel = Object.entries(OMNI_MODELS).find(([label]) => label === savedModel)?.[1] ?? savedModel;
  const rawTask = String(node.params.task ?? OMNI_DEFAULTS.task);
  if (!Object.values(OMNI_MODELS).includes(rawModel as (typeof OMNI_MODELS)[keyof typeof OMNI_MODELS])) {
    throw new Error("Choose a valid Gemini Omni model.");
  }
  if (!omniTaskValues.includes(rawTask as (typeof omniTaskValues)[number])) {
    throw new Error("Choose a valid Gemini Omni task.");
  }
  if (rawModel === OMNI_MODELS["Gemini Omni Flash (original)"]
    && rawTask === OMNI_TASKS["Extend video"]) {
    throw new Error("Gemini Omni Flash (original) does not support Extend video.");
  }
  const rawDuration = Number(node.params.duration ?? OMNI_DEFAULTS.duration);
  const maxDuration = rawModel === OMNI_MODELS["Gemini Omni 1.2 Flash"]
    && rawTask !== OMNI_TASKS["Extend video"] ? 15 : 10;
  if (!Number.isInteger(rawDuration) || rawDuration < 3 || rawDuration > maxDuration) {
    throw new Error(`Duration must be a whole number from 3 to ${maxDuration} seconds.`);
  }
  const rawResolution = String(node.params.resolution ?? OMNI_DEFAULTS.resolution);
  const supportedResolutions = rawModel === OMNI_MODELS["Gemini Omni Flash (original)"]
    ? ["720p"]
    : ["360p", "720p", "1080p", "4k"];
  if (!supportedResolutions.includes(rawResolution)) {
    throw new Error("The selected resolution is not available for this Gemini Omni model.");
  }
  const rawVariations = Number(node.params.variations ?? OMNI_DEFAULTS.variations);
  if (!Number.isInteger(rawVariations) || rawVariations < 1 || rawVariations > 4) {
    throw new Error("Variations must be between 1 and 4.");
  }
  const rawAspectRatio = String(node.params.aspect_ratio ?? OMNI_DEFAULTS.aspect_ratio);
  if (!["16:9", "9:16"].includes(rawAspectRatio)) throw new Error("Choose a valid aspect ratio.");
  const rawThinkingLevel = String(node.params.thinking_level ?? OMNI_DEFAULTS.thinking_level);
  if (!["low", "default", "high"].includes(rawThinkingLevel)) throw new Error("Choose a valid thinking level.");
  const rawSeed = node.params.seed === "" || node.params.seed == null ? -1 : Number(node.params.seed);
  if (!Number.isInteger(rawSeed) || rawSeed < -1) throw new Error("Seed must be an integer or -1 for random.");

  const params = normalizeOmniParams({ ...node.params, model: rawModel });
  const model = String(params.model);
  const task = String(params.task);
  const duration = Number(params.duration);
  const variations = Number(params.variations);
  const original = model === OMNI_MODELS["Gemini Omni Flash (original)"];
  const prompt = String(connectedInputs.prompt ?? "");

  if (!Object.values(OMNI_MODELS).includes(model as (typeof OMNI_MODELS)[keyof typeof OMNI_MODELS])) {
    throw new Error("Choose a valid Gemini Omni model.");
  }
  if (!omniTaskValues.includes(task as (typeof omniTaskValues)[number])) {
    throw new Error("Choose a valid Gemini Omni task.");
  }
  if (!prompt.trim()) throw new Error("Connect a prompt.");
  if (prompt.length > 20000) throw new Error("Prompt must be 20,000 characters or fewer.");
  if (!Number.isInteger(duration) || duration < 3 || duration > maxDuration) {
    throw new Error(`Duration must be a whole number from 3 to ${maxDuration} seconds.`);
  }
  if (!Number.isInteger(variations) || variations < 1 || variations > 4) {
    throw new Error("Variations must be between 1 and 4.");
  }

  const resolution = String(params.resolution);
  const validResolutions = original ? ["360p", "720p"] : ["360p", "720p", "1080p", "4k"];
  const modelResolutions = original ? ["720p"] : validResolutions;
  if (!modelResolutions.includes(resolution)) {
    throw new Error("The selected resolution is not available for this Gemini Omni model.");
  }
  if (!["16:9", "9:16"].includes(String(params.aspect_ratio))) {
    throw new Error("Choose a valid aspect ratio.");
  }
  if (!["low", "default", "high"].includes(String(params.thinking_level))) {
    throw new Error("Choose a valid thinking level.");
  }
  const seedValue = params.seed === "" || params.seed == null ? -1 : Number(params.seed);
  if (!Number.isInteger(seedValue) || seedValue < -1) throw new Error("Seed must be an integer or -1 for random.");

  const body: Record<string, unknown> = {
    prompt,
    duration,
    resolution,
    thinking_level: params.thinking_level,
    seed: seedValue,
    variations,
  };
  if (!original && task === OMNI_TASKS["Edit video"]) {
    delete body.duration;
    delete body.resolution;
  }
  if (task !== OMNI_TASKS["Edit video"] && task !== OMNI_TASKS["Extend video"]) {
    body.aspect_ratio = params.aspect_ratio;
  }

  if (task === OMNI_TASKS["Image to video"]) {
    if (!connectedInputs.image) throw new Error("Image to video requires a connected first frame.");
    omniValidateImages([connectedInputs.image], 1);
    body.image = connectedInputs.image;
    if (connectedInputs.last_image && !original) {
      if (model === OMNI_MODELS["Gemini Omni 1.2 Flash"] && duration > 10) {
        throw new Error("A last frame requires a duration of 10 seconds or less.");
      }
      omniValidateImages([connectedInputs.last_image], 1);
      body.last_image = connectedInputs.last_image;
    }
  }

  const referenceImages = omniInputArray(connectedInputs.reference_images);
  const referenceVideos = [
    connectedInputs.reference_video_1,
    connectedInputs.reference_video_2,
    connectedInputs.reference_video_3,
  ].filter(Boolean);
  if (task === OMNI_TASKS["Ingredients to video"]) {
    if (referenceImages.length === 0 && referenceVideos.length === 0) {
      throw new Error("Ingredients to video requires at least one reference image or video.");
    }
    omniValidateImages(referenceImages, original ? 5 : 10);
    if (referenceVideos.length > 3) throw new Error("Up to 3 reference videos are supported.");
    if (model === OMNI_MODELS["Gemini Omni 1.2 Flash"] && duration > 10 && referenceVideos.length > 1) {
      throw new Error("Durations over 10 seconds support at most one reference video.");
    }
    if (original && referenceVideos.length > 0) {
      throw new Error("Gemini Omni Flash (original) does not support reference videos.");
    }
    referenceVideos.forEach((video, index) => omniValidatePublicMp4(video, `Reference video ${index + 1}`));
    const referenceDurations = Array.isArray(connectedInputs.reference_video_durations)
      ? connectedInputs.reference_video_durations
      : [];
    if (referenceDurations.some((duration) => Number(duration) > 3)) {
      throw new Error("Reference videos must be 3 seconds or shorter.");
    }
    if (referenceImages.length > 0) body[original ? "images" : "reference_images"] = referenceImages;
    if (referenceVideos.length > 0) body.reference_videos = referenceVideos;
  }

  if (task === OMNI_TASKS["Edit video"] || task === OMNI_TASKS["Extend video"]) {
    omniValidatePublicMp4(connectedInputs.video, "Source video");
    const sourceDuration = Number(connectedInputs.source_duration_seconds);
    if (model === OMNI_MODELS["Gemini Omni 1.1 Flash"] && sourceDuration > 10) {
      throw new Error("Gemini Omni 1.1 source videos must be 10 seconds or shorter.");
    }
    if (model === OMNI_MODELS["Gemini Omni 1.2 Flash"] && task === OMNI_TASKS["Edit video"]
      && sourceDuration > 0 && (sourceDuration < 3 || sourceDuration > 15)) {
      throw new Error("Gemini Omni 1.2 edit sources must be 3 to 15 seconds long.");
    }
    body.video = connectedInputs.video;
    if (referenceImages.length > 0) {
      omniValidateImages(referenceImages, original ? 5 : 10);
      body[original ? "images" : "reference_images"] = referenceImages;
    }
  }
  if (model === OMNI_MODELS["Gemini Omni 1.1 Flash"] && task === OMNI_TASKS["Extend video"]) {
    const chainDuration = Number(connectedInputs.chain_duration_seconds);
    if (Number.isFinite(chainDuration) && chainDuration > 0 && chainDuration + duration > 40) {
      throw new Error("The extended video chain must not exceed 40 seconds.");
    }
  }

  return { model: `${model}/${task}`, task, body };
}
