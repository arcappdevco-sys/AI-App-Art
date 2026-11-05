export const KLING_MODELS = {
  "Kling 4.0": "kwaivgi/kling-v4.0",
  "Kling V3.0 Pro": "kwaivgi/kling-v3.0-pro",
  "Kling V3.0 Std": "kwaivgi/kling-v3.0-std",
} as const;

export const KLING_TASKS = {
  "Text to video": "text-to-video",
  "Image to video": "image-to-video",
  "Ingredients to video": "reference-to-video",
  "Edit video": "video-edit",
} as const;

export const KLING_RATES: Record<string, number> = {
  [KLING_MODELS["Kling 4.0"]]: 0.11,
  [KLING_MODELS["Kling V3.0 Pro"]]: 0.095,
  [KLING_MODELS["Kling V3.0 Std"]]: 0.071,
};

export const KLING_DEFAULTS: Record<string, unknown> = {
  model: KLING_MODELS["Kling 4.0"],
  task: KLING_TASKS["Text to video"],
  duration: "5",
  aspect_ratio: "16:9",
  resolution: "1080p",
  sound: false,
  elements: [],
  voice_ids: [],
};

const klingModelValues = Object.values(KLING_MODELS);
const klingTaskValues = Object.values(KLING_TASKS);
const klingV3Models = new Set<string>([
  KLING_MODELS["Kling V3.0 Pro"],
  KLING_MODELS["Kling V3.0 Std"],
]);
const klingKnownFields = Object.keys(KLING_DEFAULTS);

export function normalizeKlingParams(params: Record<string, unknown> = {}) {
  const aliases: Record<string, string> = {
    Kling: KLING_MODELS["Kling 4.0"],
    "Kling 4.0": KLING_MODELS["Kling 4.0"],
    "Kling V3.0 Pro": KLING_MODELS["Kling V3.0 Pro"],
    "Kling V3.0 Std": KLING_MODELS["Kling V3.0 Std"],
  };
  const candidateModel = aliases[String(params.model ?? "")] ?? String(params.model ?? "");
  const model = klingModelValues.includes(candidateModel as (typeof klingModelValues)[number])
    ? candidateModel
    : KLING_DEFAULTS.model as string;
  const taskAliases: Record<string, string> = Object.fromEntries(
    Object.entries(KLING_TASKS).map(([label, task]) => [label, task])
  );
  const candidateTask = taskAliases[String(params.task ?? "")] ?? String(params.task ?? "");
  const allowedTasks = model === KLING_MODELS["Kling 4.0"]
    ? klingTaskValues
    : [KLING_TASKS["Text to video"], KLING_TASKS["Image to video"]];
  const task = allowedTasks.includes(candidateTask as (typeof klingTaskValues)[number])
    ? candidateTask
    : KLING_DEFAULTS.task as string;

  const normalized: Record<string, unknown> = { ...KLING_DEFAULTS };
  for (const key of klingKnownFields) {
    if (params[key] !== undefined) normalized[key] = params[key];
  }
  normalized.model = model;
  normalized.task = task;
  normalized.duration = klingV3Models.has(model)
    ? Number.isInteger(Number(params.duration)) && Number(params.duration) >= 3 && Number(params.duration) <= 15
      ? String(params.duration)
      : "5"
    : Number.isInteger(Number(params.duration)) && Number(params.duration) >= 3 && Number(params.duration) <= 30
      ? String(params.duration)
      : KLING_DEFAULTS.duration;
  const ratioOptions = klingV3Models.has(model)
    ? ["16:9", "9:16", "1:1"]
    : task === KLING_TASKS["Ingredients to video"]
      ? ["Auto", "16:9", "9:16", "1:1", "21:9"]
      : ["16:9", "9:16", "1:1", "21:9"];
  normalized.aspect_ratio = ratioOptions.includes(String(params.aspect_ratio))
    ? params.aspect_ratio
    : task === KLING_TASKS["Ingredients to video"] ? "Auto" : "16:9";
  normalized.resolution = ["720p", "1080p", "1080p-esr", "2k-esr", "4k-esr"].includes(String(params.resolution))
    ? params.resolution
    : KLING_DEFAULTS.resolution;
  normalized.sound = params.sound === true;
  normalized.elements = Array.isArray(params.elements) ? params.elements.slice(0, 7) : [];
  normalized.voice_ids = Array.isArray(params.voice_ids)
    ? params.voice_ids.filter((voice): voice is string => typeof voice === "string").slice(0, 3)
    : [];
  return normalized;
}

type KlingNodeLike = { params: Record<string, unknown> };
type KlingConnectedInputs = Record<string, unknown>;

const klingAsArray = (value: unknown) =>
  value == null ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];

function klingValidateMediaUrl(value: unknown, label: string, extensions: string[]) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required.`);
  const dataMime = value.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();
  if (dataMime) {
    const supported = extensions.some((extension) => {
      if (extension === "jpg" || extension === "jpeg") return dataMime === "image/jpeg";
      if (extension === "png") return dataMime === "image/png";
      if (extension === "mp4") return dataMime === "video/mp4";
      if (extension === "mov") return dataMime === "video/quicktime";
      return false;
    });
    if (!supported) throw new Error(`${label} must use ${extensions.join(", ").toUpperCase()}.`);
    const base64 = value.match(/^data:[^,]*;base64,(.*)$/)?.[1];
    if (base64 && Math.floor(base64.length * 3 / 4) > (extensions.includes("mp4") || extensions.includes("mov") ? 300 : 30) * 1024 * 1024) {
      throw new Error(`${label} exceeds the supported file size.`);
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a URL ending in ${extensions.join(", ").toUpperCase()}.`);
  }
  const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const validExtension = Boolean(extension && extensions.includes(extension));
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const octets = host.split(".").map(Number);
  const privateIpv4 = octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    && (octets[0] === 0 || octets[0] === 10 || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] >= 224);
  if (!["http:", "https:"].includes(url.protocol)
    || !validExtension
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || privateIpv4
    || host === "[::]"
    || host === "[::1]"
    || host.startsWith("[fc")
    || host.startsWith("[fd")) {
    throw new Error(`${label} must be a public URL ending in ${extensions.join(", ").toUpperCase()}.`);
  }
}

function klingValidateImage(value: unknown, label: string) {
  klingValidateMediaUrl(value, label, ["jpg", "jpeg", "png"]);
  if (typeof value !== "string" || !value.startsWith("data:")) return;
  const encoded = value.match(/^data:[^,]*;base64,(.*)$/)?.[1];
  if (!encoded) return;
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  let width = 0;
  let height = 0;
  if (value.startsWith("data:image/png")) {
    width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  } else {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        break;
      }
      if (size < 2) break;
      offset += size + 2;
    }
  }
  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (width < 300 || height < 300 || ratio < 0.4 || ratio > 2.5) {
      throw new Error(`${label} must be at least 300 px on each side with a 2:5 to 5:2 aspect ratio.`);
    }
  } else {
    throw new Error(`${label} dimensions could not be verified.`);
  }
}

function klingValidateVideo(value: unknown, label: string) {
  klingValidateMediaUrl(value, label, ["mp4", "mov"]);
}

function klingValidateSubject(subject: unknown, index: number, metadata: unknown) {
  if (!subject || typeof subject !== "object") throw new Error(`Subject ${index + 1} is invalid.`);
  const item = subject as Record<string, unknown>;
  if (item.kind === "existing") {
    const id = String(item.id ?? "");
    const normalizedId = id.replace(/^0+(?=\d)/, "");
    if (!/^\d+$/.test(id) || normalizedId.length > 20
      || normalizedId.length === 20 && normalizedId > "18446744073709551615"
      || Number(normalizedId) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Subject ${index + 1} ID must be a safely representable integer.`);
    }
    if (item.name) throw new Error(`Existing subject ${index + 1} cannot also have a name.`);
    return;
  }
  if (item.kind !== "new") throw new Error(`Subject ${index + 1} must be existing or new.`);
  const name = String(item.name ?? "");
  const description = String(item.description ?? "");
  if (!name || name.length > 20) throw new Error(`Subject ${index + 1} name must be 1 to 20 characters.`);
  if (description.length > 100) throw new Error(`Subject ${index + 1} description must be 100 characters or fewer.`);
  if (item.type === "image") {
    const images = klingAsArray(item.extra_images);
    if (images.length < 1 || images.length > 3) throw new Error(`Subject ${index + 1} needs 1 to 3 extra images.`);
    klingValidateImage(item.frontal_image, `Subject ${index + 1} frontal image`);
    images.forEach((image, imageIndex) => klingValidateImage(image, `Subject ${index + 1} image ${imageIndex + 1}`));
  } else if (item.type === "video") {
    klingValidateVideo(item.reference_video, `Subject ${index + 1} reference video`);
    const durations = metadata as Record<string, unknown> | undefined;
    const duration = Number(durations?.[String(index)]);
    if (Number.isFinite(duration) && (duration < 3 || duration > 8)) {
      throw new Error(`Video character subject ${index + 1} video must be 3 to 8 seconds.`);
    }
  } else {
    throw new Error(`Subject ${index + 1} must be Image-based or a Video character.`);
  }
}

export function buildKlingRequest(node: KlingNodeLike, connectedInputs: KlingConnectedInputs) {
  const rawModel = String(node.params.model ?? KLING_DEFAULTS.model);
  const rawTask = String(node.params.task ?? KLING_DEFAULTS.task);
  if (!klingModelValues.includes(rawModel as (typeof klingModelValues)[number])) {
    throw new Error("Choose a valid Kling model.");
  }
  if (!klingTaskValues.includes(rawTask as (typeof klingTaskValues)[number])) {
    throw new Error("Choose a valid Kling task.");
  }
  if (klingV3Models.has(rawModel)
    && ![KLING_TASKS["Text to video"], KLING_TASKS["Image to video"]].includes(rawTask as never)) {
    throw new Error("This Kling model does not support the selected task.");
  }
  const rawDuration = Number(node.params.duration ?? KLING_DEFAULTS.duration);
  if (!Number.isInteger(rawDuration)
    || (klingV3Models.has(rawModel) ? rawDuration < 3 || rawDuration > 15 : rawDuration < 3 || rawDuration > 30)) {
    throw new Error(klingV3Models.has(rawModel)
      ? "V3.0 duration must be between 3 and 15 seconds."
      : "Duration must be a whole number from 3 to 30 seconds.");
  }
  if (rawTask !== KLING_TASKS["Image to video"] && rawTask !== KLING_TASKS["Edit video"]) {
    const rawRatio = String(node.params.aspect_ratio
      ?? (rawTask === KLING_TASKS["Ingredients to video"] ? "Auto" : KLING_DEFAULTS.aspect_ratio));
    const allowedRatios = klingV3Models.has(rawModel)
      ? ["16:9", "9:16", "1:1"]
      : rawTask === KLING_TASKS["Ingredients to video"]
        ? ["Auto", "16:9", "9:16", "1:1", "21:9"]
        : ["16:9", "9:16", "1:1", "21:9"];
    if (!allowedRatios.includes(rawRatio)) throw new Error("Choose an aspect ratio supported by this Kling task.");
  }
  if (!klingV3Models.has(rawModel)
    && !["720p", "1080p", "1080p-esr", "2k-esr", "4k-esr"].includes(String(node.params.resolution ?? KLING_DEFAULTS.resolution))) {
    throw new Error("Choose a supported Kling 4.0 resolution.");
  }
  const rawElements = Array.isArray(node.params.elements) ? node.params.elements : [];
  const rawVoices = Array.isArray(node.params.voice_ids) ? node.params.voice_ids : [];
  if (rawElements.length > 7) throw new Error("Up to 7 subjects are supported.");
  if (rawVoices.length > 3) throw new Error("Up to 3 Voice IDs are supported.");

  const params = normalizeKlingParams(node.params);
  const model = String(params.model);
  const task = String(params.task);
  const isV3 = klingV3Models.has(model);
  const isImageTask = task === KLING_TASKS["Image to video"];
  const prompt = String(connectedInputs.prompt ?? "");
  const duration = Number(params.duration);
  const elements = rawElements;
  const voiceIds = rawVoices;
  const images = klingAsArray(connectedInputs.reference_images);
  const middleImages = klingAsArray(connectedInputs.middle_images);
  const references = klingAsArray(connectedInputs.reference_videos);

  if (!klingModelValues.includes(model as (typeof klingModelValues)[number])) {
    throw new Error("Choose a valid Kling model.");
  }
  const availableTasks = isV3
    ? [KLING_TASKS["Text to video"], KLING_TASKS["Image to video"]]
    : klingTaskValues;
  if (!availableTasks.includes(task as (typeof availableTasks)[number])) {
    throw new Error("This Kling model does not support the selected task.");
  }
  if (task !== KLING_TASKS["Image to video"] && !prompt.trim()) {
    throw new Error("Connect a prompt for this task.");
  }
  const promptLimit = isV3 ? 2500 : /[^\u0000-\u007f]/.test(prompt) ? 11000 : 26000;
  if (prompt.length > promptLimit) {
    throw new Error(`Prompt must be ${promptLimit.toLocaleString()} characters or fewer.`);
  }
  if (!Number.isInteger(duration) || (isV3 ? duration < 3 || duration > 15 : duration < 3 || duration > 30)) {
    throw new Error(isV3 ? "V3.0 duration must be between 3 and 15 seconds." : "Duration must be a whole number from 3 to 30 seconds.");
  }
  if (isV3 && middleImages.length > 0) throw new Error("V3.0 does not support middle keyframes.");
  if (elements.length > 7) throw new Error("Up to 7 subjects are supported.");
  if (voiceIds.length > 3 || voiceIds.some((voice) => typeof voice !== "string" || !voice.trim())) {
    throw new Error("Up to 3 non-empty Voice IDs are supported.");
  }
  const videoSubjects = elements.filter((subject) =>
    Boolean(subject && typeof subject === "object" && (subject as Record<string, unknown>).kind === "new"
      && (subject as Record<string, unknown>).type === "video")
  );
  if (videoSubjects.length > 3) throw new Error("Up to 3 Video character subjects are supported.");
  if (task !== KLING_TASKS["Ingredients to video"] && task !== KLING_TASKS["Edit video"]
    && (elements.length > 0 || voiceIds.length > 0)) {
    throw new Error("Subjects and Voice IDs are only supported by Ingredients or Edit.");
  }
  elements.forEach((subject, index) =>
    klingValidateSubject(subject, index, connectedInputs.subject_video_durations)
  );

  const ratio = String(params.aspect_ratio);
  const ratioOptions = isV3
    ? ["16:9", "9:16", "1:1"]
    : task === KLING_TASKS["Ingredients to video"]
      ? ["Auto", "16:9", "9:16", "1:1", "21:9"]
      : ["16:9", "9:16", "1:1", "21:9"];
  if (task !== KLING_TASKS["Image to video"] && task !== KLING_TASKS["Edit video"]
    && !ratioOptions.includes(ratio)) {
    throw new Error("Choose an aspect ratio supported by this Kling task.");
  }
  const resolution = String(params.resolution);
  if (!isV3 && !["720p", "1080p", "1080p-esr", "2k-esr", "4k-esr"].includes(resolution)) {
    throw new Error("Choose a supported Kling 4.0 resolution.");
  }

  const firstFrame = connectedInputs.image;
  const lastFrame = isV3 ? connectedInputs.end_image : connectedInputs.last_image;
  if (isV3 && connectedInputs.last_image) throw new Error("V3.0 stores the last frame as end_image.");
  if (!isV3 && connectedInputs.end_image) throw new Error("Kling 4.0 stores the last frame as last_image.");
  if (isImageTask && !firstFrame) throw new Error("Image to video requires a connected first frame.");
  const keyframeCount = Number(Boolean(firstFrame)) + middleImages.length + Number(Boolean(lastFrame));
  if (keyframeCount > 10 || keyframeCount + images.length > 10) {
    throw new Error("Image keyframes and references are limited to 10 total.");
  }
  if (firstFrame) klingValidateImage(firstFrame, "First frame");
  if (lastFrame) klingValidateImage(lastFrame, "Last frame");
  middleImages.forEach((image, index) => klingValidateImage(image, `Middle keyframe ${index + 1}`));
  if (images.length > 10) throw new Error("Up to 10 reference images are supported.");
  images.forEach((image, index) => klingValidateImage(image, `Reference image ${index + 1}`));
  if (task === KLING_TASKS["Image to video"] && middleImages.length > 8) {
    throw new Error("Image to video supports up to 8 middle keyframes.");
  }
  if (task !== KLING_TASKS["Image to video"] && task !== KLING_TASKS["Ingredients to video"]
    && (firstFrame || middleImages.length || lastFrame)) {
    throw new Error("Keyframes are only supported by Image to video or Ingredients to video.");
  }

  const sourceVideo = connectedInputs.video;
  const referenceVideos = [
    ...references,
    ...["reference_video_1", "reference_video_2", "reference_video_3", "reference_video_4", "reference_video_5"]
      .map((key) => connectedInputs[key]).filter(Boolean),
  ];
  const inputVideoDurations = Array.isArray(connectedInputs.reference_video_durations)
    ? connectedInputs.reference_video_durations.map(Number)
    : [];
  if (referenceVideos.length > (task === KLING_TASKS["Edit video"] ? 4 : 5)) {
    throw new Error(`This Kling task supports at most ${task === KLING_TASKS["Edit video"] ? 4 : 5} reference videos.`);
  }
  referenceVideos.forEach((video, index) => klingValidateVideo(video, `Reference video ${index + 1}`));
  if (inputVideoDurations.some((seconds) => seconds < 3 || seconds > 30)
    || inputVideoDurations.length > 0 && inputVideoDurations.reduce((sum, seconds) => sum + seconds, 0) > 30) {
    throw new Error("Reference videos must each be 3 to 30 seconds, with 30 seconds combined.");
  }
  const sourceDuration = Number(connectedInputs.source_video_duration);
  if (task === KLING_TASKS["Edit video"]) {
    klingValidateVideo(sourceVideo, "Source video");
    if (Number.isFinite(sourceDuration) && (sourceDuration < 3 || sourceDuration > 30)) {
      throw new Error("Source video must be 3 to 30 seconds.");
    }
    if (task !== KLING_TASKS["Edit video"] && sourceVideo) {
      throw new Error("A source video is only accepted for Edit video.");
    }
  }
  const referenceVideoDimensions = Array.isArray(connectedInputs.reference_video_dimensions)
    ? connectedInputs.reference_video_dimensions as Array<{ width?: unknown; height?: unknown }>
    : [];
  const sourceWidth = Number(connectedInputs.source_video_width);
  const sourceHeight = Number(connectedInputs.source_video_height);
  const dimensionList = [
    ...(task === KLING_TASKS["Edit video"] ? [{ width: sourceWidth, height: sourceHeight, label: "Source video" }] : []),
    ...referenceVideoDimensions.map((dimension, index) => ({
      width: Number(dimension.width),
      height: Number(dimension.height),
      label: `Reference video ${index + 1}`,
    })),
  ];
  dimensionList.forEach(({ width, height, label }) => {
    if (Number.isFinite(width) && Number.isFinite(height)
      && (width < 700 || width > 4553 || height < 700 || height > 4553)) {
      throw new Error(`${label} dimensions must be between 700 and 4553 px.`);
    }
  });
  if (task === KLING_TASKS["Ingredients to video"] && images.length === 0 && referenceVideos.length === 0 && elements.length === 0) {
    throw new Error("Ingredients to video requires references or subjects.");
  }
  if (task !== KLING_TASKS["Ingredients to video"] && task !== KLING_TASKS["Edit video"]
    && (images.length > 0 || referenceVideos.length > 0 || elements.length > 0 || voiceIds.length > 0)) {
    throw new Error("References, subjects, and Voice IDs are only supported by Ingredients or Edit.");
  }

  const body: Record<string, unknown> = { duration, ...(prompt ? { prompt } : {}) };
  if (task !== KLING_TASKS["Image to video"] && task !== KLING_TASKS["Edit video"]) {
    body.aspect_ratio = ratio;
  }
  if (!isV3) body.resolution = resolution;
  body.model = `${model}/${task}`;
  if (isV3) body.sound = params.sound === true;
  if (isImageTask) {
    body.image = firstFrame;
    if (middleImages.length) body.middle_images = middleImages;
    if (lastFrame) body[isV3 ? "end_image" : "last_image"] = lastFrame;
  }
  if (task === KLING_TASKS["Ingredients to video"] || task === KLING_TASKS["Edit video"]) {
    if (task === KLING_TASKS["Ingredients to video"]) {
      if (images.length) body.reference_images = images;
      if (task === KLING_TASKS["Ingredients to video"] && firstFrame) body.image = firstFrame;
      if (middleImages.length) body.middle_images = middleImages;
      if (lastFrame) body.last_image = lastFrame;
      if (ratio === "Auto") body.aspect_ratio = "auto";
    } else {
      body.video = sourceVideo;
    }
    if (referenceVideos.length) body.reference_videos = referenceVideos;
    if (elements.length) {
      body.elements = elements.map((subject) => {
        const item = subject as Record<string, unknown>;
        if (item.kind === "existing") return { element_id: Number(item.id) };
        if (item.type === "video") {
          return {
            element_name: item.name,
            element_description: item.description,
            reference_type: "video_refer",
            refer_videos: [item.reference_video],
          };
        }
        return {
          element_name: item.name,
          element_description: item.description,
          reference_type: "image_refer",
          frontal_image: item.frontal_image,
          refer_images: item.extra_images,
        };
      });
    }
    if (voiceIds.length) body.voice_ids = voiceIds;
  }
  return { model: `${model}/${task}`, task, body };
}
