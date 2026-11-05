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
import type { Graph, NodeStatus } from "@/lib/types";
import WorkflowNode from "@/components/WorkflowNode";

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
  const [storageReady, setStorageReady] = useState(false);
  const [storageStatus, setStorageStatus] = useState("Loading saved workflow…");
  const [storageError, setStorageError] = useState("");
  const cache = useRef(new Map());
  const abort = useRef<AbortController | null>(null);
  const lastSavedPayload = useRef("");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
        if (saved) {
          const workflow = JSON.parse(saved) as { nodes?: unknown; edges?: unknown };
          if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
            throw new Error("Saved workflow data is invalid.");
          }
          setNodes(workflow.nodes.map((node: Node) => ({
            ...node,
            data: { ...node.data, status: "idle", log: "" },
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

  const saveWorkflowLocally = useCallback(() => {
    const savedNodes = nodes.map((node) => ({
      ...node,
      data: { ...node.data, status: "idle", log: "" },
    }));
    const payload = JSON.stringify({ nodes: savedNodes, edges });
    try {
      if (lastSavedPayload.current !== payload) {
        window.localStorage.setItem(WORKFLOW_STORAGE_KEY, payload);
        lastSavedPayload.current = payload;
      }
      setStorageError("");
      setStorageStatus("Saved on this device");
      setStorageReady(true);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      setStorageStatus("Unable to save workflow");
    }
  }, [edges, nodes]);

  useEffect(() => {
    if (!storageReady) return;
    const timeout = window.setTimeout(saveWorkflowLocally, 300);
    window.addEventListener("pagehide", saveWorkflowLocally);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", saveWorkflowLocally);
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
      const b = targetDef.inputs[c.targetHandle];
      return a === b || a === "any" || b === "any";
    },
    [nodes]
  );

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(c, es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)))
      ),
    [setEdges]
  );

  const patch = (id: string, data: object) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)));

  const pendingIntegration = nodes.some((n) => {
    const type = (n.data as { type?: string }).type;
    return type ? registry[type]?.integration === "pending" : false;
  });

  const run = async () => {
    if (pendingIntegration) return;
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
        signal: abort.current.signal,
        onStatus: (id, status: NodeStatus, info) =>
          patch(id, info === undefined ? { status } : { status, log: info }),
        onOutput: (id, outputs) => patch(id, { outputs }),
      });
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "workflow.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const load = async (file?: File) => {
    if (!file) return;
    const wf = JSON.parse(await file.text());
    cache.current.clear();
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
          <span>Untitled workflow</span>
          <span
            className={`ff-save-status${storageStatus === "Unable to save workflow" || storageStatus === "Unable to restore workflow" ? " ff-save-status-error" : ""}`}
            title={storageError || storageStatus}
            aria-live="polite"
          >
            {storageStatus}
          </span>
        </div>
        <div className="ff-toolbar-actions">
          <button className="ff-toolbar-button" onClick={saveWorkflowLocally}>Save</button>
          <button className="ff-toolbar-button" onClick={exportJSON}>Export</button>
          <label className="ff-toolbar-button ff-open">
            Open
            <input type="file" accept="application/json" hidden onChange={(e) => load(e.target.files?.[0])} />
          </label>
          <button className="ff-toolbar-button" onClick={() => abort.current?.abort()}>Stop</button>
          <button
            className="ff-run"
            onClick={run}
            disabled={pendingIntegration}
            title={pendingIntegration ? "Complete API setup before running this workflow" : undefined}
          >
            Run workflow <span aria-hidden="true">↗</span>
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
              <span className="ff-access ff-access-pending">API SETUP LATER</span>
            </div>
            {videoModelTypes.map((type) => {
              const def = registry[type];
              return (
                <button className="ff-node-card" key={type} onClick={() => addNode(type)}>
                  <span className="ff-card-mark" aria-hidden="true">▶</span>
                  <span className="ff-card-copy">
                    <strong>{def.label}</strong>
                    <span>Available in UI · API setup later</span>
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
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
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
      </main>
    </div>
  );
}
