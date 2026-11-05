"use client";

import "@xyflow/react/dist/style.css";
import "./flow.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge,
  useNodesState, useEdgesState, type Connection, type Edge, type Node,
} from "@xyflow/react";
import { registry } from "@/lib/registry";
import { runGraph } from "@/lib/executor";
import { normalizeVeoParams } from "@/lib/veo";
import { normalizeOmniParams, OMNI_MODELS, OMNI_TASKS } from "@/lib/omni";
import { normalizeKlingParams, KLING_MODELS, KLING_TASKS } from "@/lib/kling";
import type { Graph, NodeStatus } from "@/lib/types";
import WorkflowNode, { WorkflowRunContext } from "@/components/WorkflowNode";

const nodeTypes = { workflow: WorkflowNode };
const WORKFLOW_STORAGE_KEY = "fal-flow:workflow";
const imageModelGroups = [
  { provider: "Google", access: "FREE TIER", types: ["google/gemini-image"] },
  { provider: "fal", access: "PAID · API CONNECTED", types: ["fal/nano-banana"] },
  {
    provider: "OpenAI",
    access: "PAID · API SETUP LATER",
    types: ["openai/gpt-image"],
  },
] as const;
const videoModelTypes = ["video/seedance", "video/kling", "video/veo", "video/google-omni"] as const;
const utilityGroups = [
  { title: "Inputs", types: ["input/prompt", "input/image", "input/number"] },
  { title: "Outputs", types: ["output/preview"] },
  { title: "Advanced", types: ["fal/model"] },
] as const;

export default function Page() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [workflowName, setWorkflowName] = useState("Untitled workflow");
  const [storageReady, setStorageReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Loading saved workflow…");
  const [storageError, setStorageError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const cache = useRef(new Map());
  const abort = useRef<AbortController | null>(null);
  const runInProgress = useRef(false);
  const lastSavedPayload = useRef("");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
        if (saved) {
          const workflow = JSON.parse(saved) as { name?: unknown; nodes?: unknown; edges?: unknown };
          if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
            throw new Error("Saved workflow data is invalid.");
          }
          setWorkflowName(typeof workflow.name === "string" && workflow.name.trim()
            ? workflow.name.trim()
            : "Untitled workflow");
          setNodes(workflow.nodes.map((node: Node) => ({
            ...node,
            data: {
              ...node.data,
              ...(node.data.type === "video/veo"
                ? { params: normalizeVeoParams((node.data.params ?? {}) as Record<string, unknown>) }
                : {}),
              ...(node.data.type === "video/google-omni"
                ? { params: normalizeOmniParams((node.data.params ?? {}) as Record<string, unknown>) }
                : {}),
              ...(node.data.type === "video/kling"
                ? { params: normalizeKlingParams((node.data.params ?? {}) as Record<string, unknown>) }
                : {}),
              status: "idle",
              log: "",
            },
          })));
          setEdges(workflow.edges);
          setStorageStatus("Restored from this device");
        } else {
          setStorageStatus("Not saved yet");
        }
        setStorageReady(true);
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : String(error));
        setStorageStatus("Unable to restore workflow");
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [setEdges, setNodes]);

  const saveWorkflowLocally = useCallback((manual = false) => {
    const savedNodes = nodes.map((node) => ({
      ...node,
      data: { ...node.data, status: "idle", log: "" },
    }));
    const payload = JSON.stringify({ name: workflowName.trim() || "Untitled workflow", nodes: savedNodes, edges });
    try {
      if (lastSavedPayload.current !== payload) {
        window.localStorage.setItem(WORKFLOW_STORAGE_KEY, payload);
        lastSavedPayload.current = payload;
      }
      setStorageError("");
      setStorageStatus(manual ? "Saved just now" : "Auto-saved on this device");
      setStorageReady(true);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to save workflow");
    }
  }, [edges, nodes, workflowName]);

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
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

  const addNode = (type: string) => {
    const def = registry[type];
    if (!def) return;
    const params = Object.fromEntries(def.params.map((p) => [p.key, p.default ?? ""]));
    const position = { x: 100 + nodes.length * 30, y: 100 + nodes.length * 30 };
    const nodeId = `${type}-${crypto.randomUUID()}`;
    const node = {
      id: nodeId,
      type: "workflow",
      position: def.autoPrompt ? { x: position.x + 360, y: position.y } : position,
      data: { type, params, status: "idle", outputs: {}, log: "" },
    };

    if (!def.autoPrompt) {
      setNodes((ns) => [...ns, node]);
      return;
    }

    const promptDef = registry["input/prompt"];
    const promptParams = Object.fromEntries(promptDef.params.map((p) => [p.key, p.default ?? ""]));
    const promptId = `input/prompt-${crypto.randomUUID()}`;
    const promptNode = {
      id: promptId,
      type: "workflow",
      position,
      data: { type: promptDef.type, params: promptParams, status: "idle", outputs: {}, log: "" },
    };
    setNodes((ns) => [...ns, promptNode, node]);
    setEdges((es) => [
      ...es,
      {
        id: `${promptId}-${nodeId}`,
        source: promptId,
        sourceHandle: "text",
        target: nodeId,
        targetHandle: "prompt",
      },
    ]);
  };

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
        const original = targetParams.model === OMNI_MODELS["Gemini Omni Flash (original)"];
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
        const available = handle === "prompt"
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
      const replacedSeedanceImageSet = new Set(replacedSeedanceImageIds);
      if (replacedSeedanceImageSet.size > 0) {
        setNodes((current) => current.filter((node) => !replacedSeedanceImageSet.has(node.id)));
      }
      const allowsMultipleReferences = ["video/seedance", "video/google-omni"].includes(targetType ?? "")
        && c.targetHandle === "reference_images";
      const allowsMultipleKlingInputs = targetType === "video/kling"
        && ["reference_images", "middle_images"].includes(c.targetHandle ?? "");
      setEdges((current) => {
        const withoutReplacedInputs = current.filter((edge) => !replacedSeedanceImageSet.has(edge.source));
        return addEdge(
          c,
          allowsMultipleReferences || allowsMultipleKlingInputs
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
    if (runInProgress.current || (!targetIds && pendingIntegration)) return;
    runInProgress.current = true;
    setIsRunning(true);
    abort.current = new AbortController();
    const graph: Graph = {
      nodes: nodes.map((n) => {
        const data = n.data as { type: string; params: Record<string, unknown> };
        return { id: n.id, type: data.type, params: data.params };
      }),
      edges: edges.map((e) => ({
        source: e.source, sourceHandle: e.sourceHandle!, target: e.target, targetHandle: e.targetHandle!,
      })),
    };
    try {
      await runGraph(graph, {
        cache: cache.current,
        ...(targetIds ? { targetIds } : {}),
        signal: abort.current.signal,
        onStatus: (id, status: NodeStatus, info) =>
          patch(id, info === undefined ? { status } : { status, log: info }),
        onOutput: (id, outputs) => patch(id, { outputs }),
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

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ name: workflowName.trim() || "Untitled workflow", nodes, edges }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const filename = (workflowName.trim() || "workflow").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "-");
    a.download = `${filename}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const load = async (file?: File) => {
    if (!file) return;
    const wf = JSON.parse(await file.text());
    cache.current.clear();
    setWorkflowName(typeof wf.name === "string" && wf.name.trim() ? wf.name.trim() : "Untitled workflow");
    setNodes((wf.nodes ?? []).map((n: Node) => {
      const data = n.data as { type?: string; params?: Record<string, unknown> };
      const legacyModel = data.type === "openai/gpt-image-2.6-flare"
        ? "GPT Image 2.6 · Flare"
        : data.type === "openai/gpt-image-2.6-sunburst"
          ? "GPT Image 2.6 · Sunburst"
          : undefined;
      return {
        ...n,
        data: {
          ...n.data,
          ...(legacyModel ? { type: "openai/gpt-image", params: { ...data.params, model: legacyModel } } : {}),
          ...(data.type === "video/veo"
            ? { params: normalizeVeoParams(data.params ?? {}) }
            : {}),
          ...(data.type === "video/google-omni"
            ? { params: normalizeOmniParams(data.params ?? {}) }
            : {}),
          ...(data.type === "video/kling"
            ? { params: normalizeKlingParams(data.params ?? {}) }
            : {}),
          status: "idle",
          outputs: {},
          log: "",
        },
      };
    }));
    setEdges(wf.edges ?? []);
  };

  return (
    <div className="ff-app">
      <header className="ff-toolbar">
        <div className="ff-brand">
          <span className="ff-brand-mark" aria-hidden="true">F</span>
          <div>
            <strong>fal flow</strong>
            <span>IMAGE WORKFLOW</span>
          </div>
        </div>
        <div className="ff-workflow-name">
          <span className="ff-workflow-indicator" />
          <input
            className="ff-workflow-title"
            aria-label="Workflow name"
            value={workflowName}
            maxLength={80}
            onChange={(event) => setWorkflowName(event.target.value)}
            onBlur={() => setWorkflowName((name) => name.trim() || "Untitled workflow")}
          />
          <span
            className={`ff-save-status${storageStatus === "Unable to save workflow" || storageStatus === "Unable to restore workflow" ? " ff-save-status-error" : ""}`}
            title={storageError || storageStatus}
            aria-live="polite"
          >
            {storageStatus}
          </span>
        </div>
        <div className="ff-toolbar-actions">
          <button className="ff-toolbar-button" onClick={clearCanvas}>Clear</button>
          <button className="ff-toolbar-button" onClick={() => saveWorkflowLocally(true)}>Save</button>
          <button className="ff-toolbar-button" onClick={exportJSON}>Export</button>
          <label className="ff-toolbar-button ff-open">
            Open
            <input type="file" accept="application/json" hidden onChange={(e) => load(e.target.files?.[0])} />
          </label>
          <button className="ff-toolbar-button" onClick={() => abort.current?.abort()} disabled={!isRunning}>Stop</button>
          <button
            className="ff-run"
            onClick={run}
            disabled={pendingIntegration || isRunning}
            title={pendingIntegration ? "Complete API setup before running this workflow" : undefined}
          >
            {isRunning ? "Running workflow…" : "Run workflow"} <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>

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
                        {def.integration === "pending" ? "Available in UI · API setup later" : "Add image model node"}
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
              <span className="ff-access">PARTIAL API · SEEDANCE 2.5 TEXT & IMAGE-TO-VIDEO</span>
            </div>
            {videoModelTypes.map((type) => {
              const def = registry[type];
              return (
                <button className="ff-node-card" key={type} onClick={() => addNode(type)}>
                  <span className="ff-card-mark" aria-hidden="true">▶</span>
                  <span className="ff-card-copy">
                    <strong>{def.label}</strong>
                    <span>{type === "video/seedance"
                      ? "Seedance 2.5 Text-to-Video and Image-to-Video connected"
                      : "Available in UI · API setup later"}</span>
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
                    <span>{registry[type].label}</span><span aria-hidden="true">+</span>
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

      <main className="ff-canvas">
        <WorkflowRunContext.Provider value={{ runNode, isRunning }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onNodesDelete={(deletedNodes) => {
            const deletedVideoModelIds = new Set(deletedNodes
              .filter((node) => ["video/seedance", "video/veo"].includes((node.data as { type?: string }).type ?? ""))
              .map((node) => node.id));
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
          colorMode="dark" fitView deleteKeyCode={["Backspace", "Delete"]}
        >
          <Background gap={28} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
          {nodes.length === 0 && (
            <div className="ff-empty-state">
              <span className="ff-empty-icon" aria-hidden="true">✦</span>
              <strong>Your canvas is ready</strong>
              <span>Add an image model from the library to get started.</span>
            </div>
          )}
        </ReactFlow>
        </WorkflowRunContext.Provider>
      </main>
    </div>
  );
}
