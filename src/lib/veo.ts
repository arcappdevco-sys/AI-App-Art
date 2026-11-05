export const VEO_MODELS = {
  "Veo 3.1": "google/veo3.1",
  "Veo 3.1 Fast": "google/veo3.1-fast",
  "Veo 3.1 Lite": "google/veo3.1-lite",
} as const;

export const VEO_RATES: Record<string, number> = {
  "google/veo3.1": 0.2,
  "google/veo3.1-fast": 0.08,
  "google/veo3.1-lite": 0.05,
};
// Atlas base-rate estimates; task type, resolution, and account pricing may change the final cost.

const VEO_TASKS = ["text-to-video", "image-to-video", "reference-to-video"] as const;
const VEO_DURATIONS = ["4", "6", "8"];
const VEO_RATIOS = ["16:9", "9:16"];
const VEO_RESOLUTIONS = ["720p", "1080p", "4K"];

const modelSupportsTask = (model: string, task: string) =>
  task !== "reference-to-video" || model === VEO_MODELS["Veo 3.1"];

export function normalizeVeoParams(params: Record<string, unknown>) {
  const legacyModels: Record<string, string> = {
    "Veo 3.1": VEO_MODELS["Veo 3.1"],
    "Veo 3.1 Fast": VEO_MODELS["Veo 3.1 Fast"],
    "Veo 3.1 Lite": VEO_MODELS["Veo 3.1 Lite"],
    "Veo 3.1 Lite (Preview · retired)": VEO_MODELS["Veo 3.1 Lite"],
  };
  const savedModel = String(params.model ?? "");
  const legacyModel = legacyModels[savedModel]
    ?? (savedModel.startsWith("Veo 3.1 Lite") ? VEO_MODELS["Veo 3.1 Lite"] : params.model);
  const model = Object.values(VEO_MODELS).includes(legacyModel as (typeof VEO_MODELS)[keyof typeof VEO_MODELS])
    ? String(legacyModel)
    : VEO_MODELS["Veo 3.1"];
  const legacyTasks: Record<string, string> = {
    "Text to video": "text-to-video",
    "Image to video": "image-to-video",
    "Ingredients to video": "reference-to-video",
  };
  const taskValue = legacyTasks[String(params.task)] ?? params.task;
  const task = VEO_TASKS.includes(taskValue as (typeof VEO_TASKS)[number])
    && modelSupportsTask(model, String(taskValue))
    ? String(taskValue)
    : "text-to-video";
  const legacyDurations: Record<string, string> = {
    "4 seconds": "4",
    "6 seconds": "6",
    "8 seconds": "8",
  };
  const duration = legacyDurations[String(params.duration)] ?? String(params.duration ?? "8");
  const normalized: Record<string, unknown> = {
    ...params,
    model,
    task,
    duration: VEO_DURATIONS.includes(duration) ? duration : "8",
    aspect_ratio: VEO_RATIOS.includes(String(params.aspect_ratio)) ? params.aspect_ratio : "16:9",
    resolution: VEO_RESOLUTIONS.includes(String(params.resolution)) ? params.resolution : "1080p",
    count: ["1", "2", "3", "4"].includes(String(params.count)) ? String(params.count) : "1",
    generate_audio: params.generate_audio !== false,
  };
  return normalized;
}

export function buildVeoRequest(node: { params: Record<string, unknown> }, connectedInputs: Record<string, unknown>) {
  const model = String(normalizeVeoParams({ ...node.params, task: "text-to-video" }).model);
  const taskAliases: Record<string, string> = {
    "Text to video": "text-to-video",
    "Image to video": "image-to-video",
    "Ingredients to video": "reference-to-video",
  };
  const requestedTask = taskAliases[String(node.params.task)] ?? String(node.params.task ?? "");
  if (!VEO_TASKS.includes(requestedTask as (typeof VEO_TASKS)[number]) || !modelSupportsTask(model, requestedTask)) {
    throw new Error("This Veo model does not support the selected task.");
  }
  const params = normalizeVeoParams({ ...node.params, model, task: requestedTask });
  const normalizedModel = String(params.model);
  const task = String(params.task);
  const duration = Number(params.duration);
  const resolution = String(params.resolution);
  const ratio = String(params.aspect_ratio);
  const count = Number(params.count);
  const prompt = String(connectedInputs.prompt ?? "").trim();

  if (!Object.values(VEO_MODELS).includes(normalizedModel as (typeof VEO_MODELS)[keyof typeof VEO_MODELS])) {
    throw new Error("Choose a valid Veo model.");
  }
  if (!VEO_TASKS.includes(task as (typeof VEO_TASKS)[number]) || !modelSupportsTask(normalizedModel, task)) {
    throw new Error("This Veo model does not support the selected task.");
  }
  if (!prompt) throw new Error("Connect a prompt.");
  if (!VEO_DURATIONS.includes(String(duration))) {
    throw new Error("Veo duration must be 4, 6, or 8 seconds.");
  }
  if (!VEO_RATIOS.includes(ratio)) throw new Error("Choose a valid aspect ratio.");
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new Error("Veo count must be between 1 and 4.");
  }

  const validResolutions = normalizedModel === VEO_MODELS["Veo 3.1 Lite"]
    ? ["720p", "1080p"]
    : normalizedModel === VEO_MODELS["Veo 3.1 Fast"]
      ? ["720p", "1080p", "4K"]
      : VEO_RESOLUTIONS;
  if (!validResolutions.includes(resolution)) {
    throw new Error("The selected resolution is not available for this Veo model.");
  }
  if (resolution !== "720p" && duration !== 8) {
    throw new Error("Veo 1080p and 4K generations require an 8-second duration.");
  }

  const body: Record<string, unknown> = {
    prompt,
    duration,
    resolution: resolution === "4K" ? "4k" : resolution,
    aspect_ratio: ratio,
    generate_audio: params.generate_audio !== false,
  };
  let endpointTask = task;

  if (task === "image-to-video") {
    const firstFrame = connectedInputs.first_frame;
    const lastFrame = connectedInputs.last_frame;
    if (!firstFrame) throw new Error("Image to video requires a connected first frame.");
    body.image = firstFrame;
    if (lastFrame) {
      body.last_image = lastFrame;
      if (normalizedModel === VEO_MODELS["Veo 3.1 Lite"]) endpointTask = "start-end-frame-to-video";
    }
  }
  if (task === "reference-to-video") {
    if (duration !== 8) throw new Error("Veo reference-to-video generations require an 8-second duration.");
    const images = [connectedInputs.ingredient_1, connectedInputs.ingredient_2, connectedInputs.ingredient_3].filter(Boolean);
    if (images.length < 1 || images.length > 3) {
      throw new Error("Ingredients to video requires between 1 and 3 reference images.");
    }
    body.images = images;
  }
  if (params.seed !== undefined && params.seed !== "") {
    const seed = Number(params.seed);
    if (!Number.isInteger(seed)) throw new Error("Seed must be an integer.");
    body.seed = seed;
  }

  return {
    model: `${normalizedModel}/${endpointTask}`,
    task: endpointTask,
    body,
    count,
  };
}
