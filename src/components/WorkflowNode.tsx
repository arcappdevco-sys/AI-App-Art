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
  const { addEdges, addNodes, deleteElements, getNode, getNodes, updateNodeData } = useReactFlow();
  const d = data as any;
  const def = registry[d.type];

  const setParam = (key: string, value: any) =>
    updateNodeData(id, (n: any) => ({ params: { ...n.data.params, [key]: value } }));

  const setSelectParam = (key: string, value: string) => {
    setParam(key, value);
    if (d.type === "video/veo" && key === "model") {
      const resolutionParam = def.params.find((param) => param.key === "resolution");
      const availableResolutions = resolutionParam?.optionsByParam?.values[value] ?? resolutionParam?.options ?? [];
      if (!availableResolutions.includes(d.params.resolution)) {
        setParam("resolution", availableResolutions.includes("1080p") ? "1080p" : availableResolutions[0]);
      }
    }
    if (d.type !== "video/veo" || key !== "task") return;

    const requestedInputs = value === "Image to video"
      ? [
          { role: "first_frame", label: "First frame", y: -100 },
          { role: "last_frame", label: "Last frame", y: 180 },
        ]
      : value === "Ingredients to video"
        ? [
            { role: "ingredient_1", label: "Ingredient 1", y: -180 },
            { role: "ingredient_2", label: "Ingredient 2", y: 0 },
            { role: "ingredient_3", label: "Ingredient 3", y: 180 },
          ]
          : [];

    const node = getNode(id);
    const existingInputs = getNodes().filter(
      (candidate) => {
        const nodeData = candidate.data as { autoInputFor?: string; autoFrameFor?: string };
        return nodeData.autoInputFor === id || nodeData.autoFrameFor === id;
      }
    );
    const requestedRoles = new Set(requestedInputs.map(({ role }) => role));
    const obsoleteInputs = existingInputs.filter((candidate) => {
      const nodeData = candidate.data as { inputRole?: string; frameRole?: string };
      return !requestedRoles.has(nodeData.inputRole ?? nodeData.frameRole ?? "");
    });
    if (obsoleteInputs.length > 0) {
      void deleteElements({ nodes: obsoleteInputs.map(({ id: inputId }) => ({ id: inputId })) });
    }

    if (requestedInputs.length === 0) return;

    const existingRoles = new Set(
      existingInputs.filter((candidate) => !obsoleteInputs.some((obsolete) => obsolete.id === candidate.id)).map((candidate) => {
        const nodeData = candidate.data as { inputRole?: string; frameRole?: string };
        return nodeData.inputRole ?? nodeData.frameRole;
      })
    );
    const position = node?.position ?? { x: 400, y: 200 };
    const inputNodes = requestedInputs
      .filter(({ role }) => !existingRoles.has(role))
      .map(({ role, label, y }) => {
        const inputId = `input/image-${crypto.randomUUID()}`;
        return {
          node: {
            id: inputId,
            type: "workflow",
            position: {
              x: position.x - 360,
              y: position.y + y,
            },
            data: {
              type: "input/image",
              params: { url: "" },
              status: "idle",
              outputs: {},
              log: "",
              title: label,
              paramLabels: { url: `${label} image (upload or paste URL)` },
              autoInputFor: id,
              inputRole: role,
            },
          },
          edge: {
            id: `${inputId}-${id}-${role}`,
            source: inputId,
            sourceHandle: "image",
            target: id,
            targetHandle: role,
          },
        };
      });

    if (inputNodes.length === 0) return;
    addNodes(inputNodes.map(({ node: input }) => input));
    const edgesToAdd = inputNodes.map(({ edge }) => edge);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const currentData = getNode(id)?.data as { params?: Record<string, unknown> } | undefined;
        const currentTask = currentData?.params?.task;
        if (currentTask === value) addEdges(edgesToAdd);
      });
    });
  };

  if (!def) return <div className="ff-node">Unknown node: {d.type}</div>;

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
          {{
            first_frame: "First frame",
            last_frame: "Last frame",
            ingredient_1: "Ingredient 1",
            ingredient_2: "Ingredient 2",
            ingredient_3: "Ingredient 3",
          }[name] ?? name}
        </div>
      ))}

      {def.params.map((p) => (
        <label className="ff-param" key={p.key}>
          <span>{d.paramLabels?.[p.key] ?? p.label}</span>
          {p.kind === "select" ? (
            (() => {
              const options = p.optionsByParam
                ? p.optionsByParam.values[d.params[p.optionsByParam.param]] ?? p.options ?? []
                : p.options ?? [];
              const selectedValue = options.includes(d.params[p.key])
                ? d.params[p.key]
                : p.default ?? options[0] ?? "";
              return (
                <select className="nodrag" value={selectedValue}
                  onChange={(e) => setSelectParam(p.key, e.target.value)}>
                  {options.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              );
            })()
          ) : p.kind === "textarea" ? (
            <textarea className="nodrag nowheel" rows={3} value={d.params[p.key] ?? ""}
              onChange={(e) => setParam(p.key, e.target.value)} />
          ) : p.kind === "number" ? (
            <input className="nodrag" type="number" step={p.key === "seed" ? 1 : undefined} value={d.params[p.key] ?? 0}
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
