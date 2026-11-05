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

type SeedanceNodeLike = { params: Record<string, unknown> };
type ConnectedInputs = Record<string, unknown>;

export function buildSeedanceRequest(node: SeedanceNodeLike, connectedInputs: ConnectedInputs) {
  const params = node.params;
  const model = String(params.model ?? "");
  const task = String(params.task ?? "");
  const duration = Number(params.duration);
  const resolution = String(params.resolution ?? "");
  const variations = Number(params.variations ?? 1);
  const prompt = String(connectedInputs.prompt ?? "").trim();
  const supportsTextToVideo = isSeedance25(model) && task === "text-to-video";
  const supportsImageToVideo = isSeedance25(model) && task === "image-to-video";

  if (!Object.values(SEEDANCE_MODELS).includes(model as (typeof SEEDANCE_MODELS)[keyof typeof SEEDANCE_MODELS])) {
    throw new Error("Choose a valid Seedance model.");
  }
  if (!supportsTextToVideo && !supportsImageToVideo) {
    throw new Error("Atlas Cloud integration currently supports Seedance 2.5 Text to video and Image to video only.");
  }
  if (supportsTextToVideo && !prompt) throw new Error("Text to video requires a connected prompt.");
  if (!(duration === -1 || (Number.isInteger(duration) && duration >= 4 && duration <= modelMaxDuration(model)))) {
    throw new Error(`Duration must be Auto or between 4 and ${modelMaxDuration(model)} seconds.`);
  }
  if (!Number.isInteger(variations) || variations < 1 || variations > 4) {
    throw new Error("Variations must be between 1 and 4.");
  }

  const draft = isSeedance25(model) && params.draft === true;
  const finalResolution = draft ? "480p" : resolution;
  const validResolutions = ["480p", "720p", "1080p", "720p-sr", "720p-esr", "1080p-sr", "1080p-esr", "1080p-esr-60fps", "1440p-sr", "1440p-esr", "4k-esr"];
  if (!validResolutions.includes(finalResolution)) {
    throw new Error("The selected resolution is not available for this Seedance model.");
  }
  if (supportsImageToVideo && (typeof connectedInputs.image !== "string" || !connectedInputs.image)) {
    throw new Error("Image to video requires a connected first-frame image.");
  }
  if (typeof connectedInputs.last_image !== "undefined" && typeof connectedInputs.last_image !== "string") {
    throw new Error("Last-frame image must be a URL or uploaded image.");
  }
  if (supportsTextToVideo && (connectedInputs.image || connectedInputs.last_image)) {
    throw new Error("Image inputs are only supported by the Image to video task.");
  }
  if (params.output_format !== "mp4" && params.output_format !== "mov") {
    throw new Error("Choose a valid output format.");
  }
  if (!["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"].includes(String(params.ratio ?? "adaptive"))) {
    throw new Error("Choose a valid aspect ratio.");
  }
  const body: Record<string, unknown> = {
    model: `${model}/${task}`,
    duration,
    resolution: finalResolution,
    ratio: supportsImageToVideo ? "adaptive" : String(params.ratio ?? "adaptive"),
    output_format: params.output_format === "mov" ? "mov" : "mp4",
    generate_audio: params.generate_audio !== false,
    watermark: params.watermark === true,
    return_last_frame: params.return_last_frame === true,
    draft,
  };
  if (supportsImageToVideo) body.image = connectedInputs.image;
  if (prompt) body.prompt = prompt;
  if (supportsImageToVideo && connectedInputs.last_image) body.last_image = connectedInputs.last_image;
  return { model: `${model}/${task}`, task, body, variations };
}
