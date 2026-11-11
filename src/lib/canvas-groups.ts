import type { Node } from "@xyflow/react";

export const GROUP_COLORS = {
  default: "var(--accent)",
  blue: "#3478ba",
  teal: "#168275",
  green: "#518139",
  amber: "#a36512",
  red: "#ad4e4e",
  purple: "#8059ad",
  slate: "#627389",
} as const;

export type GroupColor = keyof typeof GROUP_COLORS;
export type CanvasGroup = {
  id: string;
  title: string;
  color: GroupColor;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const GROUP_MIN_WIDTH = 160;
export const GROUP_MIN_HEIGHT = 100;

export function normalizeCanvasGroups(value: unknown): CanvasGroup[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap((item): CanvasGroup[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const group = item as Record<string, unknown>;
    if (typeof group.id !== "string" || !group.id.trim() || ids.has(group.id)
      || typeof group.title !== "string" || typeof group.color !== "string"
      || !Object.hasOwn(GROUP_COLORS, group.color)
      || typeof group.x !== "number" || !Number.isFinite(group.x)
      || typeof group.y !== "number" || !Number.isFinite(group.y)
      || typeof group.width !== "number" || !Number.isFinite(group.width) || group.width < GROUP_MIN_WIDTH
      || typeof group.height !== "number" || !Number.isFinite(group.height) || group.height < GROUP_MIN_HEIGHT) return [];
    ids.add(group.id);
    return [{
      id: group.id, title: group.title.trim() || "Group", color: group.color as GroupColor,
      x: group.x, y: group.y, width: group.width, height: group.height,
    }];
  });
}

function nodeSize(node: Node) {
  return {
    width: node.measured?.width ?? node.width ?? node.initialWidth ?? 0,
    height: node.measured?.height ?? node.height ?? node.initialHeight ?? 0,
  };
}

export function nodesInsideGroup(group: CanvasGroup, nodes: Node[]) {
  return nodes.filter((node) => {
    const { width, height } = nodeSize(node);
    const x = node.position.x + width / 2;
    const y = node.position.y + height / 2;
    return x >= group.x && x <= group.x + group.width && y >= group.y && y <= group.y + group.height;
  });
}

export function groupBoundsForNodes(nodes: Node[]) {
  if (!nodes.length) return null;
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + nodeSize(node).width));
  const bottom = Math.max(...nodes.map((node) => node.position.y + nodeSize(node).height));
  return {
    x: left - 40, y: top - 70,
    width: Math.max(GROUP_MIN_WIDTH, right - left + 80),
    height: Math.max(GROUP_MIN_HEIGHT, bottom - top + 110),
  };
}

export function createCanvasGroup(bounds: Pick<CanvasGroup, "x" | "y" | "width" | "height">): CanvasGroup {
  return { id: crypto.randomUUID(), title: "Group", color: "default", ...bounds };
}
