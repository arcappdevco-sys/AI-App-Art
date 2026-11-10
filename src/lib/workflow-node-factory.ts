import type { Edge, Node } from "@xyflow/react";
import { WAN_NODE_TYPE } from "./wan";
import { MINIMAX_NODE_TYPE } from "./minimax";
import { FLUX3_VIDEO_NODE_TYPE } from "./flux3-video";
import type { NodeDef } from "./types";

export const videoModelTypes = [
  WAN_NODE_TYPE, MINIMAX_NODE_TYPE, FLUX3_VIDEO_NODE_TYPE, "video/seedance",
  "video/kling", "video/veo", "video/google-omni",
] as const;

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
