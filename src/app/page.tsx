"use client";

import "@xyflow/react/dist/style.css";
import "./flow.css";
import "./canvas-groups.css";
import "./example-drag.css";
import "./ollama-chat.css";
import "../components/StoryboardTab.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, type Connection, type Edge, type Node, type ReactFlowInstance,
} from "@xyflow/react";
import { registry } from "@/lib/registry";
import { runGraph } from "@/lib/executor";
import { normalizeVeoParams } from "@/lib/veo";
import { normalizeOmniParams, OMNI_MODELS, OMNI_TASKS } from "@/lib/omni";
import { normalizeKlingParams, KLING_MODELS, KLING_TASKS } from "@/lib/kling";
import { normalizeWanParams, WAN_NODE_TYPE } from "@/lib/wan";
import { deleteWanDocument } from "@/lib/wan-storage";
import { MINIMAX_NODE_TYPE, normalizeMiniMaxParams } from "@/lib/minimax";
import { FLUX3_NODE_TYPE, normalizeFlux3Params } from "@/lib/flux3";
import { FLUX3_VIDEO_NODE_TYPE } from "@/lib/flux3-video";
import { createWorkflowNodes, videoModelTypes } from "@/lib/workflow-node-factory";
import { validateWorkflow, type WorkflowValidationIssue } from "@/lib/workflow-validation";
import type { Graph, NodeStatus } from "@/lib/types";
import WorkflowNode, { WorkflowRunContext } from "@/components/WorkflowNode";
import VideoEditor, { type VideoAsset } from "@/components/VideoEditor";
import Compositor from "@/components/Compositor";
import StoryboardTab from "@/components/StoryboardTab";
import { createEmptyStoryboard, normalizeStoryboard, type StoryboardData } from "@/lib/StoryboardData";
import CanvasGroups from "@/components/CanvasGroups";
import { ExampleDragPreview, useExampleDrag } from "@/components/ExampleDrag";
import OllamaChat from "@/components/OllamaChat";
import { createCanvasGroup, groupBoundsForNodes, normalizeCanvasGroups, type CanvasGroup } from "@/lib/canvas-groups";

const nodeTypes = { workflow: WorkflowNode };
const WORKFLOWS_STORAGE_KEY = "fal-flow:workflows";
const LEGACY_WORKFLOW_STORAGE_KEY = "fal-flow:workflow";
const UI_THEME_STORAGE_KEY = "fal-flow:ui-theme";
const UI_BUTTON_COLOR_STORAGE_KEY = "fal-flow:ui-button-color";
const DEFAULT_WORKFLOW_NAME = "Untitled workflow";
const UI_THEMES = ["midnight", "ocean", "violet", "light"] as const;
type UiTheme = (typeof UI_THEMES)[number];
const UI_BUTTON_COLORS = ["blue", "violet", "coral", "amber", "slate"] as const;
type UiButtonColor = (typeof UI_BUTTON_COLORS)[number];
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
    return {
      id: item.id,
      type: "workflow",
      position: item.position as Node["position"],
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

export default function Page() {
  const [activeView, setActiveView] = useState<"storyboard" | "workflow" | "editor" | "compositor">("workflow");
  const [uiTheme, setUiTheme] = useState<UiTheme>("midnight");
  const [uiButtonColor, setUiButtonColor] = useState<UiButtonColor>("blue");
  const [themeError, setThemeError] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [groups, setGroups] = useState<CanvasGroup[]>([]);
  const [storyboard, setStoryboard] = useState<StoryboardData>(() => createEmptyStoryboard());
  const groupCanvasRef = useRef<HTMLElement>(null);
  const groupFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const [workflowName, setWorkflowName] = useState(DEFAULT_WORKFLOW_NAME);
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Loading saved workflow…");
  const [storageError, setStorageError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [validationIssues, setValidationIssues] = useState<WorkflowValidationIssue[]>([]);
  const [showValidation, setShowValidation] = useState(false);
  const cache = useRef(new Map());
  const abort = useRef<AbortController | null>(null);
  const runInProgress = useRef(false);
  const lastSavedPayload = useRef("");
  const workflowsRef = useRef<SavedWorkflow[]>([]);
  const activeWorkflowIdRef = useRef("");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const savedTheme = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
        if (savedTheme && UI_THEMES.includes(savedTheme as UiTheme)) setUiTheme(savedTheme as UiTheme);
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
  const videoAssets = useMemo<VideoAsset[]>(() => nodes.flatMap((node) => {
    const data = node.data as {
      type?: string;
      title?: string;
      params?: { title?: string };
      outputs?: Record<string, unknown>;
    };
    if (!data.type?.startsWith("video/")) return [];
    const label = data.params?.title || data.title || registry[data.type]?.label || "Video";
    return Object.entries(data.outputs ?? {})
      .filter(([, value]) => typeof value === "string" && /^https?:\/\//i.test(value))
      .map(([port, src]) => ({
        id: `${node.id}:${port}`,
        name: port === "video" ? label : `${label} · ${port.replaceAll("_", " ")}`,
        src: src as string,
      }));
  }), [nodes]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(WORKFLOWS_STORAGE_KEY);
        let nextWorkflows: SavedWorkflow[];
        let nextActiveId: string;
        if (saved) {
          const store: unknown = JSON.parse(saved);
          if (!isRecord(store) || (store.version !== undefined && store.version !== 1)
            || !Array.isArray(store.workflows) || store.workflows.length === 0) {
            throw new Error("Saved workflow library is invalid.");
          }
          nextWorkflows = store.workflows.map((item, index) => {
            if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
              throw new Error(`Saved workflow ${index + 1} is invalid.`);
            }
            return {
              id: item.id,
              ...normalizeWorkflow(item),
              updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
            };
          });
          if (new Set(nextWorkflows.map((workflow) => workflow.id)).size !== nextWorkflows.length) {
            throw new Error("Saved workflow library contains duplicate workflow IDs.");
          }
          nextActiveId = nextWorkflows.some((workflow) => workflow.id === store.activeWorkflowId)
            ? store.activeWorkflowId as string
            : nextWorkflows[0].id;
        } else {
          const legacy = window.localStorage.getItem(LEGACY_WORKFLOW_STORAGE_KEY);
          const normalized = legacy
            ? normalizeWorkflow(JSON.parse(legacy))
            : {
              name: DEFAULT_WORKFLOW_NAME,
              nodes: [],
              edges: [],
              groups: [],
              storyboard: createEmptyStoryboard(),
            };
          nextActiveId = crypto.randomUUID();
          nextWorkflows = [{ id: nextActiveId, ...normalized, updatedAt: Date.now() }];
        }
        const active = nextWorkflows.find((workflow) => workflow.id === nextActiveId)!;
        workflowsRef.current = nextWorkflows;
        activeWorkflowIdRef.current = nextActiveId;
        setWorkflows(nextWorkflows);
        setActiveWorkflowId(nextActiveId);
        setWorkflowName(active.name);
        setNodes(active.nodes);
        setEdges(active.edges);
        setGroups(active.groups);
        setStoryboard(active.storyboard);
        const serialized = JSON.stringify({ version: 1, activeWorkflowId: nextActiveId, workflows: nextWorkflows });
        window.localStorage.setItem(WORKFLOWS_STORAGE_KEY, serialized);
        window.localStorage.removeItem(LEGACY_WORKFLOW_STORAGE_KEY);
        lastSavedPayload.current = serialized;
        setStorageStatus(saved || window.localStorage.getItem(LEGACY_WORKFLOW_STORAGE_KEY)
          ? "Restored from this device"
          : "Auto-saved on this device");
        setStorageReady(true);
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : String(error));
        setStorageStatus("Unable to restore workflow");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [setEdges, setNodes]);

  const saveWorkflowLocally = useCallback((manual = false) => {
    if (!activeWorkflowIdRef.current) return false;
    const savedNodes = nodes.map((node) => ({
      ...node,
      data: { ...node.data, status: "idle", log: "" },
    }));
    const activeId = activeWorkflowIdRef.current;
    const current: SavedWorkflow = {
      id: activeId,
      name: workflowName.trim() || DEFAULT_WORKFLOW_NAME,
      nodes: savedNodes,
      edges,
      groups,
      storyboard,
      updatedAt: Date.now(),
    };
    const nextWorkflows = workflowsRef.current.some((workflow) => workflow.id === activeId)
      ? workflowsRef.current.map((workflow) => workflow.id === activeId ? current : workflow)
      : [...workflowsRef.current, current];
    const store = { version: 1, activeWorkflowId: activeId, workflows: nextWorkflows };
    const payload = JSON.stringify(store);
    try {
      if (lastSavedPayload.current !== payload) {
        window.localStorage.setItem(WORKFLOWS_STORAGE_KEY, payload);
        lastSavedPayload.current = payload;
      }
      workflowsRef.current = nextWorkflows;
      setWorkflows(nextWorkflows);
      setStorageError("");
      setStorageStatus(manual ? "Saved just now" : "Auto-saved on this device");
      setStorageReady(true);
      return true;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to save workflow");
      return false;
    }
  }, [edges, groups, nodes, storyboard, workflowName]);

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
    setGroups([]);
    setShowValidation(false);
    setValidationIssues([]);
    cache.current.clear();
  };

  useEffect(() => {
    if (!storageReady) return;
    const timeout = window.setTimeout(saveWorkflowLocally, 300);
    const saveOnPageHide = () => saveWorkflowLocally();
    window.addEventListener("pagehide", saveOnPageHide);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", saveOnPageHide);
    };
  }, [saveWorkflowLocally, storageReady]);

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

  const pendingIntegration = nodes.some((n) => {
    const type = (n.data as { type?: string }).type;
    return type ? registry[type]?.integration === "pending" : false;
  });

  const executeGraph = async (targetIds?: string[]) => {
    if (runInProgress.current) return;
    const graph: Graph = {
      nodes: nodes.map((n) => {
        const data = n.data as { type: string; params: Record<string, unknown> };
        return { id: n.id, type: data.type, params: data.params };
      }),
      edges: edges.map((e) => ({
        source: e.source, sourceHandle: e.sourceHandle!, target: e.target, targetHandle: e.targetHandle!,
      })),
    };
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
    runInProgress.current = true;
    setIsRunning(true);
    abort.current = new AbortController();
    try {
      await runGraph(graph, {
        cache: cache.current,
        fresh: !targetIds,
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
    }
  };
  const run = () => { void executeGraph(); };
  const runNode = (nodeId: string) => { void executeGraph([nodeId]); };

  const persistWorkflowList = (nextWorkflows: SavedWorkflow[], nextActiveId: string) => {
    const serialized = JSON.stringify({ version: 1, activeWorkflowId: nextActiveId, workflows: nextWorkflows });
    try {
      window.localStorage.setItem(WORKFLOWS_STORAGE_KEY, serialized);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to save workflow library");
      return false;
    }
    workflowsRef.current = nextWorkflows;
    activeWorkflowIdRef.current = nextActiveId;
    lastSavedPayload.current = serialized;
    setWorkflows(nextWorkflows);
    setActiveWorkflowId(nextActiveId);
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
      const imported = normalizeWorkflow(JSON.parse(await file.text()));
      if (!saveWorkflowLocally()) return;
      const workflow: SavedWorkflow = {
        id: crypto.randomUUID(),
        ...imported,
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

  return (
    <div className="ff-app" data-theme={uiTheme} data-button-color={uiButtonColor}>
      <header className="ff-toolbar">
        <div className="ff-brand">
          <span className="ff-brand-mark" aria-hidden="true">F</span>
          <div>
            <strong>fal flow</strong>
            <span>WORKFLOW + VIDEO EDITOR</span>
          </div>
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
          <OllamaChat />
          {activeView === "workflow" ? (
            <>
          <button className="ff-toolbar-button" onClick={createWorkflow} disabled={!storageReady || isRunning}>New</button>
          <button className="ff-toolbar-button" onClick={deleteWorkflow} disabled={!storageReady || isRunning || workflows.length <= 1}>Delete</button>
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
          <button
            className="ff-run"
            onClick={run}
            disabled={isRunning}
            title="Check for missing inputs and unsupported models before running"
          >
            {isRunning ? "Running workflow…" : "Run workflow"} <span aria-hidden="true">↗</span>
          </button>
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
                {group.types.map((type) => (
                  <button className="ff-utility-node" key={type} onClick={() => addNode(type)}>
                    <span>
                      {registry[type].label}
                      {type === "input/prompt" && <small>Optional Prompt Assistant</small>}
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

      <main className="ff-canvas" ref={groupCanvasRef}>
        <WorkflowRunContext.Provider value={{ runNode, isRunning, openEditor: () => setActiveView("editor") }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onInit={(instance) => { groupFlowRef.current = instance; }}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onNodesDelete={(deletedNodes) => {
            const deletedVideoModelIds = new Set(deletedNodes
              .filter((node) => [WAN_NODE_TYPE, MINIMAX_NODE_TYPE, FLUX3_NODE_TYPE, "video/seedance", "video/veo"].includes((node.data as { type?: string }).type ?? ""))
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
          colorMode={uiTheme === "light" ? "light" : "dark"} fitView deleteKeyCode={["Backspace", "Delete"]}
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
      <VideoEditor assets={videoAssets} hidden={activeView !== "editor"} />
      <Compositor hidden={activeView !== "compositor"} />
      <StoryboardTab storyboard={storyboard} onChange={setStoryboard} hidden={activeView !== "storyboard"}
        saveError={storageStatus.startsWith("Unable to") ? storageError : ""} />
      <ExampleDragPreview preview={exampleDrag.preview} />
    </div>
  );
}
