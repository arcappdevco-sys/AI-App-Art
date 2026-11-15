import { FLUX3_NODE_TYPE, FLUX3_RATES } from "./flux3";
import { FLUX3_VIDEO_DEFAULTS, FLUX3_VIDEO_NODE_TYPE, FLUX3_VIDEO_RATES } from "./flux3-video";
import { KLING_DEFAULTS, KLING_MODELS, KLING_RATES, KLING_TASKS } from "./kling";
import { MINIMAX_NODE_TYPE, MINIMAX_DEFAULTS, MINIMAX_MODELS, MINIMAX_RATES, minimaxResolutions } from "./minimax";
import { OMNI_DEFAULTS, OMNI_MODELS, OMNI_RATES, OMNI_TASKS } from "./omni";
import { SEEDANCE_MODELS, SEEDANCE_RATES } from "./seedance";
import { VEO_MODELS, VEO_RATES } from "./veo";
import { WAN_DEFAULTS, WAN_MODELS, WAN_NODE_TYPE, WAN_RATES } from "./wan";

export const LOW_MODE_SHORTEN_DURATION = false;

export type LowSettingsProfile = {
  overrides: Record<string, unknown>;
  changes: string[];
  needsDecision?: string;
};

function modelLabel(models: Record<string, string>, model: string) {
  return Object.entries(models).find(([, value]) => value === model)?.[0];
}

export function lowSettingsNodeLabel(type: string, label: string, params: Record<string, unknown>) {
  const model = String(params.model ?? "");
  const modelSets: Record<string, Record<string, string>> = {
    [WAN_NODE_TYPE]: WAN_MODELS,
    [MINIMAX_NODE_TYPE]: MINIMAX_MODELS,
    "video/kling": KLING_MODELS,
    "video/seedance": SEEDANCE_MODELS,
    "video/veo": VEO_MODELS,
    "video/google-omni": OMNI_MODELS,
  };
  return modelSets[type] ? modelLabel(modelSets[type], model) ?? label : label;
}

function describeChange(key: string, before: unknown, after: unknown) {
  const labels: Record<string, string> = {
    resolution: "resolution",
    quality: "quality",
    draft: "Draft preview",
    variations: "variations",
    count: "count",
    num_images: "image count",
  };
  const value = (item: unknown) => typeof item === "boolean" ? (item ? "on" : "off") : String(item);
  return `${labels[key] ?? key}: ${value(before)} to ${value(after)}`;
}

function profile(params: Record<string, unknown>, changes: Record<string, unknown> = {}, needsDecision?: string): LowSettingsProfile {
  const overrides: Record<string, unknown> = {};
  const descriptions: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (params[key] === value) continue;
    overrides[key] = value;
    descriptions.push(describeChange(key, params[key], value));
  }
  return { overrides, changes: descriptions, ...(needsDecision ? { needsDecision } : {}) };
}

export function getLowSettingsProfile(type: string, params: Record<string, unknown>): LowSettingsProfile {
  const model = String(params.model ?? "");
  const task = String(params.task ?? "");

  if (type === WAN_NODE_TYPE) {
    return profile(params, { resolution: "480p" });
  }
  if (type === MINIMAX_NODE_TYPE) {
    const options = minimaxResolutions(model, task);
    const resolution = options[0];
    return resolution ? profile(params, { resolution }) : { overrides: {}, changes: [] };
  }
  if (type === FLUX3_NODE_TYPE) {
    return profile(params, { resolution: "768sq" });
  }
  if (type === FLUX3_VIDEO_NODE_TYPE) {
    if (task === "edit-video") return { overrides: {}, changes: [] };
    return profile(params, { resolution: "720p" });
  }
  if (type === "video/seedance") {
    const changes: Record<string, unknown> = { variations: "1" };
    if (model === SEEDANCE_MODELS["Seedance 2.5"]) {
      changes.draft = true;
    } else {
      changes.resolution = "480p";
    }
    return profile(params, changes);
  }
  if (type === "video/kling") {
    if (model === KLING_MODELS["Kling 4.0"]) return profile(params, { resolution: "720p" });
    if (model === KLING_MODELS["Kling 2.6 Pro Motion Control"]
      && task === KLING_TASKS["Motion control"]) {
      return { overrides: {}, changes: [] };
    }
    return { overrides: {}, changes: [] };
  }
  if (type === "video/veo") {
    return profile(params, { resolution: "720p", count: "1" });
  }
  if (type === "video/google-omni") {
    const changes: Record<string, unknown> = { variations: "1" };
    if (model !== OMNI_MODELS["Gemini Omni Flash (original)"] && task !== OMNI_TASKS["Edit video"]) {
      changes.resolution = "360p";
    }
    return profile(params, changes);
  }
  if (type === "fal/nano-banana") {
    return profile(params, { num_images: 1 });
  }
  if (type === "openai/gpt-image") {
    return profile(params, { quality: "low" },
      "Size left as set: auto, 1024x1024, 1536x1024, 1024x1536 (no node cost constants to safely rank sizes).");
  }
  return { overrides: {}, changes: [] };
}

export function lowSettingsDescription(type: string, label: string, params: Record<string, unknown>) {
  const result = getLowSettingsProfile(type, params);
  const changes = result.changes.length
    ? result.changes.join(", ")
    : "no lower setting (runs as set)";
  return `${label}: ${changes}${result.needsDecision ? `; needs a decision: ${result.needsDecision}` : ""}`;
}

export function estimateNodeCost(type: string, params: Record<string, unknown>): number | null {
  const model = String(params.model ?? "");
  const task = String(params.task ?? "");

  if (type === WAN_NODE_TYPE) {
    const rate = WAN_RATES[model] ?? WAN_RATES[WAN_DEFAULTS.model];
    const costDuration = Number(params.duration ?? WAN_DEFAULTS.duration);
    return costDuration === -1 || !Number.isFinite(costDuration) ? null : costDuration * rate;
  }
  if (type === MINIMAX_NODE_TYPE) {
    const rate = MINIMAX_RATES[model] ?? MINIMAX_RATES[MINIMAX_DEFAULTS.model];
    const costDuration = Number(params.duration ?? MINIMAX_DEFAULTS.duration);
    return Number.isFinite(costDuration) && costDuration > 0 ? costDuration * rate : null;
  }
  if (type === FLUX3_NODE_TYPE) {
    return FLUX3_RATES[task as keyof typeof FLUX3_RATES] ?? null;
  }
  if (type === FLUX3_VIDEO_NODE_TYPE) {
    if (task === "edit-video") return null;
    const rate = FLUX3_VIDEO_RATES[task as keyof typeof FLUX3_VIDEO_RATES];
    const costDuration = Number(params.duration ?? FLUX3_VIDEO_DEFAULTS.duration);
    return rate && Number.isFinite(costDuration) && costDuration > 0 ? costDuration * rate : null;
  }
  if (type === "video/seedance") {
    const rate = SEEDANCE_RATES[model] ?? 0;
    const costDuration = Number(params.duration ?? 5);
    const variations = Number(params.variations) || 1;
    return costDuration === -1 || !Number.isFinite(costDuration) || rate <= 0
      ? null
      : costDuration * rate * variations;
  }
  if (type === "video/kling") {
    if (task === KLING_TASKS["Motion control"]) return null;
    const rate = KLING_RATES[model];
    const costDuration = Number(params.duration ?? KLING_DEFAULTS.duration);
    return rate && Number.isFinite(costDuration) && costDuration > 0 ? costDuration * rate : null;
  }
  if (type === "video/veo") {
    const rate = VEO_RATES[model] ?? 0;
    const costDuration = Number(params.duration ?? 8);
    const count = Number(params.count) || 1;
    return rate && Number.isFinite(costDuration) && costDuration > 0 ? costDuration * rate * count : null;
  }
  if (type === "video/google-omni") {
    if (task === OMNI_TASKS["Edit video"]) return null;
    const rate = OMNI_RATES[model]?.[task] ?? 0;
    const costDuration = Number(params.duration ?? OMNI_DEFAULTS.duration);
    const variations = Number(params.variations) || 1;
    return rate && Number.isFinite(costDuration) && costDuration > 0 ? costDuration * rate * variations : null;
  }
  return null;
}
