"use client";
import { Fragment, useState } from "react";
import { Handle, Position, useEdges, useReactFlow, type NodeProps } from "@xyflow/react";
import { fal } from "@fal-ai/client";
import { registry, PORT_COLORS } from "@/lib/registry";
import { SEEDANCE_MODELS, SEEDANCE_RATES } from "@/lib/seedance";
import { VEO_MODELS, VEO_RATES } from "@/lib/veo";

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
  const { addEdges, addNodes, deleteElements, getEdges, getNode, getNodes, updateNodeData } = useReactFlow();
  const renderedEdges = useEdges();
  const d = data as any;
  const def = registry[d.type];
  const isSeedance = d.type === "video/seedance";
  const isVeo = d.type === "video/veo";

  const setParam = (key: string, value: any) =>
    updateNodeData(id, (n: any) => ({ params: { ...n.data.params, [key]: value } }));

  const syncSeedanceInputs = async (task: string) => {
    const requestedInputs = task === "image-to-video"
      ? [
          { role: "first_frame", label: "First frame", handle: "image", y: -100 },
          { role: "last_frame", label: "Last frame", handle: "last_image", y: 180 },
        ]
      : task === "reference-to-video"
        ? [
            { role: "ingredient_1", label: "Ingredient 1", handle: "reference_images", y: -180 },
            { role: "ingredient_2", label: "Ingredient 2", handle: "reference_images", y: 0 },
            { role: "ingredient_3", label: "Ingredient 3", handle: "reference_images", y: 180 },
          ]
        : [];
    const wantedRoles = new Set(requestedInputs.map(({ role }) => role));
    const validHandles = new Set([
      "prompt",
      ...(task === "image-to-video" ? ["image", "last_image"] : []),
      ...(task === "reference-to-video" ? ["reference_images", "reference_videos", "reference_audios"] : []),
    ]);
    const existing = getNodes().filter((candidate) => {
      const meta = candidate.data as { autoCreatedFor?: string };
      return meta.autoCreatedFor === id;
    });
    const obsolete = existing.filter((candidate) => {
      const meta = candidate.data as { autoCreatedRole?: string };
      return !wantedRoles.has(meta.autoCreatedRole ?? "");
    });
    const obsoleteIds = new Set(obsolete.map(({ id: inputId }) => inputId));
    const edgesToRemove = getEdges().filter((edge) =>
      (edge.target === id && !validHandles.has(edge.targetHandle ?? "")) || obsoleteIds.has(edge.source)
    );
    if (obsolete.length > 0 || edgesToRemove.length > 0) {
      await deleteElements({
        nodes: obsolete.map(({ id: inputId }) => ({ id: inputId })),
        edges: edgesToRemove,
      });
    }
    setParam("task", task);

    const existingRoles = new Set(
      existing
        .filter((candidate) => !obsoleteIds.has(candidate.id))
        .map((candidate) => (candidate.data as { autoCreatedRole?: string }).autoCreatedRole)
    );
    const position = getNode(id)?.position ?? { x: 400, y: 200 };
    const additions = requestedInputs.filter(({ role }) => !existingRoles.has(role)).map(({ role, label, handle, y }) => {
      const inputId = `input/image-${crypto.randomUUID()}`;
      return {
        node: {
          id: inputId,
          type: "workflow",
          position: { x: position.x - 360, y: position.y + y },
          data: {
            type: "input/image",
            params: { url: "" },
            status: "idle",
            outputs: {},
            log: "",
            title: label,
            paramLabels: { url: `${label} image (upload or paste URL)` },
            autoCreatedFor: id,
            autoCreatedRole: role,
          },
        },
        edge: {
          id: `${inputId}-${id}-${role}`,
          source: inputId,
          sourceHandle: "image",
          target: id,
          targetHandle: handle,
        },
      };
    });
    if (additions.length === 0) return;
    addNodes(additions.map(({ node }) => node));
    const edgesToAdd = additions.map(({ edge }) => edge);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const currentTask = (getNode(id)?.data as { params?: Record<string, unknown> } | undefined)?.params?.task;
        if (currentTask === task) addEdges(edgesToAdd);
      });
    });
  };

  const syncVeoInputs = async (task: string) => {
    const requestedInputs = task === "image-to-video"
      ? [
          { role: "first_frame", label: "First frame", handle: "first_frame", y: -100 },
          { role: "last_frame", label: "Last frame", handle: "last_frame", y: 180 },
        ]
      : task === "reference-to-video"
        ? [
            { role: "ingredient_1", label: "Ingredient 1", handle: "ingredient_1", y: -180 },
            { role: "ingredient_2", label: "Ingredient 2", handle: "ingredient_2", y: 0 },
            { role: "ingredient_3", label: "Ingredient 3", handle: "ingredient_3", y: 180 },
          ]
        : [];
    const validHandles = new Set([
      "prompt",
      ...(task === "image-to-video" ? ["first_frame", "last_frame"] : []),
      ...(task === "reference-to-video" ? ["ingredient_1", "ingredient_2", "ingredient_3"] : []),
    ]);
    const existing = getNodes().filter((candidate) => {
      const meta = candidate.data as { autoCreatedFor?: string; autoInputFor?: string; autoFrameFor?: string };
      return meta.autoCreatedFor === id || meta.autoInputFor === id || meta.autoFrameFor === id;
    });
    const requestedRoles = new Set(requestedInputs.map(({ role }) => role));
    const obsolete = existing.filter((candidate) => {
      const meta = candidate.data as { autoCreatedRole?: string; inputRole?: string; frameRole?: string };
      return !requestedRoles.has(meta.autoCreatedRole ?? meta.inputRole ?? meta.frameRole ?? "");
    });
    const obsoleteIds = new Set(obsolete.map(({ id: inputId }) => inputId));
    const edgesToRemove = getEdges().filter((edge) =>
      (edge.target === id && !validHandles.has(edge.targetHandle ?? "")) || obsoleteIds.has(edge.source)
    );
    if (obsolete.length > 0 || edgesToRemove.length > 0) {
      await deleteElements({
        nodes: obsolete.map(({ id: inputId }) => ({ id: inputId })),
        edges: edgesToRemove,
      });
    }
    setParam("task", task);

    const existingRoles = new Set(existing
      .filter((candidate) => !obsoleteIds.has(candidate.id))
      .map((candidate) => {
        const meta = candidate.data as { autoCreatedRole?: string; inputRole?: string; frameRole?: string };
        return meta.autoCreatedRole ?? meta.inputRole ?? meta.frameRole;
      }));
    const position = getNode(id)?.position ?? { x: 400, y: 200 };
    const additions = requestedInputs.filter(({ role }) => !existingRoles.has(role)).map(({ role, label, handle, y }) => {
      const inputId = `input/image-${crypto.randomUUID()}`;
      return {
        node: {
          id: inputId,
          type: "workflow",
          position: { x: position.x - 360, y: position.y + y },
          data: {
            type: "input/image",
            params: { url: "" },
            status: "idle",
            outputs: {},
            log: "",
            title: label,
            paramLabels: { url: `${label} image (upload or paste URL)` },
            autoCreatedFor: id,
            autoCreatedRole: role,
          },
        },
        edge: {
          id: `${inputId}-${id}-${role}`,
          source: inputId,
          sourceHandle: "image",
          target: id,
          targetHandle: handle,
        },
      };
    });
    if (additions.length === 0) return;
    addNodes(additions.map(({ node }) => node));
    const edgesToAdd = additions.map(({ edge }) => edge);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const currentTask = (getNode(id)?.data as { params?: Record<string, unknown> } | undefined)?.params?.task;
        if (currentTask === task) addEdges(edgesToAdd);
      });
    });
  };

  const setSelectParam = (key: string, value: string) => {
    if (isSeedance && key === "task") {
      void syncSeedanceInputs(value);
      return;
    }
    if (isVeo && key === "task") {
      if (value === "reference-to-video") setParam("duration", "8");
      void syncVeoInputs(value);
      return;
    }
    setParam(key, value);
    if (isSeedance && key === "model") {
      const oldModel = String(d.params.model ?? "");
      const newModelIs25 = value === SEEDANCE_MODELS["Seedance 2.5"];
      const maxDuration = newModelIs25 ? 30 : 15;
      const currentDuration = Number(d.params.duration);
      if (currentDuration !== -1 && currentDuration > maxDuration) setParam("duration", "5");
      const resolutionParam = def.params.find((param) => param.key === "resolution");
      const available = resolutionParam?.optionsByParam?.values[value] ?? [];
      if (!available.includes(String(d.params.resolution))) setParam("resolution", "720p");
      if (oldModel !== value) {
        if (newModelIs25) setParam("bitrate_mode", "standard");
        else {
          setParam("draft", false);
          setParam("output_format", "mp4");
        }
      }
      return;
    }
    if (isVeo && key === "model") {
      const availableResolutions = def.params.find((param) => param.key === "resolution")
        ?.optionsByParam?.values[value] ?? [];
      if (!availableResolutions.includes(String(d.params.resolution))) setParam("resolution", "720p");
      const availableTasks = def.params.find((param) => param.key === "task")
        ?.optionsByParam?.values[value] ?? [];
      if (!availableTasks.includes(String(d.params.task))) void syncVeoInputs("text-to-video");
      if (Number(d.params.duration) !== 8 && String(d.params.resolution) !== "720p") {
        setParam("resolution", "720p");
      }
      return;
    }
    if (isVeo && key === "resolution" && value !== "720p" && Number(d.params.duration) !== 8) {
      setParam(key, value);
      setParam("duration", "8");
      return;
    }
    if (isVeo && key === "duration" && value !== "8" && String(d.params.resolution) !== "720p") {
      setParam(key, value);
      setParam("resolution", "720p");
      return;
    }
    if (isSeedance && key === "omni_reference_task_type") {
      if (value === "edit" || value === "extend") setParam("ratio", "adaptive");
      if (value === "edit") setParam("duration", "-1");
      return;
    }
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

  const connectedReferenceVideos = renderedEdges.filter(
    (edge) => edge.target === id && edge.targetHandle === "reference_videos"
  ).length;
  const connectedVeoInputs = new Set(renderedEdges
    .filter((edge) => edge.target === id)
    .map((edge) => edge.targetHandle));
  const showSeedanceParam = (param: (typeof def.params)[number]) => {
    if (param.visibleWhen && d.params[param.visibleWhen.param] !== param.visibleWhen.value) return false;
    if (param.key === "bitrate_mode" && d.params.model === SEEDANCE_MODELS["Seedance 2.5"]) return false;
    return true;
  };
  const costDuration = Number(d.params?.duration ?? (isSeedance ? 5 : 8));
  const rate = isSeedance
    ? SEEDANCE_RATES[String(d.params?.model)] ?? 0
    : isVeo
      ? VEO_RATES[String(d.params?.model)] ?? 0
      : 0;
  const costCount = Number(d.params?.[isSeedance ? "variations" : "count"]) || 1;
  const estimatedCost = costDuration === -1
    ? "~varies"
    : `~$${(costDuration * rate * costCount).toFixed(3)}`;
  const inputLabels: Record<string, string> = {
    first_frame: "First frame",
    last_frame: "Last frame",
    ingredient_1: "Ingredient 1",
    ingredient_2: "Ingredient 2",
    ingredient_3: "Ingredient 3",
    image: "First frame",
    last_image: "Last frame",
    reference_images: "Reference images",
    reference_videos: "Reference video",
    reference_audios: "Reference audio (coming soon)",
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
          <Fragment key={name}>
            <div className="ff-port ff-in">
              <Handle type="target" position={Position.Left} id={name}
                isConnectable={!def.disabledInputs?.[name]}
                title={def.disabledInputs?.[name]}
                style={{ background: PORT_COLORS[type], opacity: def.disabledInputs?.[name] ? 0.4 : 1 }} />
              {inputLabels[name] ?? name}
            </div>
            {isSeedance && name === "prompt" && d.params.task === "reference-to-video" && (
              <div className="ff-node-hint">
                Refer to references as @Image1, @Image2, @Video1, @Audio1
              </div>
            )}
          </Fragment>
        ))}

      {isSeedance && d.params.task === "reference-to-video"
        && ["edit", "extend"].includes(d.params.omni_reference_task_type)
        && connectedReferenceVideos !== 1 && (
          <div className="ff-node-warning" key="reference-video-warning">
            {connectedReferenceVideos === 0
              ? `${d.params.omni_reference_task_type === "edit" ? "Edit" : "Extend"} requires exactly one connected reference video.`
              : "Connect exactly one reference video for this task."}
          </div>
        )}
      {isVeo && d.params.task === "image-to-video" && !connectedVeoInputs.has("first_frame") && (
        <div className="ff-node-warning">Image to video requires a connected first frame.</div>
      )}
      {isVeo && d.params.task === "reference-to-video"
        && !["ingredient_1", "ingredient_2", "ingredient_3"].some((handle) => connectedVeoInputs.has(handle)) && (
          <div className="ff-node-warning">Ingredients to video requires at least one connected image.</div>
        )}

      {def.params.filter((param) => !isSeedance || showSeedanceParam(param)).map((p) => (
        <label className={`ff-param${p.kind === "toggle" ? " ff-param-toggle" : ""}`} key={p.key}>
          <span>{d.paramLabels?.[p.key] ?? p.label}</span>
          {p.kind === "toggle" ? (
            <input className="ff-toggle nodrag" type="checkbox" checked={Boolean(d.params[p.key])}
              onChange={(e) => {
                const checked = e.target.checked;
                setParam(p.key, checked);
                if (isSeedance && p.key === "draft" && checked) setParam("resolution", "480p");
              }} />
          ) : p.kind === "select" ? (
            (() => {
              const options = p.optionsByParam
                ? p.optionsByParam.values[d.params[p.optionsByParam.param]] ?? p.options ?? []
                : p.options ?? [];
              const selectedValue = options.includes(d.params[p.key])
                ? d.params[p.key]
                : p.default ?? options[0] ?? "";
              const isEdit = isSeedance && d.params.task === "reference-to-video"
                && d.params.omni_reference_task_type === "edit" && p.key === "duration";
              const isForcedRatio = isSeedance && d.params.task === "reference-to-video"
                && ["edit", "extend"].includes(d.params.omni_reference_task_type) && p.key === "ratio";
              const disabled = Boolean(
                (p.disabledWhen && d.params[p.disabledWhen.param] === p.disabledWhen.value)
                || isEdit || isForcedRatio
                || (isVeo && p.key === "duration" && d.params.task === "reference-to-video")
              );
              const optionLabel = (option: string) => p.optionLabels?.[option] ?? option;
              const optionGroups = p.optionGroups?.map((group) => ({
                ...group,
                options: group.options.filter((option) => options.includes(option)),
              })).filter((group) => group.options.length > 0);
              return (
                <select className="nodrag" value={selectedValue} disabled={disabled}
                  onChange={(e) => setSelectParam(p.key, e.target.value)}>
                  {optionGroups
                    ? optionGroups.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.options.map((option) => (
                            <option key={option} value={option}>{optionLabel(option)}</option>
                          ))}
                        </optgroup>
                      ))
                    : options.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
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
          {p.helperText
            && (p.key !== "draft" || d.params.draft)
            && (p.key !== "resolution" || (d.params.model === SEEDANCE_MODELS["Seedance 2.5"] && d.params.resolution === "4k-esr")) && (
            <small className="ff-param-help">{p.helperText}</small>
          )}
        </label>
      ))}

      {(isSeedance || isVeo) && (
        <div className="ff-node-cost">
          Estimated cost: {estimatedCost}{costDuration === -1 ? "" : ` (${costDuration}s × $${rate.toFixed(3)}/s × ${costCount})`}
        </div>
      )}

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
