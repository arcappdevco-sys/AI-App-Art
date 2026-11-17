import type { StoryboardData } from "./StoryboardData";

export type StoryboardFrameReference = {
  kind: "storyboard-frame";
  workflowId: string;
  sceneId: string;
  shotId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveStoryboardFrameReference(
  value: unknown,
  workflows: readonly { id: string; storyboard: StoryboardData }[],
): string {
  if (!isRecord(value)) {
    throw new Error("Storyboard frame reference is invalid.");
  }
  if (value.kind !== "storyboard-frame"
    || typeof value.workflowId !== "string"
    || typeof value.sceneId !== "string"
    || typeof value.shotId !== "string") {
    throw new Error("Storyboard frame reference is invalid.");
  }
  const workflow = workflows.find((candidate) => candidate.id === value.workflowId);
  if (!workflow) throw new Error("The workflow containing this storyboard frame is unavailable.");
  const shot = workflow.storyboard.scenes
    .find((scene) => scene.id === value.sceneId)?.shots
    .find((candidate) => candidate.id === value.shotId);
  if (!shot?.frame) throw new Error("The referenced storyboard frame is unavailable. Add it again from the storyboard.");
  return shot.frame;
}

export function resolveWorkflowStoryboardFrames<T extends {
  id: string;
  type: string;
  params: Record<string, unknown>;
}>(
  nodes: readonly T[],
  workflows: readonly { id: string; storyboard: StoryboardData }[],
): T[] {
  return nodes.map((node) => {
    if (node.type !== "input/image" || !Object.hasOwn(node.params, "storyboardFrameRef")) return node;
    const params = { ...node.params };
    const reference = params.storyboardFrameRef;
    delete params.storyboardFrameRef;
    if (String(params.url ?? "").trim()) return { ...node, params };
    params.url = resolveStoryboardFrameReference(reference, workflows);
    return { ...node, params };
  });
}

export function rebindStoryboardWorkflowReferences<T extends {
  id: string;
  type: string;
  params: Record<string, unknown>;
}>(
  nodes: readonly T[],
  sourceWorkflowId: string,
  targetWorkflowId: string,
): T[] {
  return nodes.map((node) => {
    if (node.type !== "input/image" || !isRecord(node.params.storyboardFrameRef)) return node;
    const reference = node.params.storyboardFrameRef;
    if (reference.kind !== "storyboard-frame" || reference.workflowId !== sourceWorkflowId) return node;
    return {
      ...node,
      params: {
        ...node.params,
        storyboardFrameRef: { ...reference, workflowId: targetWorkflowId },
      },
    };
  });
}
