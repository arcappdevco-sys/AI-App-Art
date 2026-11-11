type WanConnection = {
  source: string;
  target: string;
  targetHandle?: string | null;
};

type WanSource = {
  id: string;
  data: Record<string, unknown>;
};

export function isWanAutomaticInput(source: WanSource | undefined, ownerId: string) {
  return source?.data.type === "input/image"
    && (source.data.autoCreatedFor === ownerId || source.data.wanAutoCreatedFor === ownerId);
}

export function selectWanIncoming<T extends WanConnection>(
  edges: T[],
  nodes: WanSource[],
  ownerId: string,
) {
  const sources = new Map(nodes.map((node) => [node.id, node]));
  const selected = new Map<string, T>();
  for (const edge of edges) {
    if (edge.target !== ownerId) continue;
    const handle = edge.targetHandle ?? "";
    const previous = selected.get(handle);
    if (!previous || (isWanAutomaticInput(sources.get(previous.source), ownerId)
      && !isWanAutomaticInput(sources.get(edge.source), ownerId))) {
      selected.set(handle, edge);
    }
  }
  return selected;
}
