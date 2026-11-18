export const WAN_NODE_TYPE = "video/wan-3.0";

export const WAN_MODELS = {
  "Wan 3.0": "alibaba/wan-3.0",
  "Wan 3.0 Prime": "alibaba/wan-3.0-prime",
} as const;

export const WAN_TASKS = {
  "Text to video": "text-to-video",
  "Image to video": "image-to-video",
  "Reference to video": "reference-to-video",
} as const;

export const WAN_MIN_DURATION_SECONDS = 2;
export const WAN_MAX_DURATION_SECONDS = 30;

export const WAN_RESOLUTIONS = [
  { value: "480p", group: "Native" },
  { value: "720p", group: "Native" },
  { value: "1080p", group: "Native" },
  { value: "720p-esr", group: "Enhanced (upscaled, costs more)" },
  { value: "1080p-esr", group: "Enhanced (upscaled, costs more)" },
  { value: "1440p-esr", group: "Enhanced (upscaled, costs more)" },
  { value: "4k-esr", group: "Enhanced (upscaled, costs more)" },
] as const;

export const WAN_RATES: Record<string, number> = {
  [WAN_MODELS["Wan 3.0"]]: 0.04,
  [WAN_MODELS["Wan 3.0 Prime"]]: 0.061,
};

export const WAN_CONFIRM_ABOVE_USD = 1.0;
export const WAN_DEFAULTS = {
  model: WAN_MODELS["Wan 3.0"],
  task: WAN_TASKS["Text to video"],
  duration: 5,
  resolution: "1080p",
  ratio: "adaptive",
  audio: true,
  seed: -1,
  enable_thinking: false,
  reference_count: 3,
  file: null,
  link: "",
  prediction_id: "",
  last_status: "",
  last_output_url: "",
} as const;

const MODEL_VALUES = Object.values(WAN_MODELS);
const TASK_VALUES = Object.values(WAN_TASKS);
const RESOLUTION_VALUES = WAN_RESOLUTIONS.map(({ value }) => value);
const RATIOS = ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/bmp", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime"]);
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3"]);
const DOCUMENT_EXTENSIONS = new Set([
  "docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "txt", "key", "pages", "numbers", "md",
]);
const PREDICTION_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const LOCAL_MEDIA_PLACEHOLDER = "[local file uploaded during generation]";

export type WanStoredFile = {
  id: string;
  name: string;
  type: string;
  size: number;
};

export type WanReferenceInput = {
  type: "image" | "video" | "audio";
  value: unknown;
  seconds?: number;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
};

export type WanResolvedInputs = {
  prompt?: unknown;
  image?: unknown;
  last_image?: unknown;
  references?: WanReferenceInput[];
  referenceVideoSeconds?: number;
  referenceAudioSeconds?: number;
  file?: unknown;
};

type WanNodeLike = { params: Record<string, unknown> };
type MediaKind = "image" | "video" | "audio" | "document";
type MediaDescription = {
  value: string;
  local: boolean;
  type?: string;
  size?: number;
  name?: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wanModelAlias(value: unknown) {
  const aliases: Record<string, string> = {
    "Wan 3.0": WAN_MODELS["Wan 3.0"],
    "Wan 3.0 Prime": WAN_MODELS["Wan 3.0 Prime"],
    "wan-3.0": WAN_MODELS["Wan 3.0"],
    "wan-3.0-prime": WAN_MODELS["Wan 3.0 Prime"],
    "alibaba/wan-3.0/text-to-video": WAN_MODELS["Wan 3.0"],
    "alibaba/wan-3.0-prime/text-to-video": WAN_MODELS["Wan 3.0 Prime"],
  };
  return aliases[String(value ?? "")] ?? String(value ?? "");
}

function wanTaskAlias(value: unknown) {
  const aliases: Record<string, string> = {
    "Text to video": WAN_TASKS["Text to video"],
    "Image to video": WAN_TASKS["Image to video"],
    "Reference to video": WAN_TASKS["Reference to video"],
  };
  const normalized = String(value ?? "");
  return aliases[normalized] ?? normalized;
}

export function normalizeWanParams(params: Record<string, unknown> = {}) {
  const model = wanModelAlias(params.model);
  const task = wanTaskAlias(params.task);
  const duration = Number(params.duration);
  const seed = Number(params.seed);
  const legacyFile = params.file ?? params.document;
  const file = isRecord(legacyFile)
    && typeof legacyFile.id === "string"
    && typeof legacyFile.name === "string"
    && typeof legacyFile.type === "string"
    && typeof legacyFile.size === "number"
    ? {
      id: legacyFile.id,
      name: legacyFile.name,
      type: legacyFile.type,
      size: legacyFile.size,
    } satisfies WanStoredFile
    : typeof legacyFile === "string" && /^https?:\/\//i.test(legacyFile.trim())
      ? legacyFile.trim()
      : null;
  const link = String(params.link ?? params.webpage ?? "");
  const candidateCount = Number(params.reference_count);

  return {
    ...WAN_DEFAULTS,
    model: MODEL_VALUES.includes(model as (typeof MODEL_VALUES)[number]) ? model : WAN_DEFAULTS.model,
    task: TASK_VALUES.includes(task as (typeof TASK_VALUES)[number]) ? task : WAN_DEFAULTS.task,
    duration: duration === -1 || (Number.isInteger(duration)
      && duration >= WAN_MIN_DURATION_SECONDS && duration <= WAN_MAX_DURATION_SECONDS)
      ? duration
      : WAN_DEFAULTS.duration,
    resolution: RESOLUTION_VALUES.includes(String(params.resolution) as (typeof RESOLUTION_VALUES)[number])
      ? String(params.resolution)
      : WAN_DEFAULTS.resolution,
    ratio: RATIOS.includes(String(params.ratio ?? params.aspect_ratio) as (typeof RATIOS)[number])
      ? String(params.ratio ?? params.aspect_ratio)
      : WAN_DEFAULTS.ratio,
    audio: typeof params.audio === "boolean" ? params.audio : params.generate_audio !== false,
    seed: Number.isInteger(seed) ? seed : WAN_DEFAULTS.seed,
    enable_thinking: params.enable_thinking === true,
    reference_count: Number.isInteger(candidateCount) ? Math.min(10, Math.max(3, candidateCount)) : 3,
    file,
    link,
    prediction_id: typeof params.prediction_id === "string" && PREDICTION_ID.test(params.prediction_id)
      ? params.prediction_id
      : "",
    last_status: typeof params.last_status === "string" ? params.last_status : "",
    last_output_url: typeof params.last_output_url === "string" ? params.last_output_url : "",
  };
}

function parseDataUrl(value: string) {
  const match = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/i.exec(value);
  if (!match) return null;
  const encoded = match[2];
  const isBase64 = /;base64,/i.test(value);
  const size = isBase64
    ? Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
    : new TextEncoder().encode(decodeURIComponent(encoded)).byteLength;
  return { type: match[1].toLowerCase(), size };
}

function describeWanMedia(value: unknown): MediaDescription | null {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return { value, local: false };
    const data = parseDataUrl(value);
    if (data) return { value: LOCAL_MEDIA_PLACEHOLDER, local: true, ...data };
    return null;
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return {
      value: LOCAL_MEDIA_PLACEHOLDER,
      local: true,
      type: value.type.toLowerCase(),
      size: value.size,
      name: value.name,
    };
  }
  if (!isRecord(value)) return null;
  if (typeof value.url === "string") return describeWanMedia(value.url);
  const name = typeof value.name === "string" ? value.name : undefined;
  const type = typeof value.type === "string" ? value.type.toLowerCase() : undefined;
  const size = typeof value.size === "number" ? value.size : undefined;
  const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl : undefined;
  const valueText = typeof value.value === "string" ? value.value : undefined;
  const local = value.local === true || typeof value.id === "string" || Boolean(dataUrl);
  if (!local && valueText) return describeWanMedia(valueText);
  if (!local && typeof valueText !== "string") return null;
  return {
    value: LOCAL_MEDIA_PLACEHOLDER,
    local,
    ...(type ? { type } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(name ? { name } : {}),
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
    ...(typeof value.hasAlpha === "boolean" ? { hasAlpha: value.hasAlpha } : {}),
  };
}

function wanExtension(name: string) {
  return name.split(".").at(-1)?.toLowerCase() ?? "";
}

function wanPublicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const parts = host.split(".").map(Number);
  const privateIpv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 0 || parts[0] === 10 || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 192 && parts[1] === 0 && parts[2] === 2)
      || (parts[0] === 198 && [18, 19, 51].includes(parts[1]))
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
      || parts[0] >= 224);
  return ["http:", "https:"].includes(url.protocol)
    && host !== "localhost"
    && host.includes(".")
    && !host.startsWith("[")
    && !host.endsWith(".localhost")
    && !host.endsWith(".local")
    && ![".internal", ".test", ".invalid", ".example", ".home.arpa"].some((suffix) => host.endsWith(suffix))
    && !privateIpv4
    && !url.username
    && !url.password
    && !["drive.google.com", "photos.google.com"].includes(host)
    && !host.endsWith(".drive.google.com")
    && !host.endsWith(".photos.google.com");
}

function validateWanMedia(value: unknown, kind: MediaKind, label: string, errors: string[]) {
  const media = describeWanMedia(value);
  if (!media) {
    errors.push(`${label} must be a public HTTP(S) URL or a local file.`);
    return "";
  }
  if (!media.local && !wanPublicUrl(media.value)) {
    errors.push(`${label} must be a public HTTP(S) URL; private URLs and Google Drive/Photos share links are not supported.`);
    return "";
  }
  if (media.local) {
    if (typeof media.size === "number" && media.size <= 0) errors.push(`${label} is empty.`);
    if (kind === "image") {
      if (media.type && !IMAGE_TYPES.has(media.type)) errors.push(`${label} must be JPEG, JPG, PNG without alpha, BMP, or WebP.`);
      if (typeof media.size === "number" && media.size > 20 * 1024 * 1024) errors.push(`${label} must be 20 MB or smaller.`);
      if (media.hasAlpha) errors.push(`${label} must not contain transparency.`);
      if (media.width !== undefined && media.height !== undefined) {
        const ratio = media.width / media.height;
        if (media.width < 240 || media.height < 240 || media.width > 8000 || media.height > 8000
          || ratio > 8 || ratio < 1 / 8) {
          errors.push(`${label} must have 240–8000 px edges and an aspect ratio no wider than 8:1.`);
        }
      }
    } else if (kind === "video") {
      const extension = media.name ? wanExtension(media.name) : "";
      if (media.type && !VIDEO_TYPES.has(media.type)) errors.push(`${label} must be MP4 or MOV.`);
      if (extension && !["mp4", "mov"].includes(extension)) errors.push(`${label} must be MP4 or MOV.`);
    } else if (kind === "audio") {
      const extension = media.name ? wanExtension(media.name) : "";
      if (media.type && !AUDIO_TYPES.has(media.type)) errors.push(`${label} must be WAV or MP3.`);
      if (extension && !["wav", "mp3"].includes(extension)) errors.push(`${label} must be WAV or MP3.`);
    } else {
      const extension = media.name ? wanExtension(media.name) : "";
      if (extension && !DOCUMENT_EXTENSIONS.has(extension)) errors.push(`${label} must use a supported document format.`);
      if (typeof media.size === "number" && media.size > 100 * 1024 * 1024) errors.push(`${label} must be 100 MB or smaller.`);
    }
  }
  return media.value;
}

function wanInputHasValue(value: unknown) {
  if (typeof value === "string") return Boolean(value.trim());
  return value !== undefined && value !== null && value !== false;
}

export function validateWanRequestBody(body: unknown) {
  const errors: string[] = [];
  if (!isRecord(body)) return ["Request body must be an object."];
  const modelPath = typeof body.model === "string" ? body.model : "";
  const task = TASK_VALUES.find((candidate) => modelPath.endsWith(`/${candidate}`));
  const model = task ? modelPath.slice(0, -task.length - 1) : "";
  if (!task || !MODEL_VALUES.includes(model as (typeof MODEL_VALUES)[number])) {
    errors.push("Only the six supported Wan 3.0 model/task endpoints are available.");
    return errors;
  }
  const allowedFields = new Set(["model", "prompt", "resolution", "duration", "audio", "seed"]);
  if (task === "text-to-video") allowedFields.add("ratio");
  if (task === "image-to-video") {
    allowedFields.add("image");
    allowedFields.add("last_image");
  }
  if (task === "reference-to-video") {
    for (const field of ["refers", "ratio", "enable_thinking", "file", "link"]) allowedFields.add(field);
  }
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) errors.push(`The ${key} field is not valid for ${task}.`);
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) errors.push("A prompt is required.");
  if (typeof body.prompt === "string" && body.prompt.length > 20000) errors.push("Prompt must not exceed 20,000 characters.");
  if (typeof body.duration !== "number"
    || !(body.duration === -1 || (Number.isInteger(body.duration)
      && body.duration >= WAN_MIN_DURATION_SECONDS && body.duration <= WAN_MAX_DURATION_SECONDS))) {
    errors.push("Duration must be Smart or a whole number from 2 to 30 seconds.");
  }
  if (!RESOLUTION_VALUES.includes(body.resolution as (typeof RESOLUTION_VALUES)[number])) {
    errors.push("Choose a supported Wan 3.0 resolution.");
  }
  if (typeof body.audio !== "boolean") errors.push("Audio must be on or off.");
  if (typeof body.seed !== "number" || !Number.isInteger(body.seed)) errors.push("Seed must be an integer.");
  if (task !== "image-to-video" && !RATIOS.includes(body.ratio as (typeof RATIOS)[number])) {
    errors.push("Choose a supported aspect ratio.");
  }
  if (task === "image-to-video") {
    if (typeof body.image !== "string" || !wanPublicUrl(body.image)) errors.push("A public first-frame image URL is required.");
    if (body.last_image !== undefined && (typeof body.last_image !== "string" || !wanPublicUrl(body.last_image))) {
      errors.push("Last-frame image must be a public HTTP(S) URL.");
    }
  }
  if (task === "reference-to-video") {
    if (body.enable_thinking !== undefined && typeof body.enable_thinking !== "boolean") {
      errors.push("Deep thinking must be on or off.");
    }
    const refers = body.refers === undefined ? [] : body.refers;
    if (!Array.isArray(refers)) {
      errors.push("References must be an array.");
    } else {
      if (refers.length > 20) errors.push("A maximum of 20 references is allowed.");
      const counts = { image: 0, video: 0, audio: 0 };
      refers.forEach((item, index) => {
        if (!isRecord(item) || !["image", "video", "audio"].includes(String(item.type))
          || typeof item.url !== "string" || !wanPublicUrl(item.url)) {
          errors.push(`Reference ${index + 1} must have a supported type and public URL.`);
          return;
        }
        counts[item.type as keyof typeof counts]++;
      });
      if (counts.image > 10) errors.push("A maximum of 10 reference images is allowed.");
      if (counts.video > 5) errors.push("A maximum of 5 reference videos is allowed.");
      if (counts.audio > 5) errors.push("A maximum of 5 reference audio clips is allowed.");
    }
    if (body.file !== undefined && (typeof body.file !== "string" || !wanPublicUrl(body.file))) {
      errors.push("Document must be uploaded as a public HTTP(S) URL.");
    }
    if (body.link !== undefined && (typeof body.link !== "string" || !wanPublicUrl(body.link))) {
      errors.push("Webpage must be a public HTTP(S) URL.");
    }
    if (body.file !== undefined && body.link !== undefined) errors.push("Choose either a document or webpage, not both.");
    if ((body.file !== undefined || body.link !== undefined) && body.enable_thinking !== true) {
      errors.push("Deep thinking is required for documents and webpages.");
    }
  }
  return errors;
}

export function buildWanRequest(node: WanNodeLike, resolvedInputs: WanResolvedInputs) {
  const params = normalizeWanParams(node.params);
  const model = params.model;
  const task = params.task;
  const endpoint = `${model}/${task}`;
  const errors: string[] = [];
  const warnings: string[] = [];
  const prompt = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  if (!prompt.trim()) errors.push("Connect a Prompt node with prompt text.");
  if (prompt.length > 20000) errors.push("Prompt must not exceed 20,000 characters.");

  let duration: number;
  if (typeof params.duration === "number") duration = params.duration;
  else duration = Number(params.duration);
  if (!(duration === -1 || (Number.isInteger(duration)
    && duration >= WAN_MIN_DURATION_SECONDS && duration <= WAN_MAX_DURATION_SECONDS))) {
    errors.push("Duration must be Smart or a whole number from 2 to 30 seconds.");
    duration = WAN_DEFAULTS.duration;
  }
  const resolution = String(params.resolution);
  if (!RESOLUTION_VALUES.includes(resolution as (typeof RESOLUTION_VALUES)[number])) {
    errors.push("Choose a supported Wan 3.0 resolution.");
  }
  const ratio = String(params.ratio);
  if (task !== "image-to-video" && !RATIOS.includes(ratio as (typeof RATIOS)[number])) {
    errors.push("Choose a supported aspect ratio.");
  }
  if (typeof params.audio !== "boolean") errors.push("Audio must be on or off.");
  if (typeof params.seed !== "number" || !Number.isInteger(params.seed)) errors.push("Seed must be an integer.");

  const connectedReferences = Array.isArray(resolvedInputs.references)
    ? resolvedInputs.references
    : [];
  if (task === "text-to-video" && (wanInputHasValue(resolvedInputs.image)
    || wanInputHasValue(resolvedInputs.last_image) || connectedReferences.length > 0)) {
    errors.push("Text-to-video does not accept image or reference inputs.");
  }
  if (task === "image-to-video" && connectedReferences.length > 0) {
    errors.push("Reference inputs cannot be used with image-to-video.");
  }
  if (task === "reference-to-video" && (wanInputHasValue(resolvedInputs.image)
    || wanInputHasValue(resolvedInputs.last_image))) {
    errors.push("First/last-frame inputs cannot be used with reference-to-video.");
  }

  const body: Record<string, unknown> = {
    model: endpoint,
    prompt,
    resolution,
    duration,
    audio: params.audio,
    seed: params.seed,
  };

  if (task === "text-to-video") body.ratio = ratio;
  if (task === "image-to-video") {
    const image = validateWanMedia(resolvedInputs.image, "image", "First frame", errors);
    body.image = image;
    if (wanInputHasValue(resolvedInputs.last_image)) {
      body.last_image = validateWanMedia(resolvedInputs.last_image, "image", "Last frame", errors);
    }
  }
  if (task === "reference-to-video") {
    body.ratio = ratio;
    body.enable_thinking = params.enable_thinking;
    if (connectedReferences.length > 20) errors.push("A maximum of 20 references is allowed.");
    const counts = { image: 0, video: 0, audio: 0 };
    const refers = connectedReferences.map((reference, index) => {
      counts[reference.type]++;
      const url = validateWanMedia(reference.value, reference.type, `Reference ${index + 1}`, errors);
      return { url, type: reference.type };
    });
    if (counts.image > 10) errors.push("A maximum of 10 reference images is allowed.");
    if (counts.video > 5) errors.push("A maximum of 5 reference videos is allowed.");
    if (counts.audio > 5) errors.push("A maximum of 5 reference audio clips is allowed.");
    if (refers.length > 0) body.refers = refers;

    const file = wanInputHasValue(resolvedInputs.file) ? resolvedInputs.file : params.file;
    const link = String(params.link ?? "").trim();
    if (wanInputHasValue(file) && link) errors.push("Choose either a document or webpage, not both.");
    if (wanInputHasValue(file)) body.file = validateWanMedia(file, "document", "Document", errors);
    if (link) {
      if (!wanPublicUrl(link)) errors.push("Webpage must be a public HTTP(S) URL.");
      else body.link = link;
    }
    if ((wanInputHasValue(file) || link) && params.enable_thinking !== true) {
      errors.push("Deep thinking is required for documents and webpages.");
    }
    if (!refers.length && !wanInputHasValue(file) && !link) {
      // Atlas's schema and documentation disagree about whether references are required; this remains unverified on Atlas.
      warnings.push("Connect at least one reference image/video/audio or provide a document or webpage (unverified on Atlas).");
    }
    const videoSeconds = Number(resolvedInputs.referenceVideoSeconds ?? 0);
    const audioSeconds = Number(resolvedInputs.referenceAudioSeconds ?? 0);
    if (videoSeconds > 15) warnings.push("Reference videos must total 15 seconds or less.");
    if (audioSeconds > 15) warnings.push("Reference audio must total 15 seconds or less.");
    if (videoSeconds > 0) {
      if (duration !== -1 && duration + videoSeconds > 30) {
        warnings.push("Input and output video together must stay within 30 seconds.");
      }
      warnings.push("Input video seconds may be billed too (unverified on Atlas).");
    }
  }

  if (resolution.endsWith("-esr")) {
    // Exact enhanced-tier pricing is unverified on Atlas.
    warnings.push("Enhanced tiers upscale the render and cost more (exact pricing unverified on Atlas).");
  }
  const validationBody = structuredClone(body);
  const placeholderUrl = "https://example.com/media";
  const replaceLocalUrl = (value: unknown) => value === LOCAL_MEDIA_PLACEHOLDER ? placeholderUrl : value;
  for (const key of ["image", "last_image", "file"]) {
    if (key in validationBody) validationBody[key] = replaceLocalUrl(validationBody[key]);
  }
  if (Array.isArray(validationBody.refers)) {
    validationBody.refers = validationBody.refers.map((item) =>
      isRecord(item) ? { ...item, url: replaceLocalUrl(item.url) } : item
    );
  }
  errors.push(...validateWanRequestBody(validationBody));
  return { model, task, endpoint, body, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function getWanRequestFileKind(type: WanReferenceInput["type"] | "document"): MediaKind {
  return type;
}

export function getWanMediaTypeSet(kind: "image" | "video" | "audio") {
  if (kind === "image") return IMAGE_TYPES;
  if (kind === "video") return VIDEO_TYPES;
  return AUDIO_TYPES;
}

export function validateWanImageMetadata(input: {
  type: string;
  size: number;
  width: number;
  height: number;
  hasAlpha: boolean;
}) {
  const errors: string[] = [];
  if (!IMAGE_TYPES.has(input.type.toLowerCase())) errors.push("Images must be JPEG, PNG, BMP, or WebP.");
  if (input.size < 1 || input.size > 20 * 1024 * 1024) errors.push("Images must be 20 MB or smaller.");
  if (input.width < 240 || input.height < 240 || input.width > 8000 || input.height > 8000
    || input.width / input.height > 8 || input.height / input.width > 8) {
    errors.push("Images must have 240–8000 px edges and an aspect ratio no wider than 8:1.");
  }
  if (input.hasAlpha) errors.push("Images must not contain transparency.");
  return errors;
}

export function validateWanUploadFile(file: { name: string; type: string; size: number }, kind: string) {
  const errors: string[] = [];
  if (file.size < 1) errors.push("The selected file is empty.");
  if (kind === "image") {
    if (!IMAGE_TYPES.has(file.type.toLowerCase())) errors.push("Images must be JPEG, PNG, BMP, or WebP.");
    if (file.size > 20 * 1024 * 1024) errors.push("Images must be 20 MB or smaller.");
  } else if (kind === "video") {
    const extension = wanExtension(file.name);
    if (!VIDEO_TYPES.has(file.type.toLowerCase()) && !["mp4", "mov"].includes(extension)) {
      errors.push("Reference videos must be MP4 or MOV.");
    }
  } else if (kind === "audio") {
    const extension = wanExtension(file.name);
    if (!AUDIO_TYPES.has(file.type.toLowerCase()) && !["wav", "mp3"].includes(extension)) {
      errors.push("Reference audio must be WAV or MP3.");
    }
  } else if (kind === "document") {
    if (!DOCUMENT_EXTENSIONS.has(wanExtension(file.name))) errors.push("Choose a supported document format.");
    if (file.size > 100 * 1024 * 1024) errors.push("Documents must be 100 MB or smaller.");
  } else {
    errors.push("Unsupported Atlas media upload.");
  }
  return errors;
}
