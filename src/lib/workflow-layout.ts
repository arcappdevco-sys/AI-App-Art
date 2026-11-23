import type { Edge, Node } from "@xyflow/react";
import {
  createCanvasGroup, getNodeDimensions, groupBoundsForNodes, nodesInsideGroup,
  type CanvasGroup,
} from "./canvas-groups";

const NODE_GAP_X = 140;
const NODE_GAP_Y = 80;
const COMPONENT_GAP_Y = 140;
const CANVAS_PADDING = 80;

function connectedComponents(nodes: Node[], edges: Edge[], groupMembers: string[][] = []) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const connect = (first: string, second: string) => {
    if (!nodeIds.has(first) || !nodeIds.has(second) || first === second) return;
    neighbors.get(first)?.add(second);
    neighbors.get(second)?.add(first);
  };

  for (const edge of edges) connect(edge.source, edge.target);
  for (const members of groupMembers) {
    for (let index = 1; index < members.length; index += 1) {
      connect(members[0], members[index]);
    }
  }

  const visited = new Set<string>();
  const components: Node[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const component: Node[] = [];
    const pending = [node.id];
    visited.add(node.id);
    while (pending.length) {
      const current = pending.pop()!;
      const member = nodeById.get(current);
      if (member) component.push(member);
      for (const neighbor of neighbors.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function layoutComponent(nodes: Node[], edges: Edge[], startY: number) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const incomingCount = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) continue;
    outgoing.get(edge.source)?.push(edge.target);
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  const roots = nodes.filter((node) => incomingCount.get(node.id) === 0);
  const pending = roots.length ? roots.map((node) => node.id) : [nodes[0].id];
  const ranks = new Map(pending.map((id) => [id, 0]));
  const processed = new Set<string>();
  while (pending.length) {
    const id = pending.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    for (const target of outgoing.get(id) ?? []) {
      if (processed.has(target)) continue;
      ranks.set(target, Math.max(ranks.get(target) ?? 0, (ranks.get(id) ?? 0) + 1));
      const remaining = (incomingCount.get(target) ?? 0) - 1;
      incomingCount.set(target, remaining);
      if (remaining === 0) pending.push(target);
    }
  }

  const nextRank = Math.max(0, ...ranks.values()) + 1;
  for (const node of nodes) {
    if (!ranks.has(node.id)) ranks.set(node.id, nextRank);
  }
  const maxRank = Math.max(...ranks.values());
  const layers = Array.from({ length: maxRank + 1 }, () => [] as Node[]);
  for (const node of nodes) layers[ranks.get(node.id) ?? 0].push(node);

  const sizes = new Map(nodes.map((node) => {
    const dimensions = getNodeDimensions(node);
    return [node.id, {
      width: dimensions.width || 250,
      height: dimensions.height || 180,
    }];
  }));
  const layerHeights = layers.map((layer) => layer.reduce((height, node, index) =>
    height + (sizes.get(node.id)?.height ?? 180) + (index ? NODE_GAP_Y : 0), 0));
  const componentHeight = Math.max(...layerHeights);
  const columnWidths = layers.map((layer) => Math.max(...layer.map((node) => sizes.get(node.id)?.width ?? 250)));
  const positions = new Map<string, { x: number; y: number }>();
  let x = CANVAS_PADDING;
  for (let rank = 0; rank < layers.length; rank += 1) {
    let y = startY;
    for (const node of layers[rank]) {
      positions.set(node.id, { x, y });
      y += (sizes.get(node.id)?.height ?? 180) + NODE_GAP_Y;
    }
    x += columnWidths[rank] + NODE_GAP_X;
  }
  return { positions, height: componentHeight };
}

export function autoLayoutWorkflow(
  nodes: Node[],
  edges: Edge[],
  groups: CanvasGroup[],
  titleForNode: (node: Node) => string | undefined,
): { nodes: Node[]; groups: CanvasGroup[] } {
  if (!nodes.length) return { nodes, groups };

  const memberships = groups.map((group) => ({
    group,
    ids: nodesInsideGroup(group, nodes).map((node) => node.id),
  }));
  const groupMembers = memberships.map(({ ids }) => ids).filter((ids) => ids.length > 1);
  const components = connectedComponents(nodes, edges, groupMembers);
  const positions = new Map<string, { x: number; y: number }>();
  let y = CANVAS_PADDING;
  for (const component of components) {
    const layout = layoutComponent(component, edges, y);
    for (const [id, position] of layout.positions) positions.set(id, position);
    y += layout.height + COMPONENT_GAP_Y;
  }

  const arrangedNodes = nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }));
  const groupedIds = new Set(memberships.flatMap(({ ids }) => ids));
  const arrangedGroups = memberships.map(({ group, ids }) => {
    const members = arrangedNodes.filter((node) => ids.includes(node.id));
    const bounds = groupBoundsForNodes(members);
    return bounds ? { ...group, ...bounds } : group;
  });
  const ungroupedNodes = arrangedNodes.filter((node) => !groupedIds.has(node.id));
  for (const component of connectedComponents(ungroupedNodes, edges)) {
    if (component.length < 2) continue;
    const bounds = groupBoundsForNodes(component);
    if (!bounds) continue;
    const title = component.map(titleForNode).find((label) => label?.trim())?.trim() || "Workflow";
    arrangedGroups.push({ ...createCanvasGroup(bounds), title });
  }
  return { nodes: arrangedNodes, groups: arrangedGroups };
}
