import type { Edge, Node } from "@xyflow/react";
import { WAN_NODE_TYPE } from "./wan";
import { MINIMAX_NODE_TYPE } from "./minimax";
import { FLUX3_VIDEO_NODE_TYPE } from "./flux3-video";
import type { NodeDef } from "./types";

export const videoModelTypes = [
  WAN_NODE_TYPE, MINIMAX_NODE_TYPE, FLUX3_VIDEO_NODE_TYPE, "video/seedance",
  "video/kling", "video/veo", "video/google-omni",
] as const;

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
  if (videoModelTypes.some((videoType) => videoType === type)) {
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
