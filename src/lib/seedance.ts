export const SEEDANCE_MODELS = {
  "Seedance 2.5": "bytedance/seedance-2.5",
  "Seedance 2.0": "bytedance/seedance-2.0",
  "Seedance 2.0 Fast": "bytedance/seedance-2.0-fast",
  "Seedance 2.0 Mini": "bytedance/seedance-2.0-mini",
} as const;

export const SEEDANCE_RATES: Record<string, number> = {
  "bytedance/seedance-2.5": 0.134,
  "bytedance/seedance-2.0": 0.09,
  "bytedance/seedance-2.0-fast": 0.072,
  "bytedance/seedance-2.0-mini": 0.045,
};

// Higher resolutions and enhanced tiers cost more than these placeholder rates.
const modelMaxDuration = (model: string) => model === SEEDANCE_MODELS["Seedance 2.5"] ? 30 : 15;
const isSeedance25 = (model: string) => model === SEEDANCE_MODELS["Seedance 2.5"];
const isSeedance20 = (model: string) => model in {
  [SEEDANCE_MODELS["Seedance 2.0"]]: true,
  [SEEDANCE_MODELS["Seedance 2.0 Fast"]]: true,
  [SEEDANCE_MODELS["Seedance 2.0 Mini"]]: true,
};

type SeedanceNodeLike = { params: Record<string, unknown> };
type ConnectedInputs = Record<string, unknown>;

const asArray = (value: unknown) =>
  value == null ? [] : Array.isArray(value) ? value.filter(Boolean) : [value];

export function buildSeedanceRequest(node: SeedanceNodeLike, connectedInputs: ConnectedInputs) {
  const params = node.params;
  const model = String(params.model ?? "");
  const task = String(params.task ?? "");
  const duration = Number(params.duration);
  const resolution = String(params.resolution ?? "");
  const ratio = String(params.ratio ?? "");
  const variations = Number(params.variations ?? 1);
  const referenceTask = String(params.omni_reference_task_type ?? "auto");
  const prompt = String(connectedInputs.prompt ?? "").trim();
  const isReferenceTask = task === "reference-to-video";
  const referenceVideos = asArray(connectedInputs.reference_videos);
  const effectiveRatio = isReferenceTask && ["edit", "extend"].includes(referenceTask)
    ? "adaptive"
    : ratio;
  const effectiveDuration = isReferenceTask && referenceTask === "edit" ? -1 : duration;

  if (!Object.values(SEEDANCE_MODELS).includes(model as (typeof SEEDANCE_MODELS)[keyof typeof SEEDANCE_MODELS])) {
    throw new Error("Choose a valid Seedance model.");
  }
  if (!["text-to-video", "image-to-video", "reference-to-video"].includes(task)) {
    throw new Error("Choose a valid Seedance task.");
  }
  if (!prompt) throw new Error("Connect a prompt.");
  if (!(effectiveDuration === -1 || (Number.isInteger(effectiveDuration) && effectiveDuration >= 4 && effectiveDuration <= modelMaxDuration(model)))) {
    throw new Error(`Duration must be Auto or between 4 and ${modelMaxDuration(model)} seconds.`);
  }
  if (!["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].includes(effectiveRatio)) {
    throw new Error("Choose a valid aspect ratio.");
  }
  if (isReferenceTask && !["auto", "reference", "edit", "extend"].includes(referenceTask)) {
    throw new Error("Choose a valid reference task.");
  }
  if (!Number.isInteger(variations) || variations < 1 || variations > 4) {
    throw new Error("Variations must be between 1 and 4.");
  }

  const draft = isSeedance25(model) && params.draft === true;
  const finalResolution = draft ? "480p" : resolution;
  const validResolutions = isSeedance25(model)
    ? ["480p", "720p", "1080p", "720p-sr", "720p-esr", "1080p-sr", "1080p-esr", "1080p-esr-60fps", "1440p-sr", "1440p-esr", "4k-esr"]
    : ["480p", "720p"];
  if (!validResolutions.includes(finalResolution)) {
    throw new Error("The selected resolution is not available for this Seedance model.");
  }
  if (task === "image-to-video" && !connectedInputs.image) {
    throw new Error("Image to video requires a connected first-frame image.");
  }

  if (isReferenceTask && ["edit", "extend"].includes(referenceTask) && referenceVideos.length !== 1) {
    throw new Error(`${referenceTask === "edit" ? "Edit" : "Extend"} requires exactly one reference video.`);
  }

  const body: Record<string, unknown> = {
    prompt,
    duration: effectiveDuration,
    resolution: finalResolution,
    ratio: effectiveRatio,
    generate_audio: params.generate_audio !== false,
    watermark: params.watermark === true,
    return_last_frame: params.return_last_frame === true,
    variations,
  };
  if (task === "image-to-video") {
    body.image = connectedInputs.image;
    if (connectedInputs.last_image) body.last_image = connectedInputs.last_image;
  }
  if (task === "reference-to-video") {
    body.reference_images = asArray(connectedInputs.reference_images);
    body.reference_videos = referenceVideos;
    body.reference_audios = asArray(connectedInputs.reference_audios);
    body.omni_reference_task_type = referenceTask;
  }
  if (isSeedance25(model)) {
    body.draft = draft;
    body.output_format = params.output_format === "mov" ? "mov" : "mp4";
  } else if (isSeedance20(model)) {
    body.bitrate_mode = params.bitrate_mode === "high" ? "high" : "standard";
  }

  return { model, task, body };
}
