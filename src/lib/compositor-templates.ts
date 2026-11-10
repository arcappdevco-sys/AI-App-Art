import type { Edge, Node } from "@xyflow/react";
import { COMPOSITOR_DEFAULTS, COMPOSITOR_LABELS, type CompositorKind, type CompositorParams } from "./compositor";

export type CompositorNodeData = { kind: CompositorKind; params: CompositorParams; label: string; disabled?: boolean };
export type CompositorNode = Node<CompositorNodeData>;
export type TemplateId = "color" | "key" | "mask" | "tracking";
type TemplateNode = { key: string; kind: CompositorKind; x: number; y: number; label?: string };
type TemplateEdge = { from: string; to: string; input: string };
type Template = { id: TemplateId; name: string; description: string; nodes: TemplateNode[]; edges: TemplateEdge[] };

export const COMPOSITOR_TEMPLATES: Template[] = [
  {
    id: "color", name: "Color correction", description: "Grade an image or video.",
    nodes: [{ key: "source", kind: "media", x: 0, y: 100 }, { key: "color", kind: "color", x: 250, y: 100 }, { key: "viewer", kind: "viewer", x: 500, y: 100 }],
    edges: [{ from: "source", to: "color", input: "image" }, { from: "color", to: "viewer", input: "image" }],
  },
  {
    id: "key", name: "Keyer", description: "Remove a color from a foreground and place it over a background.",
    nodes: [
      { key: "background", kind: "media", label: "Background", x: 0, y: 0 },
      { key: "foreground", kind: "media", label: "Foreground", x: 0, y: 200 },
      { key: "key", kind: "key", x: 250, y: 200 }, { key: "merge", kind: "merge", x: 500, y: 100 },
      { key: "viewer", kind: "viewer", x: 750, y: 100 },
    ],
    edges: [{ from: "foreground", to: "key", input: "image" }, { from: "key", to: "merge", input: "foreground" },
      { from: "background", to: "merge", input: "background" }, { from: "merge", to: "viewer", input: "image" }],
  },
  {
    id: "mask", name: "Masking", description: "Apply a rectangular mask to an image or video.",
    nodes: [{ key: "source", kind: "media", x: 0, y: 100 }, { key: "mask", kind: "mask", x: 250, y: 100 }, { key: "viewer", kind: "viewer", x: 500, y: 100 }],
    edges: [{ from: "source", to: "mask", input: "image" }, { from: "mask", to: "viewer", input: "image" }],
  },
  {
    id: "tracking", name: "Tracking", description: "Track background video, then attach an overlay image to its motion.",
    nodes: [
      { key: "background", kind: "media", label: "Background video", x: 0, y: 0 },
      { key: "overlay", kind: "media", label: "Overlay image", x: 0, y: 300 },
      { key: "tracker", kind: "tracker", x: 250, y: 0 }, { key: "transform", kind: "transform", x: 500, y: 300 },
      { key: "merge", kind: "merge", x: 750, y: 200 }, { key: "viewer", kind: "viewer", x: 1000, y: 0 },
    ],
    edges: [{ from: "background", to: "tracker", input: "image" }, { from: "background", to: "merge", input: "background" },
      { from: "background", to: "viewer", input: "image" }, { from: "overlay", to: "transform", input: "image" },
      { from: "tracker", to: "transform", input: "motion" }, { from: "transform", to: "merge", input: "foreground" }],
  },
];

export type CompositorNodeOption = { kind: CompositorKind; label: string };

export const COMPOSITOR_NODE_OPTIONS: CompositorNodeOption[] = [
  ...(Object.keys(COMPOSITOR_LABELS) as CompositorKind[]).map((kind) => ({ kind, label: COMPOSITOR_LABELS[kind] })),
];
for (const template of COMPOSITOR_TEMPLATES) {
  for (const node of template.nodes) {
    const label = node.label ?? COMPOSITOR_LABELS[node.kind];
    if (!COMPOSITOR_NODE_OPTIONS.some((option) => option.kind === node.kind && option.label === label)) {
      COMPOSITOR_NODE_OPTIONS.push({ kind: node.kind, label });
    }
  }
}

export function createCompositorNode(option: CompositorNodeOption, id: string, position: { x: number; y: number }): CompositorNode {
  return {
    id, type: "comp", position,
    data: { kind: option.kind, label: option.label, params: { ...COMPOSITOR_DEFAULTS[option.kind] } },
  };
}

export function createCompositorTemplate(id: TemplateId, createId: () => string): { nodes: CompositorNode[]; edges: Edge[] } {
  const template = COMPOSITOR_TEMPLATES.find((item) => item.id === id);
  if (!template) throw new Error("Unknown compositor template.");
  const ids = new Map(template.nodes.map((node) => [node.key, createId()]));
  const nodes = template.nodes.map((node) => createCompositorNode(
    { kind: node.kind, label: node.label ?? COMPOSITOR_LABELS[node.kind] }, ids.get(node.key)!, { x: node.x, y: node.y },
  ));
  const edges: Edge[] = template.edges.map((edge) => ({
    id: createId(), source: ids.get(edge.from)!, target: ids.get(edge.to)!, sourceHandle: "output", targetHandle: edge.input,
  }));
  return { nodes, edges };
}
