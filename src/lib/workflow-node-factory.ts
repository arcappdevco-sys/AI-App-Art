import type { Edge, Node } from "@xyflow/react";
import { MINIMAX_NODE_TYPE, MINIMAX_VARIANTS } from "./minimax";
import { FLUX3_VIDEO_DURATIONS, FLUX3_VIDEO_NODE_TYPE, FLUX3_VIDEO_RATIOS } from "./flux3-video";
import { OMNI_MODELS } from "./omni";
import { WAN_MAX_DURATION_SECONDS, WAN_MIN_DURATION_SECONDS, WAN_NODE_TYPE } from "./wan";
import type { NodeDef } from "./types";
import { VFX_VIDEO_REFINE_NODE_TYPE } from "./vfx-relight";

export const videoModelTypes = [
  WAN_NODE_TYPE, MINIMAX_NODE_TYPE, FLUX3_VIDEO_NODE_TYPE, "video/seedance",
  "video/kling", "video/veo", "video/google-omni",
] as const;
const videoOutputTypes = [...videoModelTypes, VFX_VIDEO_REFINE_NODE_TYPE] as const;

export type ImageToVideoModelOption = {
  type: string;
  label: string;
  task: string;
  imageHandle: string;
  params: Record<string, unknown>;
};

export type FirstLastFrameModelOption = {
  type: string;
  label: string;
  task: string;
  firstFrameHandle: string;
  lastFrameHandle: string;
  params: Record<string, unknown>;
};

export type StoryboardVideoSettings = {
  aspectRatio: string;
  durationSeconds: number | null;
  hasLastFrame: boolean;
};

const firstLastFrameModelLabels: Record<string, string> = {
  "video/veo": "Veo 3.1 Lite",
  "video/google-omni": "Gemini Omni 1.2 Flash",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskOptions(def: NodeDef, taskParam: NodeDef["params"][number] | undefined) {
  return [
    ...(taskParam?.options ?? []),
    ...Object.entries(def.conditionalInputs ?? {})
      .filter(([handle, condition]) => def.inputs[handle] === "image" && condition.param === "task")
      .map(([, condition]) => String(condition.value)),
  ];
}

function isTaskLabel(def: NodeDef, taskParam: NodeDef["params"][number] | undefined, task: string, pattern: RegExp) {
  const label = taskParam?.optionLabels?.[task] ?? task;
  return pattern.test(label.toLowerCase().replace(/[-_]+/g, " "));
}

function supportsTask(
  taskParam: NodeDef["params"][number] | undefined,
  modelParam: NodeDef["params"][number] | undefined,
  model: string,
  task: string,
) {
  if (taskParam?.optionsByParam && modelParam
    && taskParam.optionsByParam.param === modelParam.key) {
    return (taskParam.optionsByParam.values[model] ?? taskParam.options ?? []).includes(task);
  }
  return !taskParam?.options || taskParam.options.includes(task);
}

function modelAndTaskParams(
  def: NodeDef,
  taskParam: NodeDef["params"][number] | undefined,
  task: string,
  preferredModelLabel?: string,
) {
  const modelParam = def.params.find((param) => param.key === "model");
  let model = modelParam?.default;
  if (modelParam?.options?.length) {
    const supportedModels = modelParam.options.filter((candidate) =>
      supportsTask(taskParam, modelParam, candidate, task),
    );
    if (!supportedModels.length) return null;
    const preferredModel = preferredModelLabel && supportedModels.find(
      (candidate) => modelParam.optionLabels?.[candidate] === preferredModelLabel,
    );
    if (preferredModel) model = preferredModel;
    else if (!supportedModels.includes(String(model))) model = supportedModels[0];
  } else if (model !== undefined && !supportsTask(taskParam, modelParam, String(model), task)) {
    return null;
  }

  const params: Record<string, unknown> = { task };
  if (model !== undefined) params.model = model;
  if (taskParam && modelParam?.default && typeof modelParam.default === "string"
    && modelParam.default.endsWith(`/${String(taskParam.default)}`)) {
    params.model = modelParam.default.slice(0, -String(taskParam.default).length) + task;
  }
  return params;
}

function imageHandleForTask(def: NodeDef, handle: string, task: string) {
  if (def.inputs[handle] !== "image") return false;
  const condition = def.conditionalInputs?.[handle];
  return !condition || (condition.param === "task" && condition.value === task);
}

function durationChoices(
  type: string,
  def: NodeDef,
  params: Record<string, unknown>,
): number[] {
  const durationParam = def.params.find((param) => param.key === "duration");
  if (!durationParam) return [];
  const dynamicOptions = durationParam.optionsByParam
    ? durationParam.optionsByParam.values[String(params[durationParam.optionsByParam.param])]
    : undefined;
  const options = dynamicOptions ?? durationParam.options;
  if (options?.length) {
    return options.map(Number).filter((value) => Number.isInteger(value) && value > 0);
  }
  if (type === WAN_NODE_TYPE) {
    return Array.from(
      { length: WAN_MAX_DURATION_SECONDS - WAN_MIN_DURATION_SECONDS + 1 },
      (_, index) => index + WAN_MIN_DURATION_SECONDS,
    );
  }
  if (type === MINIMAX_NODE_TYPE) {
    const model = String(params.model ?? "");
    const variant = Object.entries(MINIMAX_VARIANTS)
      .find(([modelId]) => modelId === model)?.[1];
    return variant
      ? Array.from({ length: 16 - variant.minDuration }, (_, index) => variant.minDuration + index)
      : [];
  }
  if (type === FLUX3_VIDEO_NODE_TYPE) return [...FLUX3_VIDEO_DURATIONS];
  return [];
}

function aspectRatioValue(value: string) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : undefined;
}

function closestAspectRatio(options: readonly string[], target: string) {
  const targetValue = aspectRatioValue(target);
  if (targetValue === undefined) return undefined;
  let closest: string | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const value = aspectRatioValue(option);
    if (value === undefined) continue;
    const distance = Math.abs(Math.log(value / targetValue));
    if (distance < closestDistance) {
      closest = option;
      closestDistance = distance;
    }
  }
  return closest;
}

export function getStoryboardVideoParamOverrides(
  type: string,
  definitions: Record<string, NodeDef>,
  params: Record<string, unknown>,
  settings: StoryboardVideoSettings,
): Record<string, unknown> {
  const def = definitions[type];
  if (!def) throw new Error(`Unknown node type: ${type}`);
  const overrides: Record<string, unknown> = {};
  const targetDuration = settings.durationSeconds;

  if (typeof targetDuration === "number" && Number.isFinite(targetDuration) && targetDuration > 0) {
    const durationParam = def.params.find((param) => param.key === "duration");
    let options = durationChoices(type, def, params);
    if (type === "video/google-omni") {
      const maximum = params.model === OMNI_MODELS["Gemini Omni 1.2 Flash"] && !settings.hasLastFrame ? 15 : 10;
      options = options.filter((duration) => duration <= maximum);
    }
    const closest = options.reduce<number | undefined>((best, duration) => {
      if (best === undefined) return duration;
      const distance = Math.abs(duration - targetDuration);
      const bestDistance = Math.abs(best - targetDuration);
      return distance < bestDistance || (distance === bestDistance && duration < best) ? duration : best;
    }, undefined);
    if (durationParam && closest !== undefined) {
      overrides.duration = typeof durationParam.default === "number" ? closest : String(closest);
    }
  }

  const aspectRatioParamKey = type === FLUX3_VIDEO_NODE_TYPE
    || type === "video/veo"
    || type === "video/google-omni"
    ? "aspect_ratio"
    : undefined;
  if (aspectRatioParamKey) {
    const ratioParam = def.params.find((param) => param.key === aspectRatioParamKey);
    const options = type === FLUX3_VIDEO_NODE_TYPE
      ? FLUX3_VIDEO_RATIOS
      : ratioParam?.options ?? [];
    const closest = closestAspectRatio(options, settings.aspectRatio);
    if (closest) overrides[aspectRatioParamKey] = closest;
  }
  return overrides;
}

export function getImageToVideoModelOptions(
  definitions: Record<string, NodeDef>,
): ImageToVideoModelOption[] {
  return videoModelTypes.flatMap((type) => {
    const def = definitions[type];
    if (!def) return [];
    const taskParam = def.params.find((param) => param.key === "task");
    const imageTask = taskOptions(def, taskParam)
      .find((task) => isTaskLabel(def, taskParam, task, /image to video/));
    if (!imageTask) return [];

    const conditionalImageHandle = Object.entries(def.conditionalInputs ?? {}).find(
      ([handle, condition]) => imageHandleForTask(def, handle, imageTask)
        && condition.param === "task"
        && condition.value === imageTask,
    )?.[0];
    const imageHandle = conditionalImageHandle
      ?? Object.keys(def.inputs).find((handle) => imageHandleForTask(def, handle, imageTask));
    if (!imageHandle) return [];

    const params = modelAndTaskParams(def, taskParam, imageTask);
    if (!params) return [];

    return [{ type, label: def.label, task: imageTask, imageHandle, params }];
  });
}

export function getFirstLastFrameModelOptions(
  definitions: Record<string, NodeDef>,
): FirstLastFrameModelOption[] {
  return videoModelTypes.flatMap((type) => {
    const def = definitions[type];
    if (!def) return [];
    const taskParam = def.params.find((param) => param.key === "task");
    const options = taskOptions(def, taskParam);
    const task = options.find((candidate) =>
      isTaskLabel(def, taskParam, candidate, /first (and )?last frame/),
    ) ?? options.find((candidate) => isTaskLabel(def, taskParam, candidate, /image to video/));
    if (!task) return [];

    const params = modelAndTaskParams(
      def,
      taskParam,
      task,
      firstLastFrameModelLabels[type],
    );
    if (!params) return [];
    const model = String(params.model ?? "");
    const firstFrameHandle = ["first_frame", "start_image", "image"].find(
      (handle) => imageHandleForTask(def, handle, task),
    );
    const klingLastFrameHandle = type === "video/kling"
      ? model.includes("kling-v3.") ? "end_image" : "last_image"
      : undefined;
    const lastFrameHandle = klingLastFrameHandle
      ?? ["last_frame", "end_image", "last_image"].find(
        (handle) => imageHandleForTask(def, handle, task),
      );
    if (!firstFrameHandle || !lastFrameHandle) return [];

    return [{ type, label: def.label, task, firstFrameHandle, lastFrameHandle, params }];
  });
}

export function createWorkflowNodes(
  type: string,
  definitions: Record<string, NodeDef>,
  position: { x: number; y: number },
): { nodes: Node[]; edges: Edge[] } {
  const def = definitions[type];
  if (!def) throw new Error(`Unknown node type: ${type}`);
  const createNode = (nodeDef: NodeDef, nodePosition: { x: number; y: number }): Node => ({
    id: `${nodeDef.type}-${crypto.randomUUID()}`,
    type: "workflow",
    position: nodePosition,
    data: {
      type: nodeDef.type,
      params: Object.fromEntries(nodeDef.params.map((param) => [param.key, param.default ?? ""])),
      status: "idle",
      outputs: {},
      log: "",
    },
  });
  const node = createNode(def, def.autoPrompt ? { x: position.x + 360, y: position.y } : position);
  const nodes: Node[] = [node];
  const edges: Edge[] = [];

  if (def.autoPrompt) {
    const prompt = createNode(definitions["input/prompt"], position);
    nodes.unshift(prompt);
    edges.push({
      id: `${prompt.id}-${node.id}`,
      source: prompt.id, sourceHandle: "text", target: node.id, targetHandle: "prompt",
    });
  }
  if (videoOutputTypes.some((videoType) => videoType === type)) {
    const preview = createNode(definitions["output/preview"], {
      x: node.position.x + 360, y: node.position.y,
    });
    nodes.push(preview);
    edges.push({
      id: `${node.id}-${preview.id}`,
      source: node.id, sourceHandle: "video", target: preview.id, targetHandle: "media",
    });
  }
  return { nodes, edges };
}

export function createImageToVideoWorkflowNodes(
  type: string,
  definitions: Record<string, NodeDef>,
  position: { x: number; y: number },
): { nodes: Node[]; edges: Edge[]; imageHandle: string; label: string } {
  const option = getImageToVideoModelOptions(definitions).find((candidate) => candidate.type === type);
  if (!option) throw new Error(`Node type does not support image-to-video: ${type}`);

  const graph = createWorkflowNodes(type, definitions, position);
  return {
    ...graph,
    imageHandle: option.imageHandle,
    label: option.label,
    nodes: graph.nodes.map((node) => node.data.type === type
      ? {
        ...node,
        data: {
          ...node.data,
          params: { ...(isRecord(node.data.params) ? node.data.params : {}), ...option.params },
        },
      }
      : node),
  };
}

export function createFirstLastFrameWorkflowNodes(
  type: string,
  definitions: Record<string, NodeDef>,
  position: { x: number; y: number },
): { nodes: Node[]; edges: Edge[]; firstFrameHandle: string; lastFrameHandle: string; label: string } {
  const option = getFirstLastFrameModelOptions(definitions).find((candidate) => candidate.type === type);
  if (!option) throw new Error(`Node type does not support first-and-last-frame video: ${type}`);

  const graph = createWorkflowNodes(type, definitions, position);
  return {
    ...graph,
    firstFrameHandle: option.firstFrameHandle,
    lastFrameHandle: option.lastFrameHandle,
    label: option.label,
    nodes: graph.nodes.map((node) => node.data.type === type
      ? {
        ...node,
        data: {
          ...node.data,
          params: { ...(isRecord(node.data.params) ? node.data.params : {}), ...option.params },
        },
      }
      : node),
  };
}
