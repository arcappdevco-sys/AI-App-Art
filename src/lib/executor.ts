import { registry } from "./registry";
import { getLowSettingsProfile } from "./runModeLowSettings";
import { formatCameraTrackGuide } from "./camera-guide";
import { VFX_VIDEO_REFINE_NODE_TYPE } from "./vfx-relight";
import type { Graph, NodeStatus } from "./types";

type Outputs = Record<string, unknown>;

export interface RunOpts {
  /** Persist this Map between runs: unchanged nodes are skipped (saves fal credits). */
  cache: Map<string, { key: string; outputs: Outputs }>;
  fresh?: boolean;
  lowSettings?: boolean;
  targetIds?: string[];
  signal?: AbortSignal;
  onStatus: (id: string, status: NodeStatus, info?: string) => void;
  onOutput: (id: string, outputs: Outputs) => void;
  onParams?: (id: string, patch: Record<string, unknown>) => void;
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

export function isEmptyOptionalOmniImage(graph: Graph, nodeId: string): boolean {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node?.type !== "input/image" || String(node.params.url ?? "").trim()) return false;
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId);
  return outgoing.length > 0 && outgoing.every((edge) => {
    const target = graph.nodes.find((candidate) => candidate.id === edge.target);
    return target?.type === "video/google-omni" && ["last_image", "reference_images"].includes(edge.targetHandle);
  });
}

export async function runGraph(graph: Graph, o: RunOpts) {
  const targets = (o.targetIds ?? graph.nodes.map((node) => node.id))
    .filter((id) => o.targetIds?.includes(id) || !isEmptyOptionalOmniImage(graph, id));
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
  scopedGraph.nodes.forEach((n) => o.onStatus(n.id,
    isEmptyOptionalOmniImage(graph, n.id) && !o.targetIds?.includes(n.id) ? "idle" : "queued", ""));

  // Each node awaits its upstream nodes, so independent branches run in parallel.
  const visit = (id: string): Promise<Outputs> => {
    if (memo.has(id)) return memo.get(id)!;
    const p = (async () => {
      const node = byId.get(id)!;
      const def = registry[node.type];
      if (!def) throw new Error(`Unknown node type: ${node.type}`);
      const params = o.lowSettings
        ? { ...node.params, ...getLowSettingsProfile(node.type, node.params).overrides }
        : node.params;

      const inputs: Outputs = {};
      try {
        for (const e of scopedGraph.edges.filter((e) => e.target === id)) {
          const source = byId.get(e.source);
          if (node.type === "video/google-omni"
            && ["last_image", "reference_images"].includes(e.targetHandle)
            && source?.type === "input/image" && !String(source.params.url ?? "").trim()) {
            continue;
          }
          const up = await visit(e.source);
          if (["video/seedance", "video/google-omni", "video/kling", "image/flux-3"].includes(node.type)
            && e.targetHandle === "reference_images") {
            const references = Array.isArray(inputs.reference_images) ? inputs.reference_images : [];
            inputs.reference_images = references;
            references.push(up[e.sourceHandle]);
          } else if (node.type === "video/kling" && e.targetHandle === "middle_images") {
            const middleFrames = Array.isArray(inputs.middle_images) ? inputs.middle_images : [];
            inputs.middle_images = middleFrames;
            middleFrames.push(up[e.sourceHandle]);
          } else if (node.type === "video/minimax-h3" && e.targetHandle === "references") {
            const references = Array.isArray(inputs.references) ? inputs.references : [];
            inputs.references = references;
            references.push(up[e.sourceHandle]);
          } else {
            inputs[e.targetHandle] = up[e.sourceHandle];
            if (node.type === "video/kling" && node.params.task === "motion-control" && e.targetHandle === "video") {
              inputs.motion_duration_seconds = up.duration_seconds;
            }
            if (node.type === VFX_VIDEO_REFINE_NODE_TYPE && e.targetHandle === "video") {
              inputs.source_duration_seconds = up.duration_seconds;
            }
          }
        }
      } catch (err) {
        o.onStatus(id, "idle", "Skipped: an upstream node failed");
        throw err;
      }

      const cameraTrackJson = params.camera_track_json;
      if (def.category === "Video" && typeof cameraTrackJson === "string" && cameraTrackJson.trim()) {
        try {
          const guide = formatCameraTrackGuide(cameraTrackJson);
          const prompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
          inputs.prompt = prompt ? `${prompt}\n\n${guide}` : guide;
        } catch (error) {
          o.onStatus(id, "error", error instanceof Error ? error.message : "Camera track is invalid.");
          throw error;
        }
      }

      const key = JSON.stringify([node.type, params, inputs]);
      const hit = o.cache.get(id);
      if (!o.fresh && hit?.key === key) {
        o.onOutput(id, hit.outputs);
        o.onStatus(id, "done", "cached");
        return hit.outputs;
      }

      if (o.signal?.aborted) throw new Error("Cancelled");
      o.onStatus(id, "running", "");
      try {
        const outputs = await def.execute({
          inputs,
          params,
          signal: o.signal,
          log: (m) => o.onStatus(id, "running", m),
          updateParams: (patch) => o.onParams?.(id, patch),
        });
        o.cache.set(id, { key, outputs });
        o.onOutput(id, outputs);
        o.onStatus(id, "done", "");
        return outputs;
      } catch (err: unknown) {
        o.onStatus(id, "error", err instanceof Error ? err.message : String(err));
        throw err;
      }
    })();
    p.catch(() => {}); // failures are reported via onStatus
    memo.set(id, p);
    return p;
  };

  await Promise.allSettled(targets.map((id) => visit(id)));
}
