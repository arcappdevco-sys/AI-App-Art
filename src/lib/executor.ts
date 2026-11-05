import { registry } from "./registry";
import type { Graph, NodeStatus } from "./types";

type Outputs = Record<string, any>;

export interface RunOpts {
  /** Persist this Map between runs: unchanged nodes are skipped (saves fal credits). */
  cache: Map<string, { key: string; outputs: Outputs }>;
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
  if (hasCycle(graph)) throw new Error("This graph has a loop. Remove the cycle and run again.");

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Promise<Outputs>>();
  graph.nodes.forEach((n) => o.onStatus(n.id, "queued", ""));

  // Each node awaits its upstream nodes, so independent branches run in parallel.
  const visit = (id: string): Promise<Outputs> => {
    if (memo.has(id)) return memo.get(id)!;
    const p = (async () => {
      const node = byId.get(id)!;
      const def = registry[node.type];
      if (!def) throw new Error(`Unknown node type: ${node.type}`);

      const inputs: Outputs = {};
      try {
        for (const e of graph.edges.filter((e) => e.target === id)) {
          const up = await visit(e.source);
          inputs[e.targetHandle] = up[e.sourceHandle];
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

  await Promise.allSettled(graph.nodes.map((n) => visit(n.id)));
}
