import { registry } from "./registry";
import type { Graph, NodeStatus } from "./types";

type Outputs = Record<string, any>;

export interface RunOpts {
  /** Persist this Map between runs: unchanged nodes are skipped (saves fal credits). */
  cache: Map<string, { key: string; outputs: Outputs }>;
  targetIds?: string[];
  signal?: AbortSignal;
  onStatus: (id: string, status: NodeStatus, info?: string) => void;
  onOutput: (id: string, outputs: Outputs) => void;
}

export function hasCycle(graph: Graph): boolean {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  graph.edges.forEach((e) => indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1));
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.pop()!;
    seen++;
    graph.edges.filter((e) => e.source === id).forEach((e) => {
      const d = (indeg.get(e.target) ?? 1) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    });
  }
  return seen !== graph.nodes.length;
}

export async function runGraph(graph: Graph, o: RunOpts) {
  const targets = o.targetIds ?? graph.nodes.map((node) => node.id);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  graph.edges.forEach((edge) => incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]));
  const inScope = new Set<string>();
  const includeUpstream = (id: string) => {
    if (!byId.has(id)) throw new Error(`Cannot run unknown node: ${id}`);
    if (inScope.has(id)) return;
    inScope.add(id);
    (incoming.get(id) ?? []).forEach(includeUpstream);
  };
  targets.forEach(includeUpstream);

  const scopedGraph: Graph = {
    nodes: graph.nodes.filter((node) => inScope.has(node.id)),
    edges: graph.edges.filter((edge) => inScope.has(edge.source) && inScope.has(edge.target)),
  };
  if (hasCycle(scopedGraph)) throw new Error("This graph has a loop. Remove the cycle and run again.");

  const memo = new Map<string, Promise<Outputs>>();
  scopedGraph.nodes.forEach((n) => o.onStatus(n.id, "queued", ""));

  // Each node awaits its upstream nodes, so independent branches run in parallel.
  const visit = (id: string): Promise<Outputs> => {
    if (memo.has(id)) return memo.get(id)!;
    const p = (async () => {
      const node = byId.get(id)!;
      const def = registry[node.type];
      if (!def) throw new Error(`Unknown node type: ${node.type}`);

      const inputs: Outputs = {};
      try {
        for (const e of scopedGraph.edges.filter((e) => e.target === id)) {
          const up = await visit(e.source);
          if (["video/seedance", "video/google-omni", "video/kling"].includes(node.type)
            && e.targetHandle === "reference_images") {
            const references = (inputs.reference_images ??= []);
            references.push(up[e.sourceHandle]);
          } else if (node.type === "video/kling" && e.targetHandle === "middle_images") {
            const middleFrames = (inputs.middle_images ??= []);
            middleFrames.push(up[e.sourceHandle]);
          } else {
            inputs[e.targetHandle] = up[e.sourceHandle];
          }
        }
      } catch (err) {
        o.onStatus(id, "idle", "Skipped: an upstream node failed");
        throw err;
      }

      const key = JSON.stringify([node.type, node.params, inputs]);
      const hit = o.cache.get(id);
      if (hit?.key === key) {
        o.onOutput(id, hit.outputs);
        o.onStatus(id, "done", "cached");
        return hit.outputs;
      }

      if (o.signal?.aborted) throw new Error("Cancelled");
      o.onStatus(id, "running", "");
      try {
        const outputs = await def.execute({
          inputs,
          params: node.params,
          signal: o.signal,
          log: (m) => o.onStatus(id, "running", m),
        });
        o.cache.set(id, { key, outputs });
        o.onOutput(id, outputs);
        o.onStatus(id, "done", "");
        return outputs;
      } catch (err: any) {
        o.onStatus(id, "error", err?.message ?? String(err));
        throw err;
      }
    })();
    p.catch(() => {}); // failures are reported via onStatus
    memo.set(id, p);
    return p;
  };

  await Promise.allSettled(targets.map((id) => visit(id)));
}
