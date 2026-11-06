import { registry } from "./registry";
import { KLING_MODELS, KLING_TASKS } from "./kling";
import { normalizeOmniParams, OMNI_MODELS, OMNI_TASKS } from "./omni";
import { SEEDANCE_MODELS } from "./seedance";
import { VEO_MODELS } from "./veo";
import { hasCycle } from "./executor";
import type { Graph, GraphNode } from "./types";

export type WorkflowValidationIssue = {
  severity: "error" | "warning";
  nodeId?: string;
  nodeLabel?: string;
  message: string;
};

function nodeLabel(node: GraphNode) {
  const definition = registry[node.type];
  return typeof node.params.title === "string" && node.params.title.trim()
    ? node.params.title.trim()
    : definition?.label ?? node.type;
}

function taskInputError(node: GraphNode, handles: Set<string>): string | undefined {
  const task = String(node.params.task ?? "");
  if (node.type === "video/seedance") {
    if (node.params.model !== SEEDANCE_MODELS["Seedance 2.5"]
      || !["text-to-video", "image-to-video"].includes(task)) {
      return "Atlas Cloud currently supports Seedance 2.5 Text to video and Image to video only.";
    }
    if (task === "image-to-video" && !handles.has("image")) return "Connect a first-frame image.";
  }
  if (node.type === "video/veo") {
    if (!Object.values(VEO_MODELS).includes(node.params.model as (typeof VEO_MODELS)[keyof typeof VEO_MODELS])) {
      return "Choose a supported Veo model.";
    }
    if (!["text-to-video", "image-to-video", "reference-to-video"].includes(task)) {
      return "Choose a supported Veo task.";
    }
    if (task === "image-to-video" && !handles.has("first_frame")) return "Connect a first-frame image.";
    if (task === "image-to-video" && handles.has("last_frame")
      && node.params.model !== VEO_MODELS["Veo 3.1 Lite"]) {
      return "Veo 3.1 start-and-end-frame generation is available only with Veo 3.1 Lite.";
    }
    if (task === "reference-to-video"
      && !["ingredient_1", "ingredient_2", "ingredient_3"].some((handle) => handles.has(handle))) {
      return "Connect at least one reference image.";
    }
    if (task === "reference-to-video" && node.params.model !== VEO_MODELS["Veo 3.1"]) {
      return "Reference to video is supported only by Veo 3.1.";
    }
  }
  if (node.type === "video/google-omni") {
    const savedModel = String(node.params.model ?? "");
    const model = normalizeOmniParams(node.params).model;
    if (model !== OMNI_MODELS["Gemini Omni Flash (original)"]
      || (savedModel !== model && savedModel !== OMNI_MODELS["Gemini Omni 1.1 Flash"]
        && savedModel !== "Gemini Omni 1.1 Flash")) {
      return "Choose a supported Gemini Omni model.";
    }
    if (!Object.values(OMNI_TASKS).includes(task as (typeof OMNI_TASKS)[keyof typeof OMNI_TASKS])) {
      return "Choose a supported Gemini Omni task.";
    }
    if (task === OMNI_TASKS["Image to video"] && !handles.has("image")) {
      return "Connect a first-frame image.";
    }
    if (task === OMNI_TASKS["Ingredients to video"]
      && !handles.has("reference_images")
      && !["reference_video_1", "reference_video_2", "reference_video_3"].some((handle) => handles.has(handle))) {
      return "Connect at least one reference image or video.";
    }
    if ([OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(task as never) && !handles.has("video")) {
      return `Connect a source video for ${task === OMNI_TASKS["Edit video"] ? "Edit video" : "Extend video"}.`;
    }
    if (task === OMNI_TASKS["Extend video"]) {
      return "Gemini Omni Flash (original) does not support Extend video.";
    }
  }
  if (node.type === "video/kling") {
    if (!Object.values(KLING_MODELS).includes(node.params.model as (typeof KLING_MODELS)[keyof typeof KLING_MODELS])) {
      return "Choose a supported Kling model.";
    }
    if (!Object.values(KLING_TASKS).includes(task as (typeof KLING_TASKS)[keyof typeof KLING_TASKS])) {
      return "Choose a supported Kling task.";
    }
    const isV3 = node.params.model !== KLING_MODELS["Kling 4.0"];
    if (isV3 && ![KLING_TASKS["Text to video"], KLING_TASKS["Image to video"]].includes(task as never)) {
      return "Kling V3.0 supports Text to video and Image to video only.";
    }
    if (task === KLING_TASKS["Image to video"] && !handles.has("image")) {
      return "Connect a first-frame image.";
    }
    if (task === KLING_TASKS["Ingredients to video"]
      && !["image", "reference_images"].some((handle) => handles.has(handle))
      && !["reference_video_1", "reference_video_2", "reference_video_3", "reference_video_4", "reference_video_5"]
        .some((handle) => handles.has(handle))
      && (!Array.isArray(node.params.elements) || node.params.elements.length === 0)) {
      return "Connect a reference image or video, or add a subject.";
    }
    if (task === KLING_TASKS["Edit video"] && !handles.has("video")) {
      return "Connect a source video to edit.";
    }
  }
  return undefined;
}

function requiresPrompt(node: GraphNode) {
  if (["video/veo", "video/google-omni", "video/kling"].includes(node.type)) return true;
  return node.type === "video/seedance" && node.params.task === "text-to-video"
    || ["fal/nano-banana", "google/gemini-image", "openai/gpt-image"].includes(node.type);
}

function promptSourceIsEmpty(source: GraphNode): boolean {
  if (source.type === "input/prompt") {
    return !String(source.params.refined_prompt || source.params.text || "").trim();
  }
  if (source.type === "assistant/prompt") return !String(source.params.refined_prompt ?? "").trim();
  return false;
}

export function validateWorkflow(graph: Graph, targetIds?: string[]): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  if (!targetIds && graph.nodes.length === 0) {
    return [{ severity: "error", message: "Add at least one node before running the workflow." }];
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Graph["edges"]>();
  const outgoing = new Map<string, Graph["edges"]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }

  const inScope = new Set<string>();
  const addUpstream = (id: string) => {
    const node = nodesById.get(id);
    if (!node || inScope.has(id)) return;
    inScope.add(id);
    for (const edge of incoming.get(id) ?? []) addUpstream(edge.source);
  };
  const targets = targetIds ?? graph.nodes.map((node) => node.id);
  targets.forEach(addUpstream);

  const addIssue = (severity: WorkflowValidationIssue["severity"], node: GraphNode | undefined, message: string) => {
    issues.push({
      severity,
      ...(node ? { nodeId: node.id, nodeLabel: nodeLabel(node) } : {}),
      message,
    });
  };

  for (const id of targets) {
    if (!nodesById.has(id)) addIssue("error", undefined, "A requested run target no longer exists.");
  }
  const scopedGraph: Graph = {
    nodes: graph.nodes.filter((node) => inScope.has(node.id)),
    edges: graph.edges.filter((edge) => inScope.has(edge.source) && inScope.has(edge.target)),
  };
  if (hasCycle(scopedGraph)) addIssue("error", undefined, "This workflow contains a loop. Remove the cycle before running.");

  for (const edge of graph.edges) {
    if (!inScope.has(edge.source) || !inScope.has(edge.target)) continue;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) {
      addIssue("error", target, "A connection references a missing node.");
      continue;
    }
    const sourcePort = registry[source.type]?.outputs[edge.sourceHandle];
    const targetDefinition = registry[target.type];
    const targetPort = targetDefinition?.inputs[edge.targetHandle];
    if (!sourcePort || !targetPort
      || (sourcePort !== targetPort && sourcePort !== "any" && targetPort !== "any")) {
      addIssue("error", target, `Connection from ${nodeLabel(source)} uses an invalid or incompatible port.`);
      continue;
    }
    const condition = targetDefinition.conditionalInputs?.[edge.targetHandle];
    if (condition && target.params[condition.param] !== condition.value) {
      addIssue("error", target, `The ${edge.targetHandle.replaceAll("_", " ")} connection is not supported by the selected task.`);
    }
  }

  for (const id of inScope) {
    const node = nodesById.get(id);
    if (!node) continue;
    const definition = registry[node.type];
    if (!definition) {
      addIssue("error", node, `Unknown node type: ${node.type}.`);
      continue;
    }
    if (definition.integration === "pending") {
      addIssue("error", node, "This model is not connected to a generation API yet.");
    }

    const nodeEdges = incoming.get(id) ?? [];
    const handles = new Set(nodeEdges.map((edge) => edge.targetHandle));
    const taskError = taskInputError(node, handles);
    if (taskError) addIssue("error", node, taskError);

    if (node.type === "input/image" && !String(node.params.url ?? "").trim()) {
      addIssue("error", node, "Choose an image or enter an image URL.");
    }
    if (node.type === "assistant/prompt" && !String(node.params.refined_prompt ?? "").trim()) {
      addIssue("error", node, "Send a message to the Prompt Assistant to create prompt text.");
    }
    if (requiresPrompt(node)) {
      const promptEdge = nodeEdges.find((edge) => edge.targetHandle === "prompt");
      if (!promptEdge) {
        addIssue("error", node, "Connect a Prompt node.");
      } else {
        const promptNode = nodesById.get(promptEdge.source);
        if (promptNode && promptSourceIsEmpty(promptNode)) {
          addIssue("error", node, `The connected ${nodeLabel(promptNode)} has no prompt text yet.`);
        }
      }
    }
    if (node.type === "output/preview" && !handles.has("media")) {
      addIssue("warning", node, "Connect an image or video to preview.");
    }

    const producesMedia = node.type.startsWith("video/")
      || ["fal/nano-banana", "google/gemini-image", "openai/gpt-image", "fal/model"].includes(node.type);
    if (producesMedia && (definition.outputs.image || definition.outputs.video)
      && (outgoing.get(id) ?? []).length === 0) {
      addIssue("warning", node, "Its generated output is not connected to another node, such as Preview.");
    }
  }

  return issues;
}
