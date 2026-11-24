"use client";

import "@xyflow/react/dist/style.css";
import "./flow.css";
import "./canvas-groups.css";
import "./example-drag.css";
import "./ollama-chat.css";
import "../components/StoryboardTab.css";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useRouter } from "next/navigation";
import ApiKeySetupRedirect from "@/components/ApiKeySetupRedirect";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, type Connection, type Edge, type Node, type ReactFlowInstance,
} from "@xyflow/react";
import { registry } from "@/lib/registry";
import { runGraph } from "@/lib/executor";
import {
  estimateNodeCost,
  getLowSettingsProfile,
  lowSettingsDescription,
  lowSettingsNodeLabel,
} from "@/lib/runModeLowSettings";
import { normalizeVeoParams } from "@/lib/veo";
import { normalizeOmniParams, OMNI_MODELS, OMNI_TASKS } from "@/lib/omni";
import { normalizeKlingParams, KLING_MODELS, KLING_TASKS } from "@/lib/kling";
import { normalizeWanParams, WAN_NODE_TYPE } from "@/lib/wan";
import { deleteWanDocument } from "@/lib/wan-storage";
import { MINIMAX_NODE_TYPE, normalizeMiniMaxParams } from "@/lib/minimax";
import { FLUX3_NODE_TYPE, normalizeFlux3Params } from "@/lib/flux3";
import { FLUX3_VIDEO_NODE_TYPE } from "@/lib/flux3-video";
import {
  createFirstLastFrameWorkflowNodes,
  createImageToVideoWorkflowNodes,
  createWorkflowNodes,
  getFirstLastFrameModelOptions,
  getImageToVideoModelOptions,
  getStoryboardVideoParamOverrides,
  videoModelTypes,
} from "@/lib/workflow-node-factory";
import {
  createVfxRelightWorkflow,
  VFX_EXTRACT_FRAME_NODE_TYPE,
  VFX_LIGHTING_REFERENCE_NODE_TYPE,
  VFX_VIDEO_REFINE_NODE_TYPE,
} from "@/lib/vfx-relight";
import { validateWorkflow, type WorkflowValidationIssue } from "@/lib/workflow-validation";
import type { Graph, NodeStatus } from "@/lib/types";
import WorkflowNode, { WorkflowRunContext } from "@/components/WorkflowNode";
import VideoEditor, { type VideoAsset } from "@/components/VideoEditor";
import Compositor from "@/components/Compositor";
import StoryboardTab from "@/components/StoryboardTab";
import WorkspaceHelp from "@/components/WorkspaceHelp";
import ProjectFolderControl from "@/components/ProjectFolderControl";
import {
  addMediaToProjectFolder,
  loadProjectWorkspaceState,
  readOrCreateProjectManifest,
  saveProjectWorkspaceState,
  type ProjectFolderSession,
} from "@/lib/project-folder-storage";
import { isProjectWorkspaceView, type ProjectWorkspaceView } from "@/lib/project-workspace";
import { hasValidWorkflowEdgeReferences, stripInvalidWorkflowConnections } from "@/lib/workflow-storage";
import {
  createEmptyStoryboard,
  normalizeStoryboard,
  type StoryboardCharacter,
  type StoryboardData,
  type StoryboardGeneratedTake,
} from "@/lib/StoryboardData";
import {
  buildStoryboardVideoPrompt,
  collectStoryboardVideoCandidates,
  rebindStoryboardWorkflowReferences,
  resolveWorkflowCharacterReferences,
  resolveWorkflowStoryboardFrames,
  type StoryboardVideoCandidate,
} from "@/lib/storyboard-workflow";
import { loadApprovedCharacterReferenceImage } from "@/lib/project-character-reference";
import {
  createUnknownMediaAssetMetadata,
  workflowOutputMediaId,
  workflowOutputSnapshotMediaId,
  workflowOutputMediaSource,
  type ProjectMediaAsset,
} from "@/lib/project-media";
import {
  isWorkflowVideoSnapshotSuppressed,
  listProjectMediaAssets,
  loadProjectMediaFile,
  registerProjectMediaAsset,
  restoreWorkflowVideoSnapshot,
} from "@/lib/project-media-storage";
import CanvasGroups from "@/components/CanvasGroups";
import { ExampleDragPreview, useExampleDrag } from "@/components/ExampleDrag";
import OllamaChat from "@/components/OllamaChat";
import { createCanvasGroup, groupBoundsForNodes, normalizeCanvasGroups, type CanvasGroup } from "@/lib/canvas-groups";
import { autoLayoutWorkflow } from "@/lib/workflow-layout";
import { zoomCanvasAtPoint } from "@/lib/canvas-zoom";
import {
  type OllamaApplyResult,
  type OllamaPromptApplyResult,
  type OllamaPromptContext,
  type OllamaPromptContextInput,
} from "@/lib/ollama-chat";
import {
  createOllamaStoryboardContext,
  OLLAMA_STORYBOARD_PROMPT_MAX_LENGTH,
  type OllamaStoryboardContext,
} from "@/lib/ollama-storyboard-context";
import { createOllamaWorkflowContext } from "@/lib/ollama-workflow-context";
import {
  findPromptAssistantTargets,
  validatePromptAssistantCandidate,
} from "@/lib/prompt-assistant-profiles";

const nodeTypes = { workflow: WorkflowNode };
const storyboardVideoModelOptions = getImageToVideoModelOptions(registry);
const storyboardFirstLastFrameModelOptions = getFirstLastFrameModelOptions(registry);
const WORKFLOWS_STORAGE_KEY = "fal-flow:workflows";
const LEGACY_WORKFLOW_STORAGE_KEY = "fal-flow:workflow";
const UI_THEME_STORAGE_KEY = "fal-flow:ui-theme";
const UI_BUTTON_COLOR_STORAGE_KEY = "fal-flow:ui-button-color";
const UI_RUN_MODE_STORAGE_KEY = "fal-flow:run-mode";
const DEFAULT_WORKFLOW_NAME = "Untitled workflow";
const UI_THEMES = ["midnight", "ocean", "violet", "light"] as const;
type UiTheme = (typeof UI_THEMES)[number];
const UI_BUTTON_COLORS = ["blue", "violet", "coral", "amber", "slate"] as const;
type UiButtonColor = (typeof UI_BUTTON_COLORS)[number];
const RUN_MODES = ["all", "low"] as const;
type RunMode = (typeof RUN_MODES)[number];
const UI_THEME_LABELS: Record<UiTheme, string> = {
  midnight: "Midnight",
  ocean: "Ocean",
  violet: "Violet",
  light: "Light",
};
const UI_BUTTON_COLOR_LABELS: Record<UiButtonColor, string> = {
  blue: "Blue",
  violet: "Violet",
  coral: "Coral",
  amber: "Amber",
  slate: "Slate",
};
const imageModelGroups = [
  { provider: "Google", access: "FREE TIER", types: ["google/gemini-image"] },
  { provider: "fal", access: "PAID · API CONNECTED", types: ["fal/nano-banana"] },
  { provider: "Atlas Cloud", access: "ATLAS CLOUD API · FLUX 3", types: [FLUX3_NODE_TYPE] },
  {
    provider: "OpenAI",
    access: "PAID · API CONNECTED",
    types: ["openai/gpt-image"],
  },
] as const;
const utilityGroups = [
  { title: "Inputs", types: ["input/prompt", "input/image", "input/video", "input/number"] },
  { title: "Outputs", types: ["output/preview"] },
  { title: "Advanced", types: ["fal/model"] },
  { title: "VFX", types: [VFX_EXTRACT_FRAME_NODE_TYPE, VFX_LIGHTING_REFERENCE_NODE_TYPE, VFX_VIDEO_REFINE_NODE_TYPE] },
] as const;

type SavedWorkflow = {
  id: string;
  name: string;
  nodes: Node[];
  edges: Edge[];
  groups: CanvasGroup[];
  storyboard: StoryboardData;
  updatedAt: number;
};

type WorkflowLibrary = {
  version: 1;
  activeWorkflowId: string;
  workflows: SavedWorkflow[];
  characters: StoryboardCharacter[];
  activeView: ProjectWorkspaceView;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkflow(value: unknown): Pick<SavedWorkflow, "name" | "nodes" | "edges" | "groups" | "storyboard"> {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("Workflow file must contain nodes and edges arrays.");
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`Workflow version ${String(value.version)} is not supported.`);
  }
  const rawWanNodeIds = new Set(value.nodes.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" && isRecord(item.data) && item.data.type === WAN_NODE_TYPE
      ? [item.id]
      : []
  ));
  const rawMiniMaxNodeIds = new Set(value.nodes.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" && isRecord(item.data) && item.data.type === MINIMAX_NODE_TYPE
      ? [item.id]
      : []
  ));
  const rawFlux3NodeIds = new Set(value.nodes.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" && isRecord(item.data) && item.data.type === FLUX3_NODE_TYPE
      ? [item.id]
      : []
  ));
  const nodeIds = new Set<string>();
  const normalizedNodes = value.nodes.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id
      || !isRecord(item.position) || typeof item.position.x !== "number" || !Number.isFinite(item.position.x)
      || typeof item.position.y !== "number" || !Number.isFinite(item.position.y)
      || !isRecord(item.data) || typeof item.data.type !== "string"
      || (item.data.params !== undefined && !isRecord(item.data.params))) {
      throw new Error(`Workflow node ${index + 1} is invalid.`);
    }
    if (nodeIds.has(item.id)) throw new Error(`Workflow contains a duplicate node ID: ${item.id}.`);
    nodeIds.add(item.id);

    const data = item.data;
    const savedType = data.type as string;
    const legacyType = savedType === "openai/gpt-image-2.6-flare"
      || savedType === "openai/gpt-image-2.6-sunburst";
    const type = legacyType ? "openai/gpt-image" : savedType;
    if (!registry[type]) throw new Error(`Workflow contains an unsupported node type: ${type}.`);
    const legacyModel = savedType === "openai/gpt-image-2.6-flare"
      ? "GPT Image 2.6 · Flare"
      : savedType === "openai/gpt-image-2.6-sunburst"
        ? "GPT Image 2.6 · Sunburst"
        : undefined;
    const params = isRecord(data.params) ? data.params : {};
    const autoOwner = data.autoCreatedFor ?? data.wanAutoCreatedFor;
    const autoRole = data.autoCreatedRole ?? data.wanAutoCreatedRole;
    const isWanAutoImage = type === "input/image" && typeof autoOwner === "string" && rawWanNodeIds.has(autoOwner);
    const isMiniMaxAutoImage = type === "input/image" && typeof autoOwner === "string" && rawMiniMaxNodeIds.has(autoOwner);
    const isFlux3AutoImage = type === "input/image" && typeof autoOwner === "string" && rawFlux3NodeIds.has(autoOwner);
    const minNodeHeight = type === "input/prompt" ? 220 : 160;
    const width = typeof item.width === "number" && Number.isFinite(item.width)
      && item.width >= 250 && item.width <= 900 ? item.width : undefined;
    const height = typeof item.height === "number" && Number.isFinite(item.height)
      && item.height >= minNodeHeight && item.height <= 1200 ? item.height : undefined;
    return {
      id: item.id,
      type: "workflow",
      position: item.position as Node["position"],
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      data: {
        ...data,
        type,
        params: type === WAN_NODE_TYPE
          ? normalizeWanParams(params)
          : type === MINIMAX_NODE_TYPE
            ? normalizeMiniMaxParams(params)
          : type === FLUX3_NODE_TYPE
            ? normalizeFlux3Params(params)
          : {
            ...params,
            ...(legacyModel ? { model: legacyModel } : {}),
            ...(type === "video/veo" ? normalizeVeoParams(params) : {}),
            ...(type === "video/google-omni" ? normalizeOmniParams(params) : {}),
            ...(type === "video/kling" ? normalizeKlingParams(params) : {}),
          },
        ...(isWanAutoImage || isMiniMaxAutoImage || isFlux3AutoImage ? {
          autoCreatedFor: autoOwner,
          autoCreatedRole: autoRole,
        } : {}),
        status: "idle",
        log: "",
      },
    } as Node;
  });
  const seenWanAutoRoles = new Set<string>();
  const duplicateWanAutoIds = new Set<string>();
  const seenMiniMaxAutoRoles = new Set<string>();
  const duplicateMiniMaxAutoIds = new Set<string>();
  const seenFlux3AutoRoles = new Set<string>();
  const duplicateFlux3AutoIds = new Set<string>();
  for (const node of normalizedNodes) {
    const data = node.data as { autoCreatedFor?: string; autoCreatedRole?: string; type?: string };
    if (data.type !== "input/image" || !data.autoCreatedFor || !data.autoCreatedRole) continue;
    const key = `${data.autoCreatedFor}\u0000${data.autoCreatedRole}`;
    if (rawWanNodeIds.has(data.autoCreatedFor)) {
      if (seenWanAutoRoles.has(key)) duplicateWanAutoIds.add(node.id);
      else seenWanAutoRoles.add(key);
    }
    if (rawMiniMaxNodeIds.has(data.autoCreatedFor)) {
      if (seenMiniMaxAutoRoles.has(key)) duplicateMiniMaxAutoIds.add(node.id);
      else seenMiniMaxAutoRoles.add(key);
    }
    if (rawFlux3NodeIds.has(data.autoCreatedFor)) {
      if (seenFlux3AutoRoles.has(key)) duplicateFlux3AutoIds.add(node.id);
      else seenFlux3AutoRoles.add(key);
    }
  }
  const duplicateAutoIds = new Set([...duplicateWanAutoIds, ...duplicateMiniMaxAutoIds, ...duplicateFlux3AutoIds]);
  const nodes = normalizedNodes.filter((node) => !duplicateAutoIds.has(node.id));
  const edgeIds = new Set<string>();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = value.edges.filter((item) =>
    !isRecord(item) || !duplicateAutoIds.has(String(item.source))
  ).map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id
      || typeof item.source !== "string" || !nodeIds.has(item.source)
      || typeof item.target !== "string" || !nodeIds.has(item.target)
      || typeof item.sourceHandle !== "string" || typeof item.targetHandle !== "string") {
      throw new Error(`Workflow connection ${index + 1} is invalid or references a missing node.`);
    }
    if (edgeIds.has(item.id)) throw new Error(`Workflow contains a duplicate connection ID: ${item.id}.`);
    edgeIds.add(item.id);
    const sourceType = (nodesById.get(item.source)!.data as { type: string }).type;
    const targetType = (nodesById.get(item.target)!.data as { type: string }).type;
    const sourcePort = registry[sourceType].outputs[item.sourceHandle];
    const targetPort = registry[targetType].inputs[item.targetHandle];
    if (!sourcePort || !targetPort
      || (sourcePort !== targetPort && sourcePort !== "any" && targetPort !== "any")) {
      throw new Error(`Workflow connection ${index + 1} uses incompatible or unknown ports.`);
    }
    return item as unknown as Edge;
  });
  return {
    name: typeof value.name === "string" && value.name.trim()
      ? value.name.trim().slice(0, 80)
      : DEFAULT_WORKFLOW_NAME,
    nodes,
    edges,
    groups: normalizeCanvasGroups(value.groups),
    storyboard: normalizeStoryboard(value.storyboard),
  };
}

function normalizeWorkflowLibrary(value: unknown): {
  library: WorkflowLibrary;
  removedConnections: number;
} {
  if (!isRecord(value) || (value.version !== undefined && value.version !== 1)
    || !Array.isArray(value.workflows) || value.workflows.length === 0) {
    throw new Error("Saved workflow library is invalid.");
  }
  let removedConnections = 0;
  const workflows = value.workflows.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
      throw new Error(`Saved workflow ${index + 1} is invalid.`);
    }
    const sanitized = stripInvalidWorkflowConnections(item);
    removedConnections += sanitized.removed;
    return {
      id: item.id,
      ...normalizeWorkflow(sanitized.workflow),
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
    };
  });
  if (new Set(workflows.map((workflow) => workflow.id)).size !== workflows.length) {
    throw new Error("Saved workflow library contains duplicate workflow IDs.");
  }
  if (value.characters !== undefined && !Array.isArray(value.characters)) {
    throw new Error("Saved character library is invalid.");
  }
  const seenCharacterIds = new Set<string>();
  const characterValues = [
    ...(Array.isArray(value.characters) ? value.characters : []),
    ...workflows.flatMap((workflow) => workflow.storyboard.characters ?? []),
  ].filter((character) => {
    if (!isRecord(character) || typeof character.id !== "string" || !character.id.trim()) return true;
    if (seenCharacterIds.has(character.id)) return false;
    seenCharacterIds.add(character.id);
    return true;
  });
  const characters = normalizeStoryboard({
    version: 1,
    characters: characterValues,
    scenes: [],
  }).characters ?? [];
  const workflowsWithoutEmbeddedCharacters = workflows.map((workflow) => ({
    ...workflow,
    storyboard: { ...workflow.storyboard, characters: [] },
  }));
  const activeWorkflowId = workflows.some((workflow) => workflow.id === value.activeWorkflowId)
    ? value.activeWorkflowId as string
    : workflows[0].id;
  return {
    library: {
      version: 1,
      activeWorkflowId,
      workflows: workflowsWithoutEmbeddedCharacters,
      characters,
      activeView: isProjectWorkspaceView(value.activeView) ? value.activeView : "workflow",
    },
    removedConnections,
  };
}

function createDefaultWorkflowLibrary(): WorkflowLibrary {
  const id = crypto.randomUUID();
  return {
    version: 1,
    activeWorkflowId: id,
    activeView: "workflow",
    characters: [],
    workflows: [{
      id,
      name: DEFAULT_WORKFLOW_NAME,
      nodes: [],
      edges: [],
      groups: [],
      storyboard: createEmptyStoryboard(),
      updatedAt: Date.now(),
    }],
  };
}

function readBrowserWorkflowLibrary(): {
  library: WorkflowLibrary;
  restored: boolean;
  legacyKey: boolean;
  removedConnections: number;
} {
  const saved = window.localStorage.getItem(WORKFLOWS_STORAGE_KEY);
  if (saved) {
    const normalized = normalizeWorkflowLibrary(JSON.parse(saved));
    return {
      ...normalized,
      restored: true,
      legacyKey: false,
    };
  }
  const legacy = window.localStorage.getItem(LEGACY_WORKFLOW_STORAGE_KEY);
  if (!legacy) {
    return { library: createDefaultWorkflowLibrary(), restored: false, legacyKey: false, removedConnections: 0 };
  }
  const sanitized = stripInvalidWorkflowConnections(JSON.parse(legacy));
  const normalized = normalizeWorkflow(sanitized.workflow);
  const id = crypto.randomUUID();
  const characters = normalized.storyboard.characters ?? [];
  return {
    library: {
      version: 1,
      activeWorkflowId: id,
      activeView: "workflow",
      characters,
      workflows: [{
        id,
        ...normalized,
        storyboard: { ...normalized.storyboard, characters: [] },
        updatedAt: Date.now(),
      }],
    },
    restored: true,
    legacyKey: true,
    removedConnections: sanitized.removed,
  };
}

function workflowGenerationNodes(nodes: Node[]) {
  return nodes.flatMap((node) => {
    const data = node.data as { type?: string; params?: unknown };
    const type = data.type ?? "";
    const definition = registry[type];
    if (!definition || ["Input", "Output", "Assistant"].includes(definition.category)) return [];
    return [{
      id: node.id,
      type,
      label: lowSettingsNodeLabel(type, definition.label, isRecord(data.params) ? data.params : {}),
      params: isRecord(data.params) ? data.params : {},
    }];
  });
}

function formatRunCost(total: number, withoutEstimate: number) {
  const missing = withoutEstimate
    ? `; ${withoutEstimate} ${withoutEstimate === 1 ? "node has" : "nodes have"} no estimate`
    : "";
  return `~$${total.toFixed(3)}${missing}`;
}

export default function Page() {
  const router = useRouter();
  const [activeView, setActiveView] = useState<ProjectWorkspaceView>("workflow");
  const [uiTheme, setUiTheme] = useState<UiTheme>("midnight");
  const [uiButtonColor, setUiButtonColor] = useState<UiButtonColor>("blue");
  const [runMode, setRunMode] = useState<RunMode>("all");
  const [runModeMenuOpen, setRunModeMenuOpen] = useState(false);
  const [runModeMenuPosition, setRunModeMenuPosition] = useState({ top: 0, right: 12 });
  const [themeError, setThemeError] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [groups, setGroups] = useState<CanvasGroup[]>([]);
  const [storyboard, setStoryboard] = useState<StoryboardData>(() => createEmptyStoryboard());
  const [projectCharacters, setProjectCharacters] = useState<StoryboardCharacter[]>([]);
  const [storyboardClearKey, setStoryboardClearKey] = useState(0);

  const clearStoryboard = () => {
    setStoryboard(createEmptyStoryboard());
    setProjectCharacters([]);
    setStoryboardClearKey((k) => k + 1);
  };
  const [projectMediaAssets, setProjectMediaAssets] = useState<ProjectMediaAsset[]>([]);
  const [projectSession, setProjectSession] = useState<ProjectFolderSession | null>(null);
  const [projectSessionReady, setProjectSessionReady] = useState(false);
  const [projectSessionEpoch, setProjectSessionEpoch] = useState(0);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSaveError, setProjectSaveError] = useState("");
  const [projectSaveStatus, setProjectSaveStatus] = useState("");
  const [registeredSaveHandlers, setRegisteredSaveHandlers] = useState({ editor: false, compositor: false });
  const groupCanvasRef = useRef<HTMLElement>(null);
  const groupFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const zoomWorkflowOnNodeWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (event.deltaY === 0 || !(event.target instanceof Element)) return;
    if (!event.target.closest(".react-flow__node") || event.target.closest(".nowheel, input, textarea, select, [contenteditable='true']")) return;
    const flow = groupFlowRef.current;
    if (!flow) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    void flow.setViewport(zoomCanvasAtPoint(
      flow.getViewport(),
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      event.deltaY,
      0.001,
      2,
    ), { duration: 0 });
  };
  const [workflowName, setWorkflowName] = useState(DEFAULT_WORKFLOW_NAME);
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState("");
  const [ollamaPromptContext, setOllamaPromptContext] = useState<OllamaPromptContext | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Loading saved workflow…");
  const [storageError, setStorageError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [lowSettingsNodeIds, setLowSettingsNodeIds] = useState<string[]>([]);
  const [lowRunSummary, setLowRunSummary] = useState("");
  const [validationIssues, setValidationIssues] = useState<WorkflowValidationIssue[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const cache = useRef(new Map());
  const abort = useRef<AbortController | null>(null);
  const runModeMenuRef = useRef<HTMLDivElement>(null);
  const runModeArrowRef = useRef<HTMLButtonElement>(null);
  const runModeOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lowRunSummaryTimer = useRef<number | null>(null);
  const runInProgress = useRef(false);
  const lastSavedPayload = useRef("");
  const workflowsRef = useRef<SavedWorkflow[]>([]);
  const projectCharactersRef = useRef<StoryboardCharacter[]>([]);
  const activeWorkflowIdRef = useRef("");
  const ollamaPromptContextRef = useRef<OllamaPromptContext | null>(null);
  const projectSessionRef = useRef<ProjectFolderSession | null>(null);
  const registeredMediaUrls = useRef(new Map<string, string>());
  const generatedVideoSaves = useRef(new Map<string, Promise<{
    asset: ProjectMediaAsset;
    file: File;
    projectName: string;
  }>>());
  const workflowSessionKey = projectSession?.sessionKey ?? "local";
  const ollamaStoryboardContext = useMemo(() => activeView === "storyboard" && activeWorkflowId
    ? createOllamaStoryboardContext(
      storyboard,
      activeWorkflowId,
      `${workflowSessionKey}:${activeWorkflowId}`,
    )
    : null, [activeView, activeWorkflowId, storyboard, workflowSessionKey]);
  const ollamaWorkflowContext = useMemo(() => activeView === "workflow" && activeWorkflowId
    ? createOllamaWorkflowContext(
      nodes,
      edges,
      activeWorkflowId,
      `${workflowSessionKey}:${activeWorkflowId}`,
    )
    : null, [activeView, activeWorkflowId, edges, nodes, workflowSessionKey]);
  const loadedWorkflowSessionKey = useRef<string | null>(null);
  const workflowSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const editorSaveHandler = useRef<(() => Promise<void>) | null>(null);
  const compositorSaveHandler = useRef<(() => Promise<void>) | null>(null);

  const refreshProjectMediaAssets = useCallback(async () => {
    setProjectMediaAssets(await listProjectMediaAssets());
  }, []);
  useEffect(() => {
    projectCharactersRef.current = projectCharacters;
  }, [projectCharacters]);
  const saveCharacterReferenceAsset = useCallback(async (
    file: File,
    metadata: ProjectMediaAsset["metadata"],
  ) => {
    if (!file.type.startsWith("image/") || file.size <= 0 || file.size > 20 * 1024 * 1024) {
      throw new Error("Character reference images must be non-empty image files of 20 MB or less.");
    }
    const sessionAtStart = projectSessionRef.current;
    const id = `character-reference:${crypto.randomUUID()}`;
    const asset: ProjectMediaAsset = {
      id,
      name: file.name,
      mediaKind: "image",
      mimeType: file.type,
      source: { kind: "storage", storageKey: id },
      metadata,
    };
    if (sessionAtStart) {
      const { manifest } = await readOrCreateProjectManifest(sessionAtStart.handle);
      if (manifest.id !== sessionAtStart.projectId) {
        throw new Error("The project folder changed before this character reference could be saved.");
      }
      if (projectSessionRef.current?.sessionKey !== sessionAtStart.sessionKey) {
        throw new Error("The active project changed before this character reference could be saved. Try again.");
      }
      if (!manifest.assets.some((entry) => entry.id === id)) {
        await addMediaToProjectFolder(sessionAtStart.handle, manifest, asset, file);
        setProjectSessionEpoch((current) => current + 1);
      }
    }
    const registered = await registerProjectMediaAsset(asset, file);
    if ((projectSessionRef.current?.sessionKey ?? null) !== (sessionAtStart?.sessionKey ?? null)) {
      throw new Error("The active project changed while this character reference was being saved. Try again.");
    }
    await refreshProjectMediaAssets();
    return registered.id;
  }, [refreshProjectMediaAssets]);
  const registerEditorSaveHandler = useCallback((handler: (() => Promise<void>) | null) => {
    editorSaveHandler.current = handler;
    setRegisteredSaveHandlers((current) => current.editor === (handler !== null)
      ? current
      : { ...current, editor: handler !== null });
  }, []);
  const registerCompositorSaveHandler = useCallback((handler: (() => Promise<void>) | null) => {
    compositorSaveHandler.current = handler;
    setRegisteredSaveHandlers((current) => current.compositor === (handler !== null)
      ? current
      : { ...current, compositor: handler !== null });
  }, []);
  const ensureWorkflowVideoSaved = useCallback((
    workflowId: string,
    nodeId: string,
    port: string,
    url: string,
    name: string,
    sessionAtStart = projectSessionRef.current,
  ) => {
    const taskKey = `${workflowId}:${nodeId}:${port}:${url}:${sessionAtStart?.sessionKey ?? "local"}`;
    const existingTask = generatedVideoSaves.current.get(taskKey);
    if (existingTask) return existingTask;

    const saving = (async () => {
      const assetId = await workflowOutputSnapshotMediaId(workflowId, nodeId, port, url);
      const existingAsset = (await listProjectMediaAssets()).find((asset) => asset.id === assetId);
      if (existingAsset?.source.kind === "url" && existingAsset.source.url !== url) {
        throw new Error("The generated video URL does not match its saved media record.");
      }
      const extension = /\.webm(?:$|[?#])/i.test(url) ? "webm"
        : /\.mov(?:$|[?#])/i.test(url) ? "mov" : "mp4";
      const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 100) || "Generated video";
      const asset = existingAsset ?? await registerProjectMediaAsset({
        id: assetId,
        name: `${safeName} - ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`,
        mediaKind: "video",
        mimeType: null,
        source: { kind: "url", url },
        metadata: createUnknownMediaAssetMetadata(),
      });
      const file = await loadProjectMediaFile(assetId, asset.revision);
      if (!file.type.startsWith("video/")) {
        throw new Error("The generated output is not a video file.");
      }

      let projectName = "";
      if (sessionAtStart) {
        const { manifest } = await readOrCreateProjectManifest(sessionAtStart.handle);
        if (manifest.id !== sessionAtStart.projectId) {
          throw new Error("The project folder changed before this video could be saved.");
        }
        if (projectSessionRef.current?.sessionKey !== sessionAtStart.sessionKey) {
          throw new Error("The active project changed while this video was being saved. Try again.");
        }
        if (!manifest.assets.some((entry) => entry.id === assetId)) {
          await addMediaToProjectFolder(sessionAtStart.handle, manifest, asset, file);
          setProjectSessionEpoch((current) => current + 1);
        }
        projectName = manifest.name;
      }
      return { asset, file, projectName };
    })();
    generatedVideoSaves.current.set(taskKey, saving);
    void saving.catch(() => {
      if (generatedVideoSaves.current.get(taskKey) === saving) generatedVideoSaves.current.delete(taskKey);
    });
    return saving;
  }, []);
  const ensureWorkflowVideoSavedUnlessDeleted = useCallback(async (
    workflowId: string,
    nodeId: string,
    port: string,
    url: string,
    name: string,
    sessionAtStart = projectSessionRef.current,
  ) => {
    const assetId = await workflowOutputSnapshotMediaId(workflowId, nodeId, port, url);
    if (await isWorkflowVideoSnapshotSuppressed(assetId)) return null;
    return ensureWorkflowVideoSaved(workflowId, nodeId, port, url, name, sessionAtStart);
  }, [ensureWorkflowVideoSaved]);
  const updateProjectSession = useCallback((session: ProjectFolderSession | null) => {
    projectSessionRef.current = session;
    setProjectSession(session);
    setProjectSessionReady(true);
    setProjectSessionEpoch((current) => current + 1);
  }, []);

  useEffect(() => {
    let active = true;
    listProjectMediaAssets().then((assets) => {
      if (active) setProjectMediaAssets(assets);
    }).catch((error: unknown) => {
      if (!active) return;
      setStorageError(error instanceof Error ? error.message : "Could not load shared media.");
      setStorageStatus("Unable to load shared media");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const savedTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
        if (savedTheme && UI_THEMES.includes(savedTheme as UiTheme)) setUiTheme(savedTheme as UiTheme);
        const savedRunMode = window.localStorage.getItem(UI_RUN_MODE_STORAGE_KEY);
        if (savedRunMode && RUN_MODES.includes(savedRunMode as RunMode)) setRunMode(savedRunMode as RunMode);
        const savedButtonColor = window.localStorage.getItem(UI_BUTTON_COLOR_STORAGE_KEY);
        if (savedButtonColor && UI_BUTTON_COLORS.includes(savedButtonColor as UiButtonColor)) {
          setUiButtonColor(savedButtonColor as UiButtonColor);
        }
      } catch (error) {
        console.error("Could not load saved appearance preferences.", error);
        setThemeError("Could not load saved appearance preferences.");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const changeUiTheme = (theme: UiTheme) => {
    setUiTheme(theme);
    setThemeError("");
    try {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.error("Could not save the selected UI theme.", error);
      setThemeError("Theme change could not be saved.");
    }
  };
  const changeUiButtonColor = (color: UiButtonColor) => {
    setUiButtonColor(color);
    setThemeError("");
    try {
      window.localStorage.setItem(UI_BUTTON_COLOR_STORAGE_KEY, color);
    } catch (error) {
      console.error("Could not save the selected button color.", error);
      setThemeError("Button color change could not be saved.");
    }
  };
  const changeRunMode = (mode: RunMode) => {
    setRunMode(mode);
    setRunModeMenuOpen(false);
    setThemeError("");
    try {
      window.localStorage.setItem(UI_RUN_MODE_STORAGE_KEY, mode);
    } catch (error) {
      console.error("Could not save the selected run mode.", error);
      setThemeError("Run mode preference could not be saved.");
    }
  };
  useEffect(() => {
    if (!runModeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof window.Node && !runModeMenuRef.current?.contains(event.target)) {
        setRunModeMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [runModeMenuOpen]);
  const videoAssets = useMemo<VideoAsset[]>(() => {
    const savedOutputBases = new Set(projectMediaAssets.flatMap((asset) => {
      const marker = asset.id.lastIndexOf(":saved:");
      const hash = marker >= 0 ? asset.id.slice(marker + 7) : "";
      return asset.mediaKind === "video" && /^[a-f0-9]{64}$/.test(hash)
        ? [asset.id.slice(0, marker)]
        : [];
    }));
    return projectMediaAssets
      .filter((asset) => asset.mediaKind === "video"
        && (asset.id.startsWith("storyboard-take:")
          || (asset.id.startsWith("workflow-output:")
            && (asset.id.includes(":saved:") || !savedOutputBases.has(asset.id)))))
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        src: asset.source.kind === "url" ? asset.source.url : "",
        mediaId: asset.id,
        projectAssetId: asset.id,
        projectAssetRevision: asset.revision ?? 0,
        metadata: asset.metadata,
      }));
  }, [projectMediaAssets]);
  const storyboardVideoCandidates = useMemo(() => activeWorkflowId
    ? collectStoryboardVideoCandidates(activeWorkflowId, nodes, edges, registry)
    : [], [activeWorkflowId, edges, nodes]);

  useEffect(() => {
    if (!storageReady || !activeWorkflowId) return;
    const pending: Array<{
      kind: "video" | "image";
      promise: Promise<ProjectMediaAsset | undefined>;
    }> = [];
    for (const node of nodes) {
      const data = node.data as {
        type?: string;
        title?: string;
        params?: { title?: string };
        outputs?: Record<string, unknown>;
      };
      const definition = data.type ? registry[data.type] : undefined;
      if (!data.type || !definition || ["Input", "Output", "Assistant"].includes(definition.category)) continue;
      for (const [port, value] of Object.entries(data.outputs ?? {})) {
        const mediaKind = definition.outputs[port];
        if ((mediaKind !== "video" && mediaKind !== "image")
          || typeof value !== "string") continue;
        const source = workflowOutputMediaSource(mediaKind, value);
        if (!source) continue;
        const id = workflowOutputMediaId(activeWorkflowId, node.id, port);
        const sourceId = `${activeWorkflowId}:${node.id}:${port}`;
        const alreadySavedAsTake = mediaKind === "video"
          && workflowsRef.current.some((workflow) => workflow.id === activeWorkflowId
            && workflow.storyboard.scenes.some((scene) => scene.shots.some((shot) =>
              shot.generatedTakes?.some((take) =>
                take.sourceId === sourceId && take.videoUrl === value && Boolean(take.mediaAssetId)),
            )));
        if (registeredMediaUrls.current.get(id) === value) {
          const saveTaskKey =
            `${activeWorkflowId}:${node.id}:${port}:${value}:${projectSessionRef.current?.sessionKey ?? "local"}`;
          if (mediaKind === "video" && !alreadySavedAsTake
            && !generatedVideoSaves.current.has(saveTaskKey)) {
            pending.push({
              kind: "video",
              promise: ensureWorkflowVideoSavedUnlessDeleted(
                activeWorkflowId,
                node.id,
                port,
                value,
                data.params?.title || data.title || definition.label || "Generated video",
              ).then((saved) => saved?.asset),
            });
          }
          continue;
        }
        registeredMediaUrls.current.set(id, value);
        const name = data.params?.title || data.title || definition.label || "Generated media";
        if (mediaKind === "video") {
          if (alreadySavedAsTake) continue;
          const saving = ensureWorkflowVideoSavedUnlessDeleted(activeWorkflowId, node.id, port, value, name)
            .then((saved) => saved?.asset)
            .catch((error: unknown) => {
              if (registeredMediaUrls.current.get(id) === value) registeredMediaUrls.current.delete(id);
              throw error;
            });
          pending.push({ kind: "video", promise: saving });
          continue;
        }
        const asset: ProjectMediaAsset = {
          id,
          name: port === "video" ? name : `${name} · ${port.replaceAll("_", " ")}`,
          mediaKind,
          mimeType: null,
          source: source.kind === "data-url" ? { kind: "storage", storageKey: id } : source,
          metadata: createUnknownMediaAssetMetadata(),
        };
        const registration = (async () => {
          if (source.kind !== "data-url") return registerProjectMediaAsset(asset);
          const response = await fetch(source.dataUrl);
          if (!response.ok) throw new Error(`Could not read inline workflow image "${name}".`);
          const downloaded = await response.blob();
          const declaredMime = /^data:([^;,]+)/i.exec(source.dataUrl)?.[1] ?? "";
          const mimeType = downloaded.type || declaredMime;
          if (!mimeType.startsWith("image/") || (downloaded.type && !downloaded.type.startsWith("image/"))) {
            throw new Error(`Inline workflow output "${name}" is not a supported image.`);
          }
          asset.mimeType = mimeType;
          return registerProjectMediaAsset(asset, new Blob([downloaded], { type: mimeType }));
        })();
        pending.push({
          kind: "image",
          promise: registration.catch((error: unknown) => {
            if (registeredMediaUrls.current.get(id) === value) registeredMediaUrls.current.delete(id);
            throw error;
          }),
        });
      }
    }
    if (!pending.length) return;
    void Promise.allSettled(pending.map((item) => item.promise)).then(async (results) => {
      const failureIndex = results.findIndex((result) => result.status === "rejected");
      if (failureIndex >= 0) {
        const failure = results[failureIndex];
        setStorageError(failure.status === "rejected" && failure.reason instanceof Error
          ? failure.reason.message : "Could not save generated media.");
        setStorageStatus(pending[failureIndex].kind === "video"
          ? "Unable to save generated video locally"
          : "Unable to register shared media");
      }
      await refreshProjectMediaAssets();
    }).catch((error: unknown) => {
      setStorageError(error instanceof Error ? error.message : "Could not refresh shared media.");
      setStorageStatus("Unable to refresh shared media");
    });
  }, [activeWorkflowId, ensureWorkflowVideoSavedUnlessDeleted, nodes, projectSession?.sessionKey, refreshProjectMediaAssets, storageReady]);

  useEffect(() => {
    if (!projectSessionReady) return;
    loadedWorkflowSessionKey.current = null;
    let active = true;
    const timeout = window.setTimeout(() => {
      setStorageReady(false);
      setStorageStatus(projectSession ? "Loading project workflows…" : "Loading saved workflow…");
      void (async () => {
        try {
          let library: WorkflowLibrary;
          let restoredFromDevice = false;
          let removedConnections = 0;
          if (projectSession) {
            const saved = await loadProjectWorkspaceState(projectSession.handle, projectSession.projectId);
            if (saved) {
              const normalized = normalizeWorkflowLibrary(saved);
              library = normalized.library;
              removedConnections = normalized.removedConnections;
              restoredFromDevice = true;
            } else {
              const browserLibrary = readBrowserWorkflowLibrary();
              library = browserLibrary.library;
              removedConnections = browserLibrary.removedConnections;
              await saveProjectWorkspaceState(projectSession.handle, projectSession.projectId, library);
            }
          } else {
            const local = readBrowserWorkflowLibrary();
            library = local.library;
            restoredFromDevice = local.restored;
            removedConnections = local.removedConnections;
            const serialized = JSON.stringify(library);
            window.localStorage.setItem(WORKFLOWS_STORAGE_KEY, serialized);
            if (local.legacyKey) window.localStorage.removeItem(LEGACY_WORKFLOW_STORAGE_KEY);
            lastSavedPayload.current = serialized;
          }
          if (!active) return;
          const current = library.workflows.find((workflow) => workflow.id === library.activeWorkflowId);
          if (!current) throw new Error("The active workflow could not be restored.");
          workflowsRef.current = library.workflows;
          projectCharactersRef.current = library.characters;
          activeWorkflowIdRef.current = library.activeWorkflowId;
          setWorkflows(library.workflows);
          setProjectCharacters(library.characters);
          setActiveWorkflowId(library.activeWorkflowId);
          setWorkflowName(current.name);
          setNodes(current.nodes);
          setEdges(current.edges);
          setGroups(current.groups);
          setStoryboard(current.storyboard);
          setActiveView(library.activeView);
          loadedWorkflowSessionKey.current = workflowSessionKey;
          setStorageError("");
          const restoreStatus = projectSession
            ? restoredFromDevice ? "Restored from project folder" : "Copied browser workflows into project"
            : restoredFromDevice ? "Restored from this device" : "Auto-saved on this device";
          setStorageStatus(removedConnections > 0
            ? `${restoreStatus}; removed ${removedConnections} invalid connection${removedConnections === 1 ? "" : "s"}`
            : restoreStatus);
          setStorageReady(true);
        } catch (error) {
          if (!active) return;
          setStorageError(error instanceof Error ? error.message : "Could not restore workflows.");
          setStorageStatus(projectSession ? "Unable to restore project workflows" : "Unable to restore workflow");
        }
      })();
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [projectSession, projectSessionReady, setEdges, setNodes, workflowSessionKey]);

  const queueProjectWorkspaceSave = (
    library: WorkflowLibrary,
    session: ProjectFolderSession,
    manual = false,
    removedConnections = 0,
  ) => {
    const sessionKey = session.sessionKey;
    const cleanupNotice = removedConnections > 0
      ? `; removed ${removedConnections} invalid connection${removedConnections === 1 ? "" : "s"}`
      : "";
    setStorageStatus(`Saving to project folder…${cleanupNotice}`);
    const saving = workflowSaveQueue.current.catch(() => {})
      .then(() => saveProjectWorkspaceState(session.handle, session.projectId, library));
    workflowSaveQueue.current = saving;
    void saving.then(() => {
      if (loadedWorkflowSessionKey.current !== sessionKey) return;
      setStorageError("");
      setStorageStatus(`${manual ? "Saved just now" : "Saved to project folder"}${cleanupNotice}`);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Could not save project workflows.";
      setStorageError(message);
      setStorageStatus("Unable to save project workflows");
    });
  };

  const saveWorkflowLocally = useCallback((manual = false) => {
    if (!activeWorkflowIdRef.current || loadedWorkflowSessionKey.current !== workflowSessionKey) return false;
    const savedNodes = nodes.map((node) => ({
      ...node,
      data: { ...node.data, status: "idle", log: "" },
    }));
    const savedNodeIds = new Set(savedNodes.map((node) => node.id));
    const savedEdges = edges.filter((edge) => hasValidWorkflowEdgeReferences(edge, savedNodeIds));
    const removedConnections = edges.length - savedEdges.length;
    if (removedConnections > 0) {
      console.warn(`Removed ${removedConnections} invalid workflow connection${removedConnections === 1 ? "" : "s"} before saving.`);
      setEdges(savedEdges);
    }
    const activeId = activeWorkflowIdRef.current;
    const current: SavedWorkflow = {
      id: activeId,
      name: workflowName.trim() || DEFAULT_WORKFLOW_NAME,
      nodes: savedNodes,
      edges: savedEdges,
      groups,
      storyboard: { ...storyboard, characters: [] },
      updatedAt: Date.now(),
    };
    const nextWorkflows = workflowsRef.current.some((workflow) => workflow.id === activeId)
      ? workflowsRef.current.map((workflow) => workflow.id === activeId ? current : workflow)
      : [...workflowsRef.current, current];
    const library: WorkflowLibrary = {
      version: 1,
      activeWorkflowId: activeId,
      workflows: nextWorkflows,
      characters: projectCharacters,
      activeView,
    };
    if (projectSession) {
      workflowsRef.current = nextWorkflows;
      setWorkflows(nextWorkflows);
      queueProjectWorkspaceSave(library, projectSession, manual, removedConnections);
      return true;
    }
    const payload = JSON.stringify(library);
    try {
      if (lastSavedPayload.current !== payload) {
        window.localStorage.setItem(WORKFLOWS_STORAGE_KEY, payload);
        lastSavedPayload.current = payload;
      }
      workflowsRef.current = nextWorkflows;
      setWorkflows(nextWorkflows);
      setStorageError("");
      const cleanupNotice = removedConnections > 0
        ? `; removed ${removedConnections} invalid connection${removedConnections === 1 ? "" : "s"}`
        : "";
      setStorageStatus(`${manual ? "Saved just now" : "Auto-saved on this device"}${cleanupNotice}`);
      setStorageReady(true);
      return true;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to save workflow");
      return false;
    }
  }, [activeView, edges, groups, nodes, projectCharacters, projectSession, setEdges, storyboard, workflowName, workflowSessionKey]);

  const saveProjectNow = useCallback(async () => {
    if (!projectSession) throw new Error("Open a project folder before saving the project.");
    if (!projectSessionReady) throw new Error("The project workspace is still loading.");
    setProjectSaving(true);
    setProjectSaveError("");
    setProjectSaveStatus("Saving project…");
    const failures: string[] = [];
    const saveTasks: Array<[string, () => Promise<void>]> = [
      ["Workflow and storyboard", async () => {
        if (!saveWorkflowLocally(true)) {
          throw new Error("The workflow is still loading and cannot be saved.");
        }
        await workflowSaveQueue.current;
      }],
      ["Video editor", async () => {
        if (!editorSaveHandler.current) throw new Error("The video editor save handler is not ready.");
        await editorSaveHandler.current();
      }],
      ["Compositor", async () => {
        if (!compositorSaveHandler.current) throw new Error("The compositor save handler is not ready.");
        await compositorSaveHandler.current();
      }],
    ];

    try {
      for (const [label, save] of saveTasks) {
        try {
          await save();
        } catch (caught) {
          failures.push(`${label}: ${caught instanceof Error ? caught.message : "save failed"}`);
        }
      }
      if (failures.length) throw new Error(failures.join(" "));
      setProjectSaveStatus("Project saved");
      window.setTimeout(() => {
        setProjectSaveStatus((current) => current === "Project saved" ? "" : current);
      }, 3000);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not save the project.";
      setProjectSaveError(message);
      setProjectSaveStatus("Project save failed");
      throw new Error(message);
    } finally {
      setProjectSaving(false);
    }
  }, [projectSession, projectSessionReady, saveWorkflowLocally]);

  const prepareProjectPackageExport = useCallback(async () => {
    await saveProjectNow();
  }, [saveProjectNow]);

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
    setGroups([]);
    setShowValidation(false);
    setValidationIssues([]);
    cache.current.clear();
  };

  const autoLayout = () => {
    if (!nodes.length) return;
    const layout = autoLayoutWorkflow(nodes, edges, groups, (node) => {
      const type = (node.data as { type?: string }).type;
      if (!type || type.startsWith("input/") || type.startsWith("output/")) return undefined;
      return registry[type]?.label ?? type;
    });
    setNodes(layout.nodes);
    setGroups(layout.groups);
    setStorageStatus("Canvas organized");
    setStorageError("");
    window.requestAnimationFrame(() => {
      groupFlowRef.current?.fitView({ duration: 300, padding: 0.2 });
    });
  };

  useEffect(() => {
    if (!storageReady || loadedWorkflowSessionKey.current !== workflowSessionKey) return;
    const timeout = window.setTimeout(saveWorkflowLocally, 300);
    const saveOnPageHide = () => saveWorkflowLocally();
    window.addEventListener("pagehide", saveOnPageHide);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", saveOnPageHide);
    };
  }, [saveWorkflowLocally, storageReady, workflowSessionKey]);

  const addNode = (type: string, groupExample = false, dropPosition?: { x: number; y: number }) => {
    const def = registry[type];
    if (!def) return;
    const position = dropPosition ?? { x: 100 + nodes.length * 30, y: 100 + nodes.length * 30 };
    const additions = createWorkflowNodes(type, registry, position);
    setNodes((ns) => [...ns, ...additions.nodes]);
    if (additions.edges.length) setEdges((es) => [...es, ...additions.edges]);
    if (groupExample && additions.nodes.length) {
      const workflowId = activeWorkflowIdRef.current;
      const nodeIds = new Set(additions.nodes.map((node) => node.id));
      const edgeIds = new Set(additions.edges.map((edge) => edge.id));
      let deadline = 0;
      const groupExampleWhenMeasured = (timestamp: number) => {
        if (!deadline) deadline = timestamp + 10000;
        if (activeWorkflowIdRef.current !== workflowId) return;
        const flow = groupFlowRef.current;
        const created = flow?.getNodes().filter((node) => nodeIds.has(node.id)) ?? [];
        const edgesReady = flow && [...edgeIds].every((id) => flow.getEdges().some((edge) => edge.id === id));
        if (created.length === nodeIds.size && edgesReady
          && created.every((node) => (node.measured?.width ?? 0) > 0 && (node.measured?.height ?? 0) > 0)) {
          const bounds = groupBoundsForNodes(created);
          if (bounds) setGroups((current) => [...current, { ...createCanvasGroup(bounds), title: def.label }]);
        } else if (timestamp < deadline) {
          window.requestAnimationFrame(groupExampleWhenMeasured);
        } else {
          console.error(`Could not create a group for ${def.label}: the example did not finish loading.`);
        }
      };
      window.requestAnimationFrame(groupExampleWhenMeasured);
    }
  };

  const addVfxRelightWorkflow = () => {
    try {
      const additions = createVfxRelightWorkflow(registry, {
        x: 100 + nodes.length * 30,
        y: 100 + nodes.length * 20,
      });
      setNodes((current) => [...current, ...additions.nodes]);
      setEdges((current) => [...current, ...additions.edges]);
      setActiveView("workflow");
      setStorageStatus("VFX relighting workflow added");
      setStorageError("");
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to add VFX relighting workflow");
    }
  };

  const addCompositorFrameToWorkflow = (dataUrl: string, time: number) => {
    if (!storageReady || !dataUrl.startsWith("data:image/png;base64,")) {
      const message = !storageReady
        ? "Workflow storage is still loading; try sending the frame again."
        : "The compositor frame is not a valid PNG image.";
      setStorageError(message);
      setStorageStatus("Unable to add compositor frame");
      throw new Error(message);
    }
    const node: Node = {
      id: `input/image-${crypto.randomUUID()}`,
      type: "workflow",
      position: { x: 100 + nodes.length * 30, y: 100 + nodes.length * 20 },
      data: {
        type: "input/image",
        params: { url: dataUrl },
        status: "idle",
        outputs: {},
        log: "",
        title: `Compositor frame · ${time.toFixed(1)} s`,
      },
    };
    const target = nodes.find((candidate) =>
      (candidate.data as { type?: string }).type === VFX_LIGHTING_REFERENCE_NODE_TYPE
      && !edges.some((edge) => edge.target === candidate.id && edge.targetHandle === "image"));
    setNodes((current) => [...current, node]);
    if (target) {
      setEdges((current) => [...current, {
        id: `${node.id}-${target.id}-compositor-frame`,
        source: node.id,
        sourceHandle: "image",
        target: target.id,
        targetHandle: "image",
      }]);
    }
    setActiveView("workflow");
    setStorageError("");
    setStorageStatus(target
      ? "Compositor frame added to the lighting reference"
      : "Compositor frame added as a workflow image input");
  };

  const exampleDrag = useExampleDrag(groupCanvasRef, (type, screenPosition) => {
    const flow = groupFlowRef.current;
    if (flow) addNode(type, true, flow.screenToFlowPosition(screenPosition));
    else console.error("Could not place the example: the canvas is not ready.");
  });

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const s = nodes.find((n) => n.id === c.source);
      const t = nodes.find((n) => n.id === c.target);
      if (!s || !t || !c.sourceHandle || !c.targetHandle) return false;
      const sourceType = (s.data as { type: string }).type;
      const targetType = (t.data as { type: string }).type;
      const a = registry[sourceType].outputs[c.sourceHandle];
      const targetDef = registry[targetType];
      const condition = targetDef.conditionalInputs?.[c.targetHandle];
      const targetParams = (t.data as { params?: Record<string, unknown> }).params ?? {};
      if (condition && targetParams[condition.param] !== condition.value) return false;
      if (targetType === "video/google-omni") {
        const task = String(targetParams.task);
        const original = normalizeOmniParams(targetParams).model === OMNI_MODELS["Gemini Omni Flash (original)"];
        const handle = c.targetHandle;
        const available = handle === "prompt"
          || (task === OMNI_TASKS["Image to video"] && (handle === "image" || (handle === "last_image" && !original)))
          || (task === OMNI_TASKS["Ingredients to video"]
            && (handle === "reference_images" || (!original && /^reference_video_[1-3]$/.test(handle))))
          || ([OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(task as never)
            && (handle === "video" || handle === "reference_images"));
        if (!available) return false;
        if (handle === "reference_images") {
          const currentCount = edges.filter((edge) => edge.target === c.target && edge.targetHandle === handle
            && edge.source !== c.source).length;
          const maximum = original ? 5 : 10;
          if (currentCount >= maximum) return false;
        }
      }
      if (targetType === "video/kling") {
        const params = targetParams;
        const task = String(params.task);
        const model = String(params.model);
        const v3 = model !== KLING_MODELS["Kling 4.0"];
        const handle = c.targetHandle;
        const isImageTask = task === KLING_TASKS["Image to video"];
        const isIngredients = task === KLING_TASKS["Ingredients to video"];
        const isEdit = task === KLING_TASKS["Edit video"];
        const isMotion = task === KLING_TASKS["Motion control"] && model === KLING_MODELS["Kling 2.6 Pro Motion Control"];
        const available = handle === "prompt"
          || (isMotion && ["image", "video"].includes(handle))
          || (isImageTask && ["image", "middle_images", v3 ? "end_image" : "last_image"].includes(handle))
          || (isIngredients && ["image", "middle_images", "last_image", "reference_images"].includes(handle)
            || isIngredients && /^reference_video_[1-5]$/.test(handle))
          || (isEdit && (handle === "video" || handle === "reference_images" || /^reference_video_[1-4]$/.test(handle)));
        if (!available) return false;
        const imageHandles = ["image", "middle_images", "last_image", "end_image", "reference_images"];
        if (imageHandles.includes(handle)) {
          const currentImages = edges.filter((edge) => edge.target === c.target
            && imageHandles.includes(edge.targetHandle ?? "")
            && !(edge.source === c.source && edge.targetHandle === handle)).length;
          if (currentImages >= 10) return false;
          if (handle === "middle_images" && currentImages >= 10) return false;
        }
        const referenceVideos = edges.filter((edge) => edge.target === c.target
          && /^reference_video_[1-5]$/.test(edge.targetHandle ?? "")
          && !(edge.source === c.source && edge.targetHandle === handle)).length;
        if (handle.startsWith("reference_video_")
          && referenceVideos >= (isEdit ? 4 : 5)) return false;
      }
      const b = targetDef.inputs[c.targetHandle];
      return a === b || a === "any" || b === "any";
    },
    [edges, nodes]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const target = nodes.find((node) => node.id === c.target);
      const targetType = (target?.data as { type?: string } | undefined)?.type;
      const targetHandle = c.targetHandle ?? "";
      const replacedSeedanceImageIds = targetType === "video/seedance"
        && ["image", "last_image"].includes(targetHandle)
        ? edges
          .filter((edge) => edge.target === c.target && edge.targetHandle === targetHandle && edge.source !== c.source)
          .map((edge) => nodes.find((node) => node.id === edge.source))
          .filter((node) => {
            const data = node?.data as { autoCreatedFor?: string; autoCreatedRole?: string } | undefined;
            return data?.autoCreatedFor === c.target
              && ["first_frame", "last_frame"].includes(data.autoCreatedRole ?? "");
          })
          .map((node) => node!.id)
        : [];
      const isWanImageTarget = targetType === WAN_NODE_TYPE
        && (["image", "last_image"].includes(targetHandle) || /^reference_image_\d+$/.test(targetHandle));
      const replacedWanImageIds = isWanImageTarget
        ? edges
          .filter((edge) => edge.target === c.target && edge.targetHandle === targetHandle && edge.source !== c.source)
          .map((edge) => nodes.find((node) => node.id === edge.source))
          .filter((node) => {
            const data = node?.data as { autoCreatedFor?: string; autoCreatedRole?: string } | undefined;
            const role = data?.autoCreatedRole ?? "";
            return data?.autoCreatedFor === c.target
              && (["first_frame", "last_frame"].includes(role) || /^reference_image_\d+$/.test(role));
          })
          .map((node) => node!.id)
        : [];
      const isMiniMaxFrameTarget = targetType === MINIMAX_NODE_TYPE
        && ["image", "end_image"].includes(targetHandle);
      const replacedMiniMaxImageIds = isMiniMaxFrameTarget
        ? edges
          .filter((edge) => edge.target === c.target && edge.targetHandle === targetHandle && edge.source !== c.source)
          .map((edge) => nodes.find((node) => node.id === edge.source))
          .filter((node) => {
            const data = node?.data as { autoCreatedFor?: string; autoCreatedRole?: string } | undefined;
            return data?.autoCreatedFor === c.target
              && ["first_frame", "last_frame"].includes(data.autoCreatedRole ?? "");
          })
          .map((node) => node!.id)
        : [];
      const replacedImageIds = new Set([
        ...replacedSeedanceImageIds,
        ...replacedWanImageIds,
        ...replacedMiniMaxImageIds,
      ]);
      if (replacedImageIds.size > 0) {
        setNodes((current) => current.filter((node) => !replacedImageIds.has(node.id)));
      }
      const allowsMultipleReferences = ["video/seedance", "video/google-omni"].includes(targetType ?? "")
        && c.targetHandle === "reference_images";
      const allowsMultipleKlingInputs = targetType === "video/kling"
        && ["reference_images", "middle_images"].includes(c.targetHandle ?? "");
      const allowsMultipleMiniMaxReferences = targetType === MINIMAX_NODE_TYPE
        && c.targetHandle === "references";
      const allowsMultipleFlux3References = targetType === FLUX3_NODE_TYPE
        && c.targetHandle === "reference_images";
      setEdges((current) => {
        const withoutReplacedInputs = current.filter((edge) => !replacedImageIds.has(edge.source));
        return addEdge(
          c,
          allowsMultipleReferences || allowsMultipleKlingInputs || allowsMultipleMiniMaxReferences
            || allowsMultipleFlux3References
            ? withoutReplacedInputs
            : withoutReplacedInputs.filter((edge) => !(edge.target === c.target && edge.targetHandle === c.targetHandle))
        );
      });
    },
    [edges, nodes, setEdges, setNodes]
  );

  const patch = (id: string, data: object) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)));

  const openPromptChat = (input: OllamaPromptContextInput) => {
    const workflowId = activeWorkflowIdRef.current;
    if (!workflowId) return;
    const context: OllamaPromptContext = {
      ...input,
      id: crypto.randomUUID(),
      workflowId,
      lastUserRequest: "",
    };
    ollamaPromptContextRef.current = context;
    setOllamaPromptContext(context);
  };

  const endPromptHelp = () => {
    ollamaPromptContextRef.current = null;
    setOllamaPromptContext(null);
  };

  const applyOllamaPrompt = (
    context: OllamaPromptContext,
    candidate: string,
    request: string,
  ): OllamaPromptApplyResult => {
    if (ollamaPromptContextRef.current?.id !== context.id) {
      return { ok: false, error: "This prompt-help session has ended. Reopen it from the Prompt node." };
    }
    if (activeWorkflowIdRef.current !== context.workflowId) {
      return { ok: false, error: "The active workflow changed. Reopen prompt help from the original Prompt node." };
    }
    const node = groupFlowRef.current?.getNode(context.nodeId);
    const data = node?.data as { type?: string; params?: Record<string, unknown> } | undefined;
    if (!data || data.type !== "input/prompt") {
      return { ok: false, error: "The original Prompt node no longer exists." };
    }
    const currentPrompt = typeof data.params?.text === "string" ? data.params.text : "";
    if (currentPrompt !== context.currentPrompt) {
      return { ok: false, error: "The Prompt node changed while Ollama was helping. Reopen prompt help to use its latest text." };
    }
    const connectedTargets = findPromptAssistantTargets(context.nodeId, nodes, edges);
    if (JSON.stringify(connectedTargets) !== JSON.stringify(context.connectedTargets)) {
      return { ok: false, error: "The connected model settings changed while Ollama was helping. Reopen prompt help." };
    }
    const validationError = validatePromptAssistantCandidate(
      context.currentPrompt,
      request,
      candidate,
      context.connectedTargets,
    );
    if (validationError) return { ok: false, error: validationError };

    const prompt = candidate.trim();
    patch(context.nodeId, {
      params: { ...data.params, text: prompt, refined_prompt: "" },
      outputs: {},
      status: "idle",
      log: "",
    });
    const nextContext = { ...context, currentPrompt: prompt, lastUserRequest: request };
    ollamaPromptContextRef.current = nextContext;
    setOllamaPromptContext(nextContext);
    return { ok: true };
  };

  const applyOllamaStoryboardShot = (
    context: Pick<OllamaStoryboardContext, "workflowId" | "scopeId">,
    shotId: string,
    expectedNumber: number,
    expectedDescription: string,
    expectedPrompt: string,
    candidate: string,
  ): OllamaApplyResult => {
    if (activeView !== "storyboard" || !ollamaStoryboardContext
      || ollamaStoryboardContext.workflowId !== context.workflowId
      || ollamaStoryboardContext.scopeId !== context.scopeId
      || activeWorkflowIdRef.current !== context.workflowId) {
      return { ok: false, error: "The active storyboard changed. Reopen storyboard chat before applying a suggestion." };
    }
    const prompt = candidate.trim();
    if (!prompt) return { ok: false, error: "The suggested shot Prompt is empty." };
    if (prompt.length > OLLAMA_STORYBOARD_PROMPT_MAX_LENGTH) {
      return { ok: false, error: `Shot Prompts must be ${OLLAMA_STORYBOARD_PROMPT_MAX_LENGTH.toLocaleString()} characters or fewer.` };
    }
    const currentShots = storyboard.scenes.flatMap((scene) => scene.shots);
    const shotIndex = currentShots.findIndex((item) => item.id === shotId);
    if (shotIndex < 0) return { ok: false, error: "That shot no longer exists in the storyboard." };
    if (shotIndex + 1 !== expectedNumber) {
      return { ok: false, error: "That shot was reordered while Ollama was helping. Ask again using its current shot number." };
    }
    const shot = currentShots[shotIndex];
    if (shot.description !== expectedDescription || shot.prompt !== expectedPrompt) {
      return { ok: false, error: "The shot's Description or Prompt changed while Ollama was helping. Ask again to use the latest text." };
    }
    setStoryboard((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => ({
        ...scene,
        shots: scene.shots.map((item) => item.id === shotId
          ? { ...item, prompt }
          : item),
      })),
    }));
    return { ok: true };
  };

  const pendingIntegration = nodes.some((n) => {
    const type = (n.data as { type?: string }).type;
    return type ? registry[type]?.integration === "pending" : false;
  });
  const generationSettings = useMemo(() => workflowGenerationNodes(nodes).map((node) => {
    const lowProfile = getLowSettingsProfile(node.type, node.params);
    return {
      ...node,
      lowProfile,
      lowParams: { ...node.params, ...lowProfile.overrides },
      description: lowSettingsDescription(node.type, node.label, node.params),
    };
  }), [nodes]);
  const runModeEstimates = useMemo(() => {
    let currentTotal = 0;
    let lowTotal = 0;
    let currentMissing = 0;
    let lowMissing = 0;
    for (const node of generationSettings) {
      const current = estimateNodeCost(node.type, node.params);
      const low = estimateNodeCost(node.type, node.lowParams);
      if (current === null) currentMissing++;
      else currentTotal += current;
      if (low === null) lowMissing++;
      else lowTotal += low;
    }
    return { currentTotal, lowTotal, currentMissing, lowMissing };
  }, [generationSettings]);

  const executeGraph = async (targetIds?: string[], lowSettings = false) => {
    if (runInProgress.current) return;
    const shouldUseLowSettings = lowSettings && !targetIds;
    let graph: Graph;
    try {
      const referenceScopeIds = targetIds ? new Set<string>() : undefined;
      if (referenceScopeIds) {
        const pending = [...(targetIds ?? [])];
        while (pending.length) {
          const currentId = pending.pop();
          if (!currentId || referenceScopeIds.has(currentId)) continue;
          referenceScopeIds.add(currentId);
          for (const edge of edges) {
            if (edge.target === currentId) pending.push(edge.source);
          }
        }
      }
      const sourceWorkflows = workflowsRef.current.map((workflow) => workflow.id === activeWorkflowIdRef.current
        ? { ...workflow, storyboard }
        : workflow);
      graph = {
        nodes: resolveWorkflowStoryboardFrames(nodes.map((n) => {
          const data = n.data as { type: string; params: Record<string, unknown> };
          return { id: n.id, type: data.type, params: data.params };
        }), sourceWorkflows, referenceScopeIds),
        edges: edges.map((e) => ({
          source: e.source, sourceHandle: e.sourceHandle!, target: e.target, targetHandle: e.targetHandle!,
        })),
      };
      graph.nodes = await resolveWorkflowCharacterReferences(
        graph.nodes,
        projectCharactersRef.current,
        (character) => loadApprovedCharacterReferenceImage(character, projectSessionRef.current),
        referenceScopeIds,
      );
    } catch (error) {
      alert(error instanceof Error ? error.message : "Could not resolve a storyboard or character reference.");
      return;
    }
    const issues = validateWorkflow(graph, targetIds);
    setValidationIssues(issues);
    setShowValidation(issues.length > 0);
    if (issues.some((issue) => issue.severity === "error")) return;
    if (nodes.some((node) => (node.data as { status?: string }).status === "running")) {
      alert("Wait for the current node generation to finish or stop waiting before running the workflow.");
      return;
    }
    const inScope = new Set<string>();
    const addUpstream = (id: string) => {
      if (inScope.has(id)) return;
      inScope.add(id);
      graph.edges.filter((edge) => edge.target === id).forEach((edge) => addUpstream(edge.source));
    };
    (targetIds ?? graph.nodes.map((node) => node.id)).forEach(addUpstream);
    const generators = graph.nodes.filter((node) => {
      const def = registry[node.type];
      return inScope.has(node.id) && def && !["Input", "Output", "Assistant"].includes(def.category);
    });
    if (generators.length && !window.confirm(
      `This run may submit ${generators.length} AI generation node${generators.length === 1 ? "" : "s"} (${generators.map((node) => registry[node.type].label).join(", ")}). Provider charges may apply. Stopping only stops waiting; submitted jobs may still be billed. Continue?`,
    )) return;
    const loweredNodes = shouldUseLowSettings
      ? generationSettings.filter((node) => Object.keys(node.lowProfile.overrides).length > 0)
      : [];
    if (lowRunSummaryTimer.current !== null) window.clearTimeout(lowRunSummaryTimer.current);
    setLowRunSummary("");
    setLowSettingsNodeIds(loweredNodes.map((node) => node.id));
    runInProgress.current = true;
    setIsRunning(true);
    abort.current = new AbortController();
    try {
      await runGraph(graph, {
        cache: cache.current,
        fresh: !targetIds,
        lowSettings: shouldUseLowSettings,
        ...(targetIds ? { targetIds } : {}),
        signal: abort.current.signal,
        onStatus: (id, status: NodeStatus, info) =>
          patch(id, info === undefined ? { status } : { status, log: info }),
        onOutput: (id, outputs) => patch(id, { outputs }),
        onParams: (id, params) => setNodes((current) => current.map((node) => {
          if (node.id !== id) return node;
          const currentParams = isRecord(node.data.params) ? node.data.params : {};
          return {
            ...node,
            data: {
              ...node.data,
              params: { ...currentParams, ...params },
              ...(params.prediction_id ? { outputs: {} } : {}),
            },
          };
        })),
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
      runInProgress.current = false;
      setIsRunning(false);
      setLowSettingsNodeIds([]);
      if (shouldUseLowSettings) {
        const asSetCount = generationSettings.length - loweredNodes.length;
        setLowRunSummary(
          `Test run at lowest settings. ${loweredNodes.length} nodes lowered, ${asSetCount} ran as set. Full quality is a separate paid run.`
        );
        lowRunSummaryTimer.current = window.setTimeout(() => setLowRunSummary(""), 8000);
      }
    }
  };
  const run = () => { void executeGraph(undefined, runMode === "low"); };
  const runNode = (nodeId: string) => { void executeGraph([nodeId]); };
  const addCharacterReferenceToWorkflow = (characterId: string) => {
    const character = projectCharactersRef.current.find((candidate) => candidate.id === characterId);
    if (!character?.referenceImageApproved || !character.referenceImageMediaAssetId) {
      setStorageError("Choose a character with an approved reference before adding it to Workflow.");
      setStorageStatus("Unable to add character reference");
      return;
    }
    const nodeId = `input/image-${crypto.randomUUID()}`;
    const node: Node = {
      id: nodeId,
      type: "workflow",
      position: { x: 100 + nodes.length * 30, y: 100 + nodes.length * 30 },
      data: {
        type: "input/image",
        params: {
          url: "",
          projectCharacterRef: { kind: "project-character", characterId },
        },
        status: "idle",
        outputs: {},
        log: "",
        title: `Character reference · ${character.name}`,
        paramLabels: { url: "Approved reference image" },
      },
    };
    setNodes((current) => [...current, node]);
    setActiveView("workflow");
    setStorageError("");
    setStorageStatus(`Added ${character.name}'s reference to Workflow; connect it to a reference-image input.`);
  };
  const addStoryboardFrameToWorkflow = (
    sceneId: string,
    shotId: string,
    videoType: string,
    lastFrameReference?: { sceneId: string; shotId: string },
  ) => {
    const workflowId = activeWorkflowIdRef.current;
    const scene = storyboard.scenes.find((candidate) => candidate.id === sceneId);
    const shot = scene?.shots.find((candidate) => candidate.id === shotId);
    if (!storageReady || !workflowId || !scene || !shot?.frame) return;
    const lastScene = lastFrameReference
      ? storyboard.scenes.find((candidate) => candidate.id === lastFrameReference.sceneId)
      : undefined;
    const lastShot = lastScene?.shots.find((candidate) => candidate.id === lastFrameReference?.shotId);
    if (lastFrameReference && (!lastScene || !lastShot?.frame
      || (lastScene.id === scene.id && lastShot.id === shot.id))) {
      setStorageError("Choose a different storyboard shot with a frame as the last frame.");
      setStorageStatus("Unable to add storyboard video model");
      return;
    }
    let additions: ReturnType<typeof createImageToVideoWorkflowNodes>
      | ReturnType<typeof createFirstLastFrameWorkflowNodes>;
    try {
      const position = { x: 100 + nodes.length * 30, y: 100 + nodes.length * 30 };
      additions = lastFrameReference
        ? createFirstLastFrameWorkflowNodes(videoType, registry, position)
        : createImageToVideoWorkflowNodes(videoType, registry, position);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to add storyboard video model");
      return;
    }
    const shotIndex = scene.shots.findIndex((candidate) => candidate.id === shotId);
    const shotName = shot.title.trim() || `Shot ${shotIndex + 1}`;
    const lastShotIndex = lastScene?.shots.findIndex((candidate) => candidate.id === lastShot?.id) ?? -1;
    const lastShotName = lastShot?.title.trim() || `Shot ${lastShotIndex + 1}`;
    const modelNode = additions.nodes.find((node) => node.data.type === videoType);
    if (!modelNode) {
      setStorageError(`Unable to create the ${additions.label} workflow node`);
      setStorageStatus("Unable to add storyboard video model");
      return;
    }
    const promptText = buildStoryboardVideoPrompt(
      scene,
      shot,
      lastScene && lastShot ? { scene: lastScene, shot: lastShot } : undefined,
      storyboard.styleBible,
    );
    const storyboardDurations = [shot.durationSeconds, lastShot?.durationSeconds]
      .filter((duration): duration is number => typeof duration === "number");
    const storyboardDurationSeconds = storyboardDurations.length
      ? storyboardDurations.reduce((total, duration) => total + duration, 0)
      : null;
    const workflowNodes = additions.nodes.map((node) => {
      if (node.data.type === videoType) {
        const params = isRecord(node.data.params) ? node.data.params : {};
        return {
          ...node,
          data: {
            ...node.data,
            params: {
              ...params,
              ...getStoryboardVideoParamOverrides(videoType, registry, params, {
                aspectRatio: storyboard.aspectRatio,
                durationSeconds: storyboardDurationSeconds,
                hasLastFrame: Boolean(lastShot),
              }),
            },
          },
        };
      }
      if (node.data.type !== "input/prompt") return node;
      return {
        ...node,
        data: {
          ...node.data,
          params: {
            ...(isRecord(node.data.params) ? node.data.params : {}),
            text: promptText,
          },
        },
      };
    });
    const firstFrameHandle = "firstFrameHandle" in additions
      ? additions.firstFrameHandle
      : additions.imageHandle;
    const lastFrameHandle = "lastFrameHandle" in additions ? additions.lastFrameHandle : undefined;
    const createStoryboardImageNode = (
      frameScene: NonNullable<typeof scene>,
      frameShot: NonNullable<typeof shot>,
      frameShotName: string,
      role: "guide" | "first" | "last",
      verticalOffset: number,
    ): Node => ({
      id: `input/image-${crypto.randomUUID()}`,
      type: "workflow",
      position: { x: modelNode.position.x - 360, y: modelNode.position.y + verticalOffset },
      data: {
        type: "input/image",
        params: {
          url: "",
          storyboardFrameRef: {
            kind: "storyboard-frame",
            workflowId,
            sceneId: frameScene.id,
            shotId: frameShot.id,
          },
        },
        status: "idle",
        outputs: {},
        log: "",
        title: `${role === "guide" ? "Storyboard guide" : role === "first" ? "Storyboard first frame" : "Storyboard last frame"} · ${frameScene.title} / ${frameShotName}`,
        paramLabels: { url: "Image (upload or paste URL)" },
      },
    });
    const frameNodes = [
      createStoryboardImageNode(scene, shot, shotName, lastShot ? "first" : "guide", 220),
      ...(lastScene && lastShot ? [
        createStoryboardImageNode(lastScene, lastShot, lastShotName, "last", 390),
      ] : []),
    ];
    const frameEdges = frameNodes.flatMap((imageNode, index) => {
      const targetHandle = index === 0 ? firstFrameHandle : lastFrameHandle;
      return targetHandle ? [{
        id: `${imageNode.id}-${modelNode.id}-storyboard-frame`,
        source: imageNode.id,
        sourceHandle: "image",
        target: modelNode.id,
        targetHandle,
      }] : [];
    });
    if (frameEdges.length !== frameNodes.length) {
      setStorageError(`The ${additions.label} model does not support a last-frame input.`);
      setStorageStatus("Unable to add storyboard video model");
      return;
    }
    setNodes((current) => [...current, ...frameNodes, ...workflowNodes]);
    setEdges((current) => [...current, ...additions.edges, ...frameEdges]);
    setActiveView("workflow");
    setStorageError("");
    setStorageStatus(lastShot
      ? `Added ${additions.label} first-and-last-frame workflow from ${shotName} to ${lastShotName}`
      : `Added ${additions.label} image-to-video workflow from ${shotName}`);
  };

  const persistWorkflowList = (nextWorkflows: SavedWorkflow[], nextActiveId: string) => {
    if (loadedWorkflowSessionKey.current !== workflowSessionKey) return false;
    const library: WorkflowLibrary = {
      version: 1,
      activeWorkflowId: nextActiveId,
      workflows: nextWorkflows,
      characters: projectCharactersRef.current,
      activeView,
    };
    if (projectSession) {
      workflowsRef.current = nextWorkflows;
      activeWorkflowIdRef.current = nextActiveId;
      setWorkflows(nextWorkflows);
      setActiveWorkflowId(nextActiveId);
      queueProjectWorkspaceSave(library, projectSession);
    } else {
      const serialized = JSON.stringify(library);
      try {
        window.localStorage.setItem(WORKFLOWS_STORAGE_KEY, serialized);
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : String(error));
        setStorageStatus("Unable to save workflow library");
        return false;
      }
      workflowsRef.current = nextWorkflows;
      activeWorkflowIdRef.current = nextActiveId;
      setWorkflows(nextWorkflows);
      setActiveWorkflowId(nextActiveId);
      lastSavedPayload.current = serialized;
    }
    return true;
  };

  const switchWorkflow = (nextId: string) => {
    if (nextId === activeWorkflowIdRef.current) return;
    if (!saveWorkflowLocally()) return;
    const next = workflowsRef.current.find((workflow) => workflow.id === nextId);
    if (!next) return;
    cache.current.clear();
    activeWorkflowIdRef.current = next.id;
    setActiveWorkflowId(next.id);
    setWorkflowName(next.name);
    setNodes(next.nodes);
    setEdges(next.edges);
    setGroups(next.groups);
    setStoryboard(next.storyboard);
    setShowValidation(false);
    setValidationIssues([]);
    setStorageStatus("Switched workflow");
    setStorageError("");
  };

  const saveStoryboardGeneratedTake = async (
    sceneId: string,
    shotId: string,
    candidate: StoryboardVideoCandidate,
    existingTakeId?: string,
  ) => {
    try {
      if (candidate.workflowId === activeWorkflowIdRef.current && !saveWorkflowLocally()) {
        throw new Error("Could not save the current workflow before saving this take.");
      }
      const sourceWorkflow = workflowsRef.current.find((workflow) => workflow.id === candidate.workflowId);
      const sourceScene = sourceWorkflow?.storyboard.scenes.find((scene) => scene.id === sceneId);
      const sourceShot = sourceScene?.shots.find((shot) => shot.id === shotId);
      const existingTake = existingTakeId
        ? sourceShot?.generatedTakes?.find((take) => take.id === existingTakeId)
        : undefined;
      if (!sourceWorkflow || !sourceScene || !sourceShot
        || !candidate.sourceShotRefs.some((reference) =>
          reference.sceneId === sceneId && reference.shotId === shotId)) {
        throw new Error("The storyboard shot connected to this video is no longer available.");
      }
      if (existingTakeId && !existingTake) {
        throw new Error("The saved storyboard take is no longer available.");
      }
      if (existingTake?.mediaAssetId) {
        throw new Error("This take already has a local copy.");
      }
      if (!existingTakeId && sourceShot.generatedTakes?.some((take) =>
        take.sourceId === candidate.sourceId && take.videoUrl === candidate.videoUrl)) {
        throw new Error("This workflow output is already saved as a take.");
      }

      const sessionAtStart = projectSessionRef.current;
      const outputAssetId = workflowOutputMediaId(
        candidate.workflowId,
        candidate.nodeId,
        candidate.outputPort,
      );
      const shotName = sourceShot.title.trim() || `Shot ${sourceScene.shots.indexOf(sourceShot) + 1}`;
      const snapshotAssetId = await workflowOutputSnapshotMediaId(
        candidate.workflowId,
        candidate.nodeId,
        candidate.outputPort,
        candidate.videoUrl,
      );
      if (await isWorkflowVideoSnapshotSuppressed(snapshotAssetId)) {
        await restoreWorkflowVideoSnapshot(snapshotAssetId);
        const snapshotTaskKey = `${candidate.workflowId}:${candidate.nodeId}:${candidate.outputPort}:${
          candidate.videoUrl
        }:${sessionAtStart?.sessionKey ?? "local"}`;
        generatedVideoSaves.current.delete(snapshotTaskKey);
      }
      const savedVideo = await ensureWorkflowVideoSaved(
        candidate.workflowId,
        candidate.nodeId,
        candidate.outputPort,
        candidate.videoUrl,
        `${candidate.model} - ${shotName}`,
        sessionAtStart,
      );
      registeredMediaUrls.current.set(outputAssetId, candidate.videoUrl);
      const currentSessionKey = projectSessionRef.current?.sessionKey ?? null;
      if (currentSessionKey !== (sessionAtStart?.sessionKey ?? null)) {
        throw new Error("The active project changed while this take was being saved. Try again.");
      }
      await refreshProjectMediaAssets();

      if (candidate.workflowId === activeWorkflowIdRef.current && !saveWorkflowLocally()) {
        throw new Error("Could not save workflow changes before attaching this take.");
      }
      if ((projectSessionRef.current?.sessionKey ?? null) !== (sessionAtStart?.sessionKey ?? null)) {
        throw new Error("The active project changed while this take was being saved. Try again.");
      }
      let updatedWorkflow: SavedWorkflow | undefined;
      let updatedShotFound = false;
      let updatedTakeFound = false;
      const take: StoryboardGeneratedTake = existingTake
        ? { ...existingTake, mediaAssetId: savedVideo.asset.id }
        : {
          id: crypto.randomUUID(),
          sourceId: candidate.sourceId,
          workflowId: candidate.workflowId,
          nodeId: candidate.nodeId,
          outputPort: candidate.outputPort,
          videoType: candidate.videoType,
          videoUrl: candidate.videoUrl,
          mediaAssetId: savedVideo.asset.id,
          model: candidate.model,
          prompt: candidate.prompt,
          createdAt: Date.now(),
        };
      const nextWorkflows = workflowsRef.current.map((workflow) => {
        if (workflow.id !== candidate.workflowId) return workflow;
        const nextStoryboard: StoryboardData = {
          ...workflow.storyboard,
          scenes: workflow.storyboard.scenes.map((scene) => scene.id !== sceneId ? scene : {
            ...scene,
            shots: scene.shots.map((shot) => {
              if (shot.id !== shotId) return shot;
              updatedShotFound = true;
              if (!existingTakeId) {
                return { ...shot, generatedTakes: [...(shot.generatedTakes ?? []), take] };
              }
              const generatedTakes = (shot.generatedTakes ?? []).map((savedTake) => {
                if (savedTake.id !== existingTakeId || savedTake.mediaAssetId) return savedTake;
                updatedTakeFound = true;
                return take;
              });
              return updatedTakeFound ? { ...shot, generatedTakes } : shot;
            }),
          }),
        };
        updatedWorkflow = { ...workflow, storyboard: nextStoryboard, updatedAt: Date.now() };
        return updatedWorkflow;
      });
      if (!updatedWorkflow || !updatedShotFound || (existingTakeId && !updatedTakeFound)) {
        throw new Error("The storyboard shot or take was removed before the local copy could be attached.");
      }
      if (!persistWorkflowList(nextWorkflows, activeWorkflowIdRef.current)) {
        throw new Error("Could not save the storyboard take to the workflow.");
      }
      if (activeWorkflowIdRef.current === candidate.workflowId) {
        setStoryboard(updatedWorkflow.storyboard);
      }
      setStorageError("");
      setStorageStatus(savedVideo.projectName
        ? `Saved take to ${savedVideo.projectName}`
        : "Saved take to this device");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save this generated take.";
      setStorageError(message);
      setStorageStatus(existingTakeId ? "Unable to save local take copy" : "Unable to save storyboard take");
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const saveExistingStoryboardTakeCopy = async (
    sceneId: string,
    shotId: string,
    take: StoryboardGeneratedTake,
  ) => {
    const candidate: StoryboardVideoCandidate = {
      sourceId: take.sourceId,
      workflowId: take.workflowId,
      nodeId: take.nodeId,
      outputPort: take.outputPort,
      videoType: take.videoType,
      videoUrl: take.videoUrl,
      model: take.model,
      prompt: take.prompt,
      sourceShotRefs: [{
        kind: "storyboard-frame",
        workflowId: take.workflowId,
        sceneId,
        shotId,
      }],
    };
    await saveStoryboardGeneratedTake(sceneId, shotId, candidate, take.id);
  };

  const createWorkflow = () => {
    if (!saveWorkflowLocally()) return;
    const workflow: SavedWorkflow = {
      id: crypto.randomUUID(),
      name: DEFAULT_WORKFLOW_NAME,
      nodes: [],
      edges: [],
      groups: [],
      storyboard: createEmptyStoryboard(),
      updatedAt: Date.now(),
    };
    const next = [...workflowsRef.current, workflow];
    if (!persistWorkflowList(next, workflow.id)) return;
    setWorkflowName(workflow.name);
    setNodes([]);
    setEdges([]);
    setGroups([]);
    setStoryboard(workflow.storyboard);
    setShowValidation(false);
    setValidationIssues([]);
    cache.current.clear();
    setStorageStatus("New workflow");
    setStorageError("");
  };

  const deleteWorkflow = () => {
    if (workflowsRef.current.length <= 1) return;
    const current = workflowsRef.current.find((workflow) => workflow.id === activeWorkflowIdRef.current);
    if (!window.confirm(`Delete "${current?.name ?? DEFAULT_WORKFLOW_NAME}"? This cannot be undone.`)) return;
    if (!saveWorkflowLocally()) return;
    const next = workflowsRef.current.filter((workflow) => workflow.id !== activeWorkflowIdRef.current);
    const active = next[0];
    if (!persistWorkflowList(next, active.id)) return;
    setWorkflowName(active.name);
    setNodes(active.nodes);
    setEdges(active.edges);
    setGroups(active.groups);
    setStoryboard(active.storyboard);
    setShowValidation(false);
    setValidationIssues([]);
    cache.current.clear();
    setStorageStatus("Workflow deleted");
    setStorageError("");
  };

  const exportJSON = () => {
    const savedNodes = nodes.map((node) => ({
      ...node,
      data: { ...node.data, status: "idle", log: "" },
    }));
    const blob = new Blob([JSON.stringify({
      version: 1,
      id: activeWorkflowIdRef.current,
      name: workflowName.trim() || DEFAULT_WORKFLOW_NAME,
      nodes: savedNodes,
      edges,
      groups,
      storyboard,
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const filename = (workflowName.trim() || "workflow").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-");
    a.download = `${filename}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setStorageStatus("Exported workflow");
    setStorageError("");
  };

  const importWorkflow = async (file?: File) => {
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(await file.text());
      const imported = normalizeWorkflow(raw);
      if (!saveWorkflowLocally()) return;
      const importedCharacters = imported.storyboard.characters ?? [];
      const nextProjectCharacters = [...projectCharactersRef.current];
      for (const candidate of importedCharacters) {
        const existing = nextProjectCharacters.find((character) =>
          character.id === candidate.id
          || character.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase());
        if (!existing) nextProjectCharacters.push(candidate);
      }
      projectCharactersRef.current = nextProjectCharacters;
      setProjectCharacters(nextProjectCharacters);
      const workflowId = crypto.randomUUID();
      const sourceWorkflowId = isRecord(raw) && typeof raw.id === "string" ? raw.id : "";
      const workflow: SavedWorkflow = {
        id: workflowId,
        ...imported,
        storyboard: { ...imported.storyboard, characters: [] },
        nodes: sourceWorkflowId
          ? rebindStoryboardWorkflowReferences(imported.nodes.map((node) => {
            const data = node.data as { type: string; params: Record<string, unknown> };
            return { id: node.id, type: data.type, params: data.params };
          }), sourceWorkflowId, workflowId).map((resolved, index) => ({
            ...imported.nodes[index],
            data: {
              ...imported.nodes[index].data,
              params: resolved.params,
            },
          }))
          : imported.nodes,
        updatedAt: Date.now(),
      };
      const next = [...workflowsRef.current, workflow];
      if (!persistWorkflowList(next, workflow.id)) return;
      setWorkflowName(workflow.name);
      setNodes(workflow.nodes);
      setEdges(workflow.edges);
      setGroups(workflow.groups);
      setStoryboard(workflow.storyboard);
      setShowValidation(false);
      setValidationIssues([]);
      cache.current.clear();
      setStorageStatus(`Imported "${workflow.name}"`);
      setStorageError("");
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to import workflow");
    }
  };

  const focusRunModeOption = (index: number) => {
    window.requestAnimationFrame(() => runModeOptionRefs.current[index]?.focus());
  };
  const toggleRunModeMenu = () => {
    const opening = !runModeMenuOpen;
    if (opening) {
      const bounds = runModeArrowRef.current?.getBoundingClientRect();
      if (bounds) {
        setRunModeMenuPosition({
          top: bounds.bottom + 7,
          right: Math.max(12, window.innerWidth - bounds.right),
        });
      }
    }
    setRunModeMenuOpen(opening);
    if (opening) focusRunModeOption(runMode === "all" ? 0 : 1);
  };
  const handleRunModeMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const activeIndex = runModeOptionRefs.current.findIndex((option) => option === document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setRunModeMenuOpen(false);
      runModeArrowRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const start = activeIndex < 0 ? (runMode === "all" ? 0 : 1) : activeIndex;
      focusRunModeOption((start + step + RUN_MODES.length) % RUN_MODES.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusRunModeOption(event.key === "Home" ? 0 : RUN_MODES.length - 1);
    }
  };

  return (
    <div className="ff-app" data-theme={uiTheme} data-button-color={uiButtonColor}>
      <ApiKeySetupRedirect />
      <header className="ff-toolbar">
        <div className="ff-brand">
          <span className="ff-brand-mark" aria-hidden="true">F</span>
          <div className="ff-brand-copy">
            <strong>fal flow</strong>
            <span>WORKFLOW + VIDEO EDITOR</span>
          </div>
          <ProjectFolderControl
            assets={projectMediaAssets}
            onProjectMediaChange={refreshProjectMediaAssets}
            onProjectSessionChange={updateProjectSession}
            onBeforePackageExport={prepareProjectPackageExport}
            projectSessionEpoch={projectSessionEpoch}
          />
          <button
            type="button"
            className="ff-toolbar-button ff-project-save-button"
            onClick={() => { void saveProjectNow().catch(() => {}); }}
            disabled={!projectSession || !projectSessionReady || projectSaving
              || !registeredSaveHandlers.editor || !registeredSaveHandlers.compositor}
            title={projectSaveError || "Save workflow, storyboard, video editor, and compositor to the open project."}
            aria-describedby={projectSaveStatus ? "ff-project-save-status" : undefined}
          >
            {projectSaving ? "Saving…" : projectSaveError ? "Save failed" : "Save Project"}
          </button>
          {projectSaveStatus && (
            <span
              id="ff-project-save-status"
              className="ff-project-save-status"
              role={projectSaveError ? "alert" : "status"}
              title={projectSaveError || projectSaveStatus}
            >
              {projectSaveError || projectSaveStatus}
            </span>
          )}
        </div>
        <div className="ff-workflow-name">
          <nav className="ff-mode-tabs" aria-label="App workspace">
            <button type="button" aria-pressed={activeView === "storyboard"} onClick={() => setActiveView("storyboard")}>Storyboard</button>
            <button type="button" aria-pressed={activeView === "workflow"} onClick={() => setActiveView("workflow")}>Workflow</button>
            <button type="button" aria-pressed={activeView === "editor"} onClick={() => setActiveView("editor")}>Video editor</button>
            <button type="button" aria-pressed={activeView === "compositor"} onClick={() => setActiveView("compositor")}>Compositor</button>
          </nav>
          {activeView === "workflow" ? (
            <>
              <span className="ff-workflow-indicator" />
              <select
                className="ff-workflow-select"
                aria-label="Select workflow"
                value={activeWorkflowId}
                onChange={(event) => switchWorkflow(event.target.value)}
                disabled={isRunning || workflows.length === 0}
              >
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                ))}
              </select>
              <input
                className="ff-workflow-title"
                aria-label="Workflow name"
                value={workflowName}
                maxLength={80}
                onChange={(event) => setWorkflowName(event.target.value)}
                onBlur={() => setWorkflowName((name) => name.trim() || "Untitled workflow")}
              />
              <span
                className={`ff-save-status${storageStatus.startsWith("Unable to") ? " ff-save-status-error" : ""}`}
                title={storageError || storageStatus}
                aria-live="polite"
              >
                {storageStatus}
              </span>
            </>
            ) : activeView === "editor" ? (
              <span className="ff-editor-mode-status">Timeline editor · H.264 MOV / MP4 export</span>
            ) : activeView === "compositor" ? (
              <span className="ff-editor-mode-status">Compositor workspace</span>
            ) : (
              <span className="ff-editor-mode-status">Storyboard workspace</span>
            )}
        </div>
        <div className="ff-toolbar-actions">
          <OllamaChat
            promptContext={ollamaPromptContext}
            storyboardContext={ollamaStoryboardContext}
            workflowContext={ollamaWorkflowContext}
            onApplyPrompt={applyOllamaPrompt}
            onApplyStoryboardShot={applyOllamaStoryboardShot}
            onEndPromptHelp={endPromptHelp}
            onClearStoryboard={clearStoryboard}
            onApplyStoryboard={(generatedStoryboard) => {
            const shotCount = generatedStoryboard.scenes.reduce((count, scene) => count + scene.shots.length, 0);
            if (storyboard.scenes.length > 0
              && !window.confirm(`Replace all current scenes and shots with the ${shotCount}-shot Ollama storyboard?`)) {
              return false;
            }
            setStoryboard((current) => ({
              ...current,
              scenes: generatedStoryboard.scenes,
              styleBible: generatedStoryboard.styleBible,
            }));
            setActiveView("storyboard");
            return true;
            }}
          />
          <WorkspaceHelp activeView={activeView} />
          {process.env.NODE_ENV === "development" && (
            <button type="button" className="ff-toolbar-button" onClick={() => router.push("/setup")}>
              API keys
            </button>
          )}
          {activeView === "workflow" ? (
            <>
          <button className="ff-toolbar-button" onClick={createWorkflow} disabled={!storageReady || isRunning}>New</button>
          <button className="ff-toolbar-button" onClick={deleteWorkflow} disabled={!storageReady || isRunning || workflows.length <= 1}>Delete</button>
          <button className="ff-toolbar-button" onClick={autoLayout} disabled={!storageReady || isRunning || nodes.length === 0} title="Arrange connected nodes and group workflows">Auto layout</button>
          <button className="ff-toolbar-button" onClick={clearCanvas} disabled={!storageReady || isRunning}>Clear</button>
          <button className="ff-toolbar-button" onClick={() => saveWorkflowLocally(true)} disabled={!storageReady}>Save</button>
          <button className="ff-toolbar-button" onClick={exportJSON} disabled={!storageReady}>Export</button>
          <label className="ff-toolbar-button ff-open">
            Import
            <input type="file" accept=".json,application/json" hidden disabled={!storageReady || isRunning} onChange={(event) => {
              void importWorkflow(event.target.files?.[0]);
              event.target.value = "";
            }} />
          </label>
          <button className="ff-toolbar-button" onClick={() => abort.current?.abort()} disabled={!isRunning}>Stop</button>
          <div className="ff-run-split" ref={runModeMenuRef}>
            <button
              className="ff-run"
              onClick={run}
              disabled={isRunning}
              title="Check for missing inputs and unsupported models before running"
            >
              {isRunning ? "Running workflow…" : "Run workflow"}
              {runMode === "low" && !isRunning && <span className="ff-run-low-label">Low</span>}
              <span aria-hidden="true">↗</span>
            </button>
            <button
              type="button"
              ref={runModeArrowRef}
              className="ff-run-mode-toggle"
              aria-label="Choose workflow run mode"
              aria-haspopup="menu"
              aria-expanded={runModeMenuOpen}
              aria-controls="ff-run-mode-menu"
              disabled={isRunning}
              onClick={toggleRunModeMenu}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (!runModeMenuOpen) toggleRunModeMenu();
                } else if (event.key === "Escape" && runModeMenuOpen) {
                  event.preventDefault();
                  setRunModeMenuOpen(false);
                }
              }}
            >
              <span aria-hidden="true">▾</span>
            </button>
            {runModeMenuOpen && (
              <div
                className="ff-run-mode-menu"
                id="ff-run-mode-menu"
                role="menu"
                aria-label="Workflow run mode"
                style={runModeMenuPosition}
                onKeyDown={handleRunModeMenuKeyDown}
              >
                {RUN_MODES.map((mode, index) => (
                  <button
                    key={mode}
                    ref={(element) => { runModeOptionRefs.current[index] = element; }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={runMode === mode}
                    className="ff-run-mode-option"
                    onClick={() => {
                      changeRunMode(mode);
                      runModeArrowRef.current?.focus();
                    }}
                  >
                    <span className="ff-run-mode-option-heading">
                      <strong>{mode === "all" ? "Run all" : "Run at lowest settings"}</strong>
                      <span aria-hidden="true">{runMode === mode ? "✓" : ""}</span>
                    </span>
                    <small>{mode === "all"
                      ? "Run every node with its current settings."
                      : "Run every node at its cheapest setting. Your node settings are not changed. Full quality is a separate paid run."}</small>
                  </button>
                ))}
                <details className="ff-run-mode-changes">
                  <summary>Show changes</summary>
                  <ul>
                    {generationSettings.length
                      ? generationSettings.map((node) => <li key={node.id}>{node.description}</li>)
                      : <li>No generation nodes in this graph.</li>}
                  </ul>
                </details>
                <div className="ff-run-mode-estimates" aria-label="Estimated workflow costs">
                  <span>Run all: {formatRunCost(runModeEstimates.currentTotal, runModeEstimates.currentMissing)}</span>
                  <span>At lowest settings: {formatRunCost(runModeEstimates.lowTotal, runModeEstimates.lowMissing)}</span>
                </div>
              </div>
            )}
          </div>
          {lowRunSummary && (
            <div className="ff-low-run-summary" role="status">
              <span>{lowRunSummary}</span>
              <button type="button" aria-label="Dismiss low-settings run summary" onClick={() => setLowRunSummary("")}>×</button>
            </div>
          )}
            </>
          ) : activeView === "editor" ? (
            <span className="ff-toolbar-note">H.264 MOV and MP4 export rendered on the server</span>
          ) : null}
          <label className="ff-theme-control">
            <span>Theme</span>
            <select
              className="ff-theme-select"
              aria-label="UI color theme"
              value={uiTheme}
              onChange={(event) => {
                if (UI_THEMES.includes(event.target.value as UiTheme)) {
                  changeUiTheme(event.target.value as UiTheme);
                }
              }}
            >
              {UI_THEMES.map((theme) => (
                <option key={theme} value={theme}>{UI_THEME_LABELS[theme]}</option>
              ))}
            </select>
          </label>
          <label className="ff-theme-control">
            <span>Buttons</span>
            <select
              className="ff-theme-select"
              aria-label="Button color"
              value={uiButtonColor}
              onChange={(event) => {
                if (UI_BUTTON_COLORS.includes(event.target.value as UiButtonColor)) {
                  changeUiButtonColor(event.target.value as UiButtonColor);
                }
              }}
            >
              {UI_BUTTON_COLORS.map((color) => (
                <option key={color} value={color}>{UI_BUTTON_COLOR_LABELS[color]}</option>
              ))}
            </select>
          </label>
          {themeError && <span className="ff-theme-error" role="status">{themeError}</span>}
        </div>
      </header>

      <div className={`ff-workflow-workspace${activeView === "workflow" ? "" : " ff-workspace-hidden"}`}>
      <aside className="ff-library">
        <div className="ff-library-heading">
          <span className="ff-overline">WORKFLOW BUILDER</span>
          <h1>Build your flow</h1>
          <p>Choose a node to add it to your canvas.</p>
        </div>

        <section className="ff-library-section">
          <div className="ff-section-title">
            <span className="ff-section-icon" aria-hidden="true">✦</span>
            <h2>Image generation</h2>
          </div>
          {imageModelGroups.map((group) => (
            <div className="ff-model-group" key={group.provider}>
              <div className="ff-group-heading">
                <span className={group.access.includes("LATER") ? "ff-access ff-access-pending" : "ff-access"}>
                  {group.access}
                </span>
              </div>
              {group.types.map((type) => {
                const def = registry[type];
                return (
                  <button className="ff-node-card" key={type} onClick={() => addNode(type)}>
                    <span className="ff-card-mark" aria-hidden="true">
                      {group.provider === "OpenAI" ? "O" : group.provider === "Google" ? "G" : "f"}
                    </span>
                    <span className="ff-card-copy">
                      <strong>{def.label}</strong>
                      <span>
                        {type === "openai/gpt-image"
                          ? "Usage billed through OPENAI_API_KEY"
                          : type === FLUX3_NODE_TYPE
                            ? "FLUX 3 text to image and image edit · Atlas Cloud"
                            : def.integration === "pending" ? "Available in UI · API setup later" : "Add image model node"}
                      </span>
                    </span>
                    <span className="ff-card-add" aria-hidden="true">+</span>
                  </button>
                );
              })}
            </div>
          ))}
        </section>

        <section className="ff-library-section">
          <div className="ff-section-title">
            <span className="ff-section-icon" aria-hidden="true">▶</span>
            <h2>Video generation</h2>
          </div>
          <div className="ff-model-group">
            <div className="ff-group-heading">
              <span className="ff-access">ATLAS CLOUD API · WAN 3.0, KLING, SEEDANCE, VEO & GEMINI OMNI FLASH</span>
            </div>
            {videoModelTypes.map((type) => {
              const def = registry[type];
              return (
                <button className="ff-node-card" key={type} onClick={() => addNode(type, true)}
                  onPointerDown={(event) => exampleDrag.onPointerDown(event, type, def.label)}
                  onPointerMove={exampleDrag.onPointerMove} onPointerUp={exampleDrag.onPointerUp}
                  onPointerCancel={exampleDrag.onPointerCancel} onLostPointerCapture={exampleDrag.onPointerCancel}
                  onClickCapture={exampleDrag.onClickCapture} onDragStart={(event) => event.preventDefault()}>
                  <span className="ff-card-mark" aria-hidden="true">▶</span>
                  <span className="ff-card-copy">
                    <strong>{def.label}</strong>
                    <span>{type === FLUX3_VIDEO_NODE_TYPE
                      ? "FLUX 3 text, image, frames, keyframes, extend, and edit video · Atlas Cloud"
                      : type === MINIMAX_NODE_TYPE
                      ? "MiniMax H3, Fast, Max, and Max Turbo · text, image, and reference-to-video"
                      : type === WAN_NODE_TYPE
                      ? "Wan 3.0 and Wan 3.0 Prime · text, image, and reference-to-video"
                      : type === "video/seedance"
                        ? "Seedance 2.5 text and image-to-video connected"
                      : type === "video/kling"
                        ? "Kling models connected"
                        : type === "video/veo"
                          ? "Veo 3.1 text, image, and reference-to-video connected"
                          : "Gemini Omni Flash text, image, reference, and video-edit connected"}</span>
                  </span>
                  <span className="ff-card-add" aria-hidden="true">+</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="ff-library-section ff-utility-section">
          <div className="ff-section-title">
            <span className="ff-section-icon ff-section-icon-muted" aria-hidden="true">＋</span>
            <h2>Workflow nodes</h2>
          </div>
          {utilityGroups.map((group) => (
            <details className="ff-utility-group" key={group.title} open={group.title === "Inputs"}>
              <summary>{group.title}<span aria-hidden="true">⌄</span></summary>
              <div className="ff-utility-items">
                {group.title === "VFX" && (
                  <button className="ff-utility-node" onClick={addVfxRelightWorkflow}>
                    <span>Build VFX relighting workflow<small>Video → frame → lighting reference → refined video</small></span>
                    <span aria-hidden="true">+</span>
                  </button>
                )}
                {group.types.map((type) => (
                  <button className="ff-utility-node" key={type} onClick={() => addNode(type)}>
                    <span>
                      {registry[type].label}
                      {type === "input/prompt" && <small>Optional local Ollama prompt help</small>}
                    </span>
                    <span aria-hidden="true">+</span>
                  </button>
                ))}
              </div>
            </details>
          ))}
        </section>

        <div className="ff-library-footer">
          {pendingIntegration
            ? "Some nodes are UI-only until API setup is complete."
            : "Drag nodes on the canvas to arrange your workflow."}
        </div>
      </aside>

      <main className="ff-canvas" ref={groupCanvasRef} onWheelCapture={zoomWorkflowOnNodeWheel}>
        <WorkflowRunContext.Provider value={{
          runNode,
          isRunning,
          lowSettingsNodeIds,
          openEditor: () => setActiveView("editor"),
          openPromptChat,
        }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onInit={(instance) => { groupFlowRef.current = instance; }}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onNodesDelete={(deletedNodes) => {
            const deletedVideoModelIds = new Set(deletedNodes
              .filter((node) => [WAN_NODE_TYPE, MINIMAX_NODE_TYPE, FLUX3_NODE_TYPE, "video/seedance", "video/veo", VFX_VIDEO_REFINE_NODE_TYPE]
                .includes((node.data as { type?: string }).type ?? ""))
              .map((node) => node.id));
            for (const node of deletedNodes) {
              const data = node.data as { type?: string; params?: { file?: { id?: unknown } | null } };
              const documentId = data.type === WAN_NODE_TYPE && typeof data.params?.file?.id === "string"
                ? data.params.file.id
                : "";
              if (documentId) {
                void deleteWanDocument(documentId).catch((error: unknown) => {
                  console.error("Could not remove the saved Wan document.", error);
                });
              }
            }
            const deletedOmniIds = new Set(deletedNodes
              .filter((node) => (node.data as { type?: string }).type === "video/google-omni")
              .map((node) => node.id));
            const deletedKlingIds = new Set(deletedNodes
              .filter((node) => (node.data as { type?: string }).type === "video/kling")
              .map((node) => node.id));
            if (deletedVideoModelIds.size === 0 && deletedOmniIds.size === 0 && deletedKlingIds.size === 0) return;
            const autoInputIds = new Set(nodes.filter((node) => {
              const meta = node.data as { autoCreatedFor?: string; autoInputFor?: string; autoFrameFor?: string };
              const owner = meta.autoCreatedFor ?? meta.autoInputFor ?? meta.autoFrameFor;
              return owner && deletedVideoModelIds.has(owner);
            }).map((node) => node.id));
            const omniInputIds = new Set(nodes.filter((node) => {
              const meta = node.data as { omniAutoCreatedFor?: string; omniRole?: string };
              return meta.omniAutoCreatedFor && deletedOmniIds.has(meta.omniAutoCreatedFor)
                && Boolean(meta.omniRole);
            }).map((node) => node.id));
            for (const inputId of omniInputIds) autoInputIds.add(inputId);
            const klingInputIds = nodes.filter((node) => {
              const meta = node.data as { klingAutoCreatedFor?: string; klingRole?: string };
              return meta.klingAutoCreatedFor && deletedKlingIds.has(meta.klingAutoCreatedFor)
                && Boolean(meta.klingRole);
            }).map((node) => node.id);
            for (const inputId of klingInputIds) autoInputIds.add(inputId);
            setNodes((current) => current.filter((node) => !autoInputIds.has(node.id)));
            setEdges((current) => current.filter((edge) =>
              !autoInputIds.has(edge.source)
              && !autoInputIds.has(edge.target)
              && !deletedVideoModelIds.has(edge.source)
              && !deletedVideoModelIds.has(edge.target)
              && !deletedOmniIds.has(edge.source)
              && !deletedOmniIds.has(edge.target)
              && !deletedKlingIds.has(edge.source)
              && !deletedKlingIds.has(edge.target)
            ));
          }}
          onConnect={onConnect} isValidConnection={isValidConnection}
          colorMode={uiTheme === "light" ? "light" : "dark"} fitView
          minZoom={0.5} zoomOnScroll deleteKeyCode={["Backspace", "Delete"]}
        >
          <Background gap={28} size={1} />
          <CanvasGroups key={activeWorkflowId} groups={groups} setGroups={setGroups} canvasRef={groupCanvasRef} active={activeView === "workflow"} />
          <Controls />
          <MiniMap pannable zoomable />
          {nodes.length === 0 && groups.length === 0 && (
            <div className="ff-empty-state">
              <span className="ff-empty-icon" aria-hidden="true">✦</span>
              <strong>Your canvas is ready</strong>
              <span>Add an image model from the library to get started.</span>
            </div>
          )}
        </ReactFlow>
        </WorkflowRunContext.Provider>
        {showValidation && validationIssues.length > 0 && (
          <section className="ff-validation-panel" aria-live="polite">
            <header>
              <strong>Workflow check</strong>
              <span>
                {validationIssues.filter((issue) => issue.severity === "error").length} errors
                {" · "}
                {validationIssues.filter((issue) => issue.severity === "warning").length} warnings
              </span>
              <button
                type="button"
                aria-label="Dismiss workflow check"
                onClick={() => setShowValidation(false)}
              >
                ×
              </button>
            </header>
            <ul>
              {validationIssues.map((issue, index) => (
                <li className={`ff-validation-${issue.severity}`} key={`${issue.nodeId ?? "workflow"}-${index}`}>
                  <span>{issue.nodeLabel ? `${issue.nodeLabel}: ` : ""}{issue.message}</span>
                  <strong>{issue.severity === "error" ? "Error" : "Warning"}</strong>
                </li>
              ))}
            </ul>
            {!validationIssues.some((issue) => issue.severity === "error") && (
              <p>Warnings won’t prevent the workflow from running.</p>
            )}
          </section>
        )}
      </main>
      </div>
      <VideoEditor
        key={`video-editor:${projectSession?.sessionKey ?? "local"}`}
        assets={videoAssets}
        onProjectMediaChange={refreshProjectMediaAssets}
        onProjectSessionChange={updateProjectSession}
        onRegisterSaveHandler={registerEditorSaveHandler}
        projectSession={projectSession}
        projectSessionReady={projectSessionReady}
        projectSessionEpoch={projectSessionEpoch}
        hidden={activeView !== "editor"}
      />
      <Compositor
        key={`compositor:${projectSession?.sessionKey ?? "local"}`}
        hidden={activeView !== "compositor"}
        onSendFrameToWorkflow={addCompositorFrameToWorkflow}
        sharedMediaAssets={projectMediaAssets}
        projectSession={projectSession}
        projectSessionReady={projectSessionReady}
        onProjectMediaChange={refreshProjectMediaAssets}
        onProjectSessionChange={updateProjectSession}
        onRegisterSaveHandler={registerCompositorSaveHandler}
      />
      <StoryboardTab storyboard={storyboard} characters={projectCharacters}
        onChange={setStoryboard} onCharactersChange={setProjectCharacters}
        onSaveCharacterReference={saveCharacterReferenceAsset}
        onSendFrame={addStoryboardFrameToWorkflow}
        onSaveTake={saveStoryboardGeneratedTake}
        onSaveTakeCopy={saveExistingStoryboardTakeCopy}
        onOpenWorkflow={(workflowId) => {
          if (workflowId !== activeWorkflowIdRef.current) {
            if (!workflowsRef.current.some((workflow) => workflow.id === workflowId)) {
              setStorageError("The workflow that generated this take is no longer available.");
              setStorageStatus("Unable to open source workflow");
              return;
            }
            switchWorkflow(workflowId);
            if (activeWorkflowIdRef.current !== workflowId) return;
          }
          setActiveView("workflow");
        }}
        videoCandidates={storyboardVideoCandidates}
        projectSession={projectSession}
        videoModelOptions={storyboardVideoModelOptions}
        firstLastFrameModelOptions={storyboardFirstLastFrameModelOptions}
        hidden={activeView !== "storyboard"}
        clearKey={storyboardClearKey}
        onAddCharacterReferenceToWorkflow={addCharacterReferenceToWorkflow}
        saveError={storageStatus === "Unable to save workflow"
          || storageStatus === "Unable to save project workflows" ? storageError : ""}
        autoSaveError={storageStatus === "Unable to save generated video locally" ? storageError : ""}
      />
      <ExampleDragPreview preview={exampleDrag.preview} />
    </div>
  );
}
