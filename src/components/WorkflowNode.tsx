"use client";
import { useState } from "react";
import { Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { fal } from "@fal-ai/client";
import { registry, PORT_COLORS } from "@/lib/registry";

function Media({ value }: { value: unknown }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  if (typeof value !== "string" || !value) return null;
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(value);
  const isImage = /^data:image\//.test(value) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(value);
  if (!isVideo && !isImage) return null;

  const download = async () => {
    setDownloading(true);
    setDownloadError("");
    try {
      const response = await fetch(value);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blob = await response.blob();
      const pathname = new URL(value, window.location.href).pathname;
      const extension = pathname.match(/\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i)?.[0]
        ?? (isVideo ? ".mp4" : ".png");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `generated-media${extension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      {isVideo ? (
        <video className="ff-media nodrag" src={value} controls loop muted />
      ) : (
        <img className="ff-media" src={value} alt="" />
      )}
      <div className="ff-media-actions">
        <button className="ff-download" type="button" onClick={download} disabled={downloading}>
          {downloading ? "Preparing…" : "Download"}
        </button>
        {downloadError && (
          <span className="ff-download-error" role="status">
            {downloadError}. <a href={value} target="_blank" rel="noreferrer">Open media</a>
          </span>
        )}
      </div>
    </>
  );
}

export default function WorkflowNode({ id, data }: NodeProps) {
  const { addEdges, addNodes, getNode, getNodes, updateNodeData } = useReactFlow();
  const d = data as any;
  const def = registry[d.type];
  if (!def) return <div className="ff-node">Unknown node: {d.type}</div>;

  const setParam = (key: string, value: any) =>
    updateNodeData(id, (n: any) => ({ params: { ...n.data.params, [key]: value } }));

  const setSelectParam = (key: string, value: string) => {
    setParam(key, value);
    if (d.type !== "video/veo" || key !== "task" || value !== "Image to video") return;

    const node = getNode(id);
    const existingFrames = getNodes().filter(
      (candidate) => (candidate.data as { autoFrameFor?: string }).autoFrameFor === id
    );
    const existingRoles = new Set(
      existingFrames.map((candidate) => (candidate.data as { frameRole?: string }).frameRole)
    );
    const position = node?.position ?? { x: 400, y: 200 };
    const frameNodes = (["first_frame", "last_frame"] as const)
      .filter((role) => !existingRoles.has(role))
      .map((role) => {
        const label = role === "first_frame" ? "First frame" : "Last frame";
        const frameId = `input/image-${crypto.randomUUID()}`;
        return {
          node: {
            id: frameId,
            type: "workflow",
            position: {
              x: position.x - 360,
              y: position.y + (role === "first_frame" ? -100 : 180),
            },
            data: {
              type: "input/image",
              params: { url: "" },
              status: "idle",
              outputs: {},
              log: "",
              title: label,
              paramLabels: { url: `${label} image (upload or paste URL)` },
              autoFrameFor: id,
              frameRole: role,
            },
          },
          edge: {
            id: `${frameId}-${id}-${role}`,
            source: frameId,
            sourceHandle: "image",
            target: id,
            targetHandle: role,
          },
        };
      });

    if (frameNodes.length === 0) return;
    addNodes(frameNodes.map(({ node: frame }) => frame));
    addEdges(frameNodes.map(({ edge }) => edge));
  };

  const upload = async (key: string, file?: File) => {
    if (!file) return;
    updateNodeData(id, { log: "Uploading…" });
    try {
      setParam(key, await fal.storage.upload(file));
      updateNodeData(id, { log: "" });
    } catch (e: any) {
      updateNodeData(id, { status: "error", log: e?.message ?? "Upload failed" });
    }
  };

  return (
    <div className="ff-node" data-status={d.status}>
      <div className="ff-head">
        <span className="ff-node-label">{d.title ?? def.label}</span>
        <i className="ff-dot" />
      </div>
      {def.integration === "pending" && (
        <div className="ff-node-notice">API setup required before this model can run.</div>
      )}

      {Object.entries(def.inputs)
        .filter(([name]) => {
          const condition = def.conditionalInputs?.[name];
          return !condition || d.params[condition.param] === condition.value;
        })
        .map(([name, type]) => (
        <div className="ff-port ff-in" key={name}>
          <Handle type="target" position={Position.Left} id={name}
            style={{ background: PORT_COLORS[type] }} />
          {name === "first_frame" ? "First frame" : name === "last_frame" ? "Last frame" : name}
        </div>
      ))}

      {def.params.map((p) => (
        <label className="ff-param" key={p.key}>
          <span>{d.paramLabels?.[p.key] ?? p.label}</span>
          {p.kind === "select" ? (
            <select className="nodrag" value={d.params[p.key] ?? p.default ?? ""}
              onChange={(e) => setSelectParam(p.key, e.target.value)}>
              {p.options?.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : p.kind === "textarea" ? (
            <textarea className="nodrag nowheel" rows={3} value={d.params[p.key] ?? ""}
              onChange={(e) => setParam(p.key, e.target.value)} />
          ) : p.kind === "number" ? (
            <input className="nodrag" type="number" value={d.params[p.key] ?? 0}
              onChange={(e) => setParam(p.key, e.target.value)} />
          ) : p.kind === "file" ? (
            <>
              <input className="nodrag" type="text" placeholder="https://…" value={d.params[p.key] ?? ""}
                onChange={(e) => setParam(p.key, e.target.value)} />
              <input className="nodrag" type="file" accept="image/*"
                onChange={(e) => upload(p.key, e.target.files?.[0])} />
            </>
          ) : (
            <input className="nodrag" type="text" value={d.params[p.key] ?? ""}
              onChange={(e) => setParam(p.key, e.target.value)} />
          )}
        </label>
      ))}

      {Object.entries(def.outputs).map(([name, type]) => (
        <div className="ff-port ff-out" key={name}>
          {name}
          <Handle type="source" position={Position.Right} id={name}
            style={{ background: PORT_COLORS[type] }} />
        </div>
      ))}

      {Object.values(d.outputs ?? {}).map((v, i) => <Media key={i} value={v} />)}
      {d.log ? <div className="ff-log">{d.log}</div> : null}
    </div>
  );
}
