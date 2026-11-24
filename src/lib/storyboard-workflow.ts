import {
  stripStoryboardContinuityBlocks,
  type StoryboardData,
  type StoryboardScene,
  type StoryboardShot,
  type StoryboardStyleBible,
} from "./StoryboardData";
import type { NodeDef } from "./types";

type StoryboardPromptScene = Pick<StoryboardScene, "title">;
type StoryboardPromptShot = Pick<
  StoryboardShot,
  "title" | "description" | "shotType" | "cameraMove" | "durationSeconds"
> & Partial<Pick<StoryboardShot, "prompt">>;

function formatStoryboardPromptShot(
  scene: StoryboardPromptScene,
  shot: StoryboardPromptShot,
  label: string,
) {
  const lines = [
    `Scene: ${scene.title.trim() || "Untitled scene"}`,
    `Shot: ${shot.title.trim() || "Untitled shot"}`,
  ];
  const prompt = shot.prompt?.trim();
  if (prompt) lines.push(`Prompt: ${prompt}`);
  else if (shot.description.trim()) lines.push(`Description: ${stripStoryboardContinuityBlocks(shot.description)}`);
  if (shot.shotType) lines.push(`Shot type: ${shot.shotType}`);
  if (shot.cameraMove) lines.push(`Camera movement: ${shot.cameraMove}`);
  if (shot.durationSeconds !== null) lines.push(`${label} storyboard duration: ${shot.durationSeconds} seconds`);
  return lines.join("\n");
}

export function buildStoryboardVideoPrompt(
  firstScene: StoryboardPromptScene,
  firstShot: StoryboardPromptShot,
  lastFrame?: { scene: StoryboardPromptScene; shot: StoryboardPromptShot },
  styleBible?: StoryboardStyleBible,
): string {
  const bible = [
    styleBible?.visualStyle ? `Visual style: ${styleBible.visualStyle}` : "",
    styleBible?.recurringCharacter ? `Recurring character: ${styleBible.recurringCharacter}` : "",
    styleBible?.recurringLocation ? `Recurring location: ${styleBible.recurringLocation}` : "",
  ].filter(Boolean);
  const prompt = lastFrame
    ? [
      "Create one continuous video from the provided first frame to the provided last frame. Preserve visual continuity and move naturally from the opening composition to the ending composition.",
      `First frame:\n${formatStoryboardPromptShot(firstScene, firstShot, "First shot")}`,
      `Last frame:\n${formatStoryboardPromptShot(lastFrame.scene, lastFrame.shot, "Last shot")}`,
    ]
    : [
      "Animate the provided storyboard frame into a video shot.",
      formatStoryboardPromptShot(firstScene, firstShot, "Shot"),
    ];
  if (bible.length) prompt.splice(1, 0,
    `Global style bible (preserve continuity using only details relevant to these frames): ${bible.join(" ")}`);
  return prompt.join("\n\n");
}

export type StoryboardFrameReference = {
  kind: "storyboard-frame";
  workflowId: string;
  sceneId: string;
  shotId: string;
};

export type StoryboardVideoCandidate = {
  sourceId: string;
  workflowId: string;
  nodeId: string;
  outputPort: string;
  videoType: string;
  videoUrl: string;
  model: string;
  prompt: string;
  sourceShotRefs: StoryboardFrameReference[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function collectStoryboardVideoCandidates(
  workflowId: string,
  nodes: readonly {
    id: string;
    data: {
      type?: unknown;
      title?: unknown;
      params?: unknown;
      outputs?: unknown;
    };
  }[],
  edges: readonly { source: string; target: string; targetHandle?: string | null }[],
  definitions: Record<string, NodeDef>,
): StoryboardVideoCandidate[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const candidates: StoryboardVideoCandidate[] = [];

  for (const node of nodes) {
    const type = node.data.type;
    if (typeof type !== "string") continue;
    const def = definitions[type];
    if (!def || def.category !== "Video") continue;
    const outputs = isRecord(node.data.outputs) ? node.data.outputs : {};
    const outputEntries = Object.entries(def.outputs).flatMap(([port, portType]) => {
      const value = outputs[port];
      return portType === "video" && isHttpUrl(value) ? [[port, value] as const] : [];
    });
    if (!outputEntries.length) continue;

    const ancestorIds = new Set<string>();
    const pending = edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
    while (pending.length) {
      const sourceId = pending.pop();
      if (!sourceId || ancestorIds.has(sourceId)) continue;
      ancestorIds.add(sourceId);
      for (const edge of edges) {
        if (edge.target === sourceId) pending.push(edge.source);
      }
    }

    const ancestorNodes = nodes.filter((candidate) => ancestorIds.has(candidate.id));
    const sourceShotRefs = ancestorNodes.flatMap((candidate) => {
      if (candidate.data.type !== "input/image" || !isRecord(candidate.data.params)) return [];
      const reference = candidate.data.params.storyboardFrameRef;
      if (!isRecord(reference)
        || reference.kind !== "storyboard-frame"
        || reference.workflowId !== workflowId
        || typeof reference.sceneId !== "string"
        || typeof reference.shotId !== "string") return [];
      return [{
        kind: "storyboard-frame" as const,
        workflowId,
        sceneId: reference.sceneId,
        shotId: reference.shotId,
      }];
    });
    const uniqueShotRefs = [...new Map(sourceShotRefs.map((reference) => [
      `${reference.sceneId}:${reference.shotId}`,
      reference,
    ])).values()];
    if (!uniqueShotRefs.length) continue;

    const params = isRecord(node.data.params) ? node.data.params : {};
    const directPromptSources = edges
      .filter((edge) => edge.target === node.id && edge.targetHandle === "prompt")
      .map((edge) => edge.source);
    const promptSourceIds = [...new Set([...directPromptSources, ...ancestorNodes.map((candidate) => candidate.id)])];
    const connectedPrompt = promptSourceIds.flatMap((id) => {
      const candidate = nodesById.get(id);
      if (candidate?.data.type !== "input/prompt" || !isRecord(candidate.data.params)) return [];
      const text = candidate.data.params.text;
      return typeof text === "string" && text.trim() ? [text] : [];
    })[0];
    const modelParam = def.params.find((param) => param.key === "model");
    const modelValue = typeof params.model === "string" ? params.model : "";
    const model = modelParam?.optionLabels?.[modelValue] || def.label;
    const prompt = connectedPrompt ?? (typeof params.prompt === "string" ? params.prompt : "");

    for (const [outputPort, videoUrl] of outputEntries) {
      candidates.push({
        sourceId: `${workflowId}:${node.id}:${outputPort}`,
        workflowId,
        nodeId: node.id,
        outputPort,
        videoType: type,
        videoUrl,
        model,
        prompt,
        sourceShotRefs: uniqueShotRefs,
      });
    }
  }

  return candidates;
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
