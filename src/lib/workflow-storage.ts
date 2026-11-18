import type { Edge } from "@xyflow/react";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasValidWorkflowEdgeReferences(value: unknown, nodeIds: Set<string>): value is Edge {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.source === "string" && nodeIds.has(value.source)
    && typeof value.target === "string" && nodeIds.has(value.target)
    && typeof value.sourceHandle === "string" && typeof value.targetHandle === "string";
}

export function stripInvalidWorkflowConnections(value: unknown): { workflow: unknown; removed: number } {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return { workflow: value, removed: 0 };
  }
  const nodeIds = new Set(value.nodes.flatMap((node) =>
    isRecord(node) && typeof node.id === "string" ? [node.id] : []
  ));
  const edges = value.edges.filter((edge) => hasValidWorkflowEdgeReferences(edge, nodeIds));
  return {
    workflow: edges.length === value.edges.length ? value : { ...value, edges },
    removed: value.edges.length - edges.length,
  };
}
