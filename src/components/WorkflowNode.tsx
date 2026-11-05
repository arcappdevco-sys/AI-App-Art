"use client";
import { Fragment, useState } from "react";
import { Handle, Position, useEdges, useReactFlow, type NodeProps } from "@xyflow/react";
import { fal } from "@fal-ai/client";
import { registry, PORT_COLORS } from "@/lib/registry";
import { SEEDANCE_MODELS, SEEDANCE_RATES } from "@/lib/seedance";
import { VEO_MODELS, VEO_RATES } from "@/lib/veo";
import { OMNI_DEFAULTS, OMNI_MODELS, OMNI_RATES, OMNI_TASKS } from "@/lib/omni";

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
  const isOmni = d.type === "video/google-omni";
  const isOmniImage = d.type === "input/image" && (
    d.omniAutoCreatedFor
    || renderedEdges.some((edge) => edge.source === id
      && (getNode(edge.target)?.data as { type?: string } | undefined)?.type === "video/google-omni")
  );

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

  const syncOmniInputs = async (requestedTask: string, requestedModel = String(d.params.model)) => {
    const task = requestedTask === OMNI_TASKS["Extend video"]
      && requestedModel === OMNI_MODELS["Gemini Omni Flash (original)"]
      ? OMNI_TASKS["Text to video"]
      : requestedTask;
    const original = requestedModel === OMNI_MODELS["Gemini Omni Flash (original)"];
    const maximumReferences = original ? 5 : 10;
    const currentNodes = getNodes();
    const existing = currentNodes.filter((candidate) => {
      const meta = candidate.data as { omniAutoCreatedFor?: string };
      return meta.omniAutoCreatedFor === id;
    });
    const roleOf = (candidate: typeof existing[number]) =>
      (candidate.data as { omniRole?: string }).omniRole ?? "";
    const existingIngredientRoles = existing.map(roleOf)
      .filter((role) => /^ingredient_\d+$/.test(role))
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
    const existingReferenceRoles = existing.map(roleOf)
      .filter((role) => /^reference_image_\d+$/.test(role))
      .sort((a, b) => Number(a.split("_")[2]) - Number(b.split("_")[2]));

    const requestedRoles = new Set<string>();
    if (task === OMNI_TASKS["Image to video"]) {
      requestedRoles.add("first_frame");
      if (!original) requestedRoles.add("last_frame");
    }
    if (task === OMNI_TASKS["Ingredients to video"]) {
      for (let index = 1; index <= Math.max(3, Math.min(maximumReferences, existingIngredientRoles.length)); index++) {
        requestedRoles.add(`ingredient_${index}`);
      }
    }
    if ([OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(task as never)) {
      for (const role of existingReferenceRoles) {
        if (Number(role.split("_")[2]) <= maximumReferences) requestedRoles.add(role);
      }
    }

    const validHandles = new Set<string>(["prompt"]);
    if (task === OMNI_TASKS["Image to video"]) {
      validHandles.add("image");
      if (!original) validHandles.add("last_image");
    }
    if (task === OMNI_TASKS["Ingredients to video"]) {
      validHandles.add("reference_images");
      if (!original) {
        validHandles.add("reference_video_1");
        validHandles.add("reference_video_2");
        validHandles.add("reference_video_3");
      }
    }
    if ([OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(task as never)) {
      validHandles.add("video");
      validHandles.add("reference_images");
    }
    const obsolete = existing.filter((candidate) => !requestedRoles.has(roleOf(candidate)));
    const obsoleteIds = new Set(obsolete.map(({ id: inputId }) => inputId));
    const incomingReferenceEdges = getEdges().filter((edge) =>
      edge.target === id && edge.targetHandle === "reference_images"
    );
    const excessReferenceEdgeIds = new Set(original
      ? incomingReferenceEdges.slice(maximumReferences).map((edge) => edge.id)
      : []);
    const staleEdges = getEdges().filter((edge) =>
      (edge.target === id && !validHandles.has(edge.targetHandle ?? "")) || obsoleteIds.has(edge.source)
      || excessReferenceEdgeIds.has(edge.id)
    );
    if (obsolete.length > 0 || staleEdges.length > 0) {
      await deleteElements({
        nodes: obsolete.map(({ id: inputId }) => ({ id: inputId })),
        edges: staleEdges,
      });
    }
    setParam("task", task);

    const rolesToCreate = task === OMNI_TASKS["Image to video"]
      ? ["first_frame", ...(!original ? ["last_frame"] : [])]
      : task === OMNI_TASKS["Ingredients to video"]
        ? Array.from({ length: Math.max(3, Math.min(maximumReferences, existingIngredientRoles.length)) }, (_, index) => `ingredient_${index + 1}`)
        : [];
    const rolesAlreadyThere = new Set(existing.filter((candidate) => !obsoleteIds.has(candidate.id)).map(roleOf));
    const labels: Record<string, string> = {
      first_frame: "First frame",
      last_frame: "Last frame",
    };
    const additions = rolesToCreate.filter((role) => !rolesAlreadyThere.has(role)).map((role) => {
      const index = Number(role.split("_")[1]) || 1;
      const label = role.startsWith("ingredient_") ? `Ingredient ${index}` : labels[role];
      const targetHandle = role.startsWith("ingredient_") ? "reference_images" : role === "first_frame" ? "image" : "last_image";
      const inputId = `input/image-${crypto.randomUUID()}`;
      const position = getNode(id)?.position ?? { x: 400, y: 200 };
      return {
        node: {
          id: inputId,
          type: "workflow",
          position: { x: position.x - 360, y: position.y + (index - 2) * 150 },
          data: {
            type: "input/image",
            params: { url: "" },
            status: "idle",
            outputs: {},
            log: "",
            title: label,
            paramLabels: { url: `${label} image (upload or paste URL)` },
            omniAutoCreatedFor: id,
            omniRole: role,
          },
        },
        edge: {
          id: `${inputId}-${id}-${role}`,
          source: inputId,
          sourceHandle: "image",
          target: id,
          targetHandle,
        },
      };
    });
    if (additions.length > 0) {
      addNodes(additions.map(({ node }) => node));
      const edgesToAdd = additions.map(({ edge }) => edge);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const currentParams = (getNode(id)?.data as { params?: Record<string, unknown> } | undefined)?.params;
          if (currentParams?.task === task && currentParams?.model === requestedModel) addEdges(edgesToAdd);
        });
      });
    }
  };

  const addOmniImageInput = (role: string, label: string) => {
    const inputId = `input/image-${crypto.randomUUID()}`;
    const position = getNode(id)?.position ?? { x: 400, y: 200 };
    const node = {
      id: inputId,
      type: "workflow",
      position: { x: position.x - 360, y: position.y + getNodes().filter((candidate) =>
        (candidate.data as { omniAutoCreatedFor?: string }).omniAutoCreatedFor === id
      ).length * 120 },
      data: {
        type: "input/image",
        params: { url: "" },
        status: "idle",
        outputs: {},
        log: "",
        title: label,
        paramLabels: { url: `${label} image (upload or paste URL)` },
        omniAutoCreatedFor: id,
        omniRole: role,
      },
    };
    addNodes(node);
    const edge = {
      id: `${inputId}-${id}-${role}`,
      source: inputId,
      sourceHandle: "image",
      target: id,
      targetHandle: "reference_images",
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => addEdges(edge));
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
    if (isOmni && key === "task") {
      void syncOmniInputs(value);
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
    if (isOmni && key === "model") {
      const original = value === OMNI_MODELS["Gemini Omni Flash (original)"];
      const resolution = String(d.params.resolution);
      if (original && resolution !== "720p" && resolution !== "360p") setParam("resolution", "720p");
      if (original && d.params.task === OMNI_TASKS["Extend video"]) {
        void syncOmniInputs(OMNI_TASKS["Text to video"], value);
      } else {
        void syncOmniInputs(String(d.params.task), value);
      }
      return;
    }
    if (isOmni && key === "seed") {
      setParam(key, value === "" ? -1 : value);
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
      if (isOmniImage) {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
          throw new Error("Images must be PNG, JPEG, JPG, or WebP; HEIC is not supported.");
        }
        if (file.size > 20 * 1024 * 1024) throw new Error("Each image must be 20 MB or smaller.");
        const reader = new FileReader();
        const localImage = await new Promise<string>((resolve, reject) => {
          reader.onload = () => typeof reader.result === "string"
            ? resolve(reader.result)
            : reject(new Error("Unable to read image file."));
          reader.onerror = () => reject(new Error("Unable to read image file."));
          reader.readAsDataURL(file);
        });
        setParam(key, localImage);
        updateNodeData(id, { log: "" });
        return;
      }
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
  const connectedOmniInputs = new Set(renderedEdges
    .filter((edge) => edge.target === id)
    .map((edge) => edge.targetHandle));
  const omniReferenceEdges = renderedEdges.filter(
    (edge) => edge.target === id && edge.targetHandle === "reference_images"
  );
  const omniReferenceVideoEdges = renderedEdges.filter(
    (edge) => edge.target === id && /^reference_video_[1-3]$/.test(edge.targetHandle ?? "")
  );
  const omniTask = String(d.params?.task ?? OMNI_TASKS["Text to video"]);
  const omniOriginal = d.params?.model === OMNI_MODELS["Gemini Omni Flash (original)"];
  const omniMaxReferences = omniOriginal ? 5 : 10;
  const omniPromptEdge = renderedEdges.find((edge) => edge.target === id && edge.targetHandle === "prompt");
  const omniPromptNode = omniPromptEdge ? getNode(omniPromptEdge.source) : undefined;
  const omniPrompt = String((omniPromptNode?.data as { params?: { text?: unknown } } | undefined)?.params?.text ?? "");
  const omniSourceEdge = renderedEdges.find((edge) => edge.target === id && edge.targetHandle === "video");
  const omniVideoDuration = (nodeId: string, visited = new Set<string>()): number | null => {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const sourceNode = getNode(nodeId);
    if (!sourceNode) return null;
    const sourceData = sourceNode.data as {
      type?: string;
      params?: Record<string, unknown>;
      outputs?: Record<string, unknown>;
    };
    if (sourceData.type !== "video/google-omni") {
      const duration = Number(sourceData.outputs?.duration_seconds);
      return Number.isFinite(duration) && duration > 0 ? duration : null;
    }
    const sourceParams = sourceData.params ?? {};
    const sourceTask = String(sourceParams.task);
    if (sourceTask === OMNI_TASKS["Extend video"] || sourceTask === OMNI_TASKS["Edit video"]) {
      const priorVideo = renderedEdges.find((edge) => edge.target === nodeId && edge.targetHandle === "video");
      if (!priorVideo) return null;
      const priorDuration = omniVideoDuration(priorVideo.source, visited);
      if (priorDuration === null) return null;
      return sourceTask === OMNI_TASKS["Extend video"]
        ? priorDuration + Number(sourceParams.duration)
        : priorDuration;
    }
    const duration = Number(sourceParams.duration);
    return Number.isInteger(duration) && duration >= 3 && duration <= 10 ? duration : null;
  };
  const omniSourceDuration = omniSourceEdge ? omniVideoDuration(omniSourceEdge.source) : null;
  const omniChainTotal = omniTask === OMNI_TASKS["Extend video"] && omniSourceDuration !== null
    ? omniSourceDuration + Number(d.params.duration)
    : null;
  const omniCostDuration = Number(d.params?.duration ?? OMNI_DEFAULTS.duration);
  const omniVariations = Number(d.params?.variations ?? OMNI_DEFAULTS.variations);
  const omniRate = OMNI_RATES[String(d.params?.model)]?.[omniTask] ?? 0;
  const omniEstimatedCost = omniTask === OMNI_TASKS["Edit video"]
    ? "varies (follows source video)"
    : `~$${(omniCostDuration * omniRate * omniVariations).toFixed(3)}`;
  const showOmniInput = (name: string) => {
    if (name === "prompt") return true;
    if (omniTask === OMNI_TASKS["Image to video"]) {
      if (name === "image") return true;
      if (name === "last_image") return !omniOriginal;
      return false;
    }
    if (omniTask === OMNI_TASKS["Ingredients to video"]) {
      return name === "reference_images"
        || (!omniOriginal && /^reference_video_[1-3]$/.test(name));
    }
    if (omniTask === OMNI_TASKS["Edit video"] || omniTask === OMNI_TASKS["Extend video"]) {
      return name === "video" || name === "reference_images";
    }
    return false;
  };
  const omniUsedRoleIndices = (prefix: string) => getNodes()
    .filter((candidate) => {
      const meta = candidate.data as { omniAutoCreatedFor?: string; omniRole?: string };
      return meta.omniAutoCreatedFor === id && meta.omniRole?.startsWith(`${prefix}_`);
    })
    .map((candidate) => Number((candidate.data as { omniRole: string }).omniRole.split("_").at(-1)))
    .filter(Number.isInteger);
  const nextOmniRoleIndex = (prefix: string) => {
    const used = new Set(omniUsedRoleIndices(prefix));
    let index = 1;
    while (used.has(index)) index++;
    return index;
  };
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
    reference_video_1: "Reference video 1",
    reference_video_2: "Reference video 2",
    reference_video_3: "Reference video 3",
    video: "Source video",
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
          if (isOmni) return showOmniInput(name);
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
            {isOmni && name === "prompt" && (
              <>
                <div className="ff-node-hint">Refer to references as &lt;IMAGE_REF_0&gt;, &lt;IMAGE_REF_1&gt;, &lt;VIDEO_REF_0&gt; (0-based, in connection order).</div>
                <div className={`ff-omni-note${omniPrompt.length > 20000 ? " ff-omni-warning" : ""}`}>
                  Prompt maximum: 20,000 characters ({omniPrompt.length}/20,000).
                </div>
                {omniTask === OMNI_TASKS["Ingredients to video"] && (
                  <div className="ff-node-hint">Reference order follows the connected image/video inputs.</div>
                )}
              </>
            )}
            {isSeedance && name === "prompt" && d.params.task === "reference-to-video" && (
              <div className="ff-node-hint">
                Refer to references as @Image1, @Image2, @Video1, @Audio1
              </div>
            )}
          </Fragment>
        ))}

      {isOmni && omniTask === OMNI_TASKS["Ingredients to video"] && (
        <button
          type="button"
          className="ff-omni-add nodrag"
          disabled={omniReferenceEdges.length >= omniMaxReferences}
          title={omniReferenceEdges.length >= omniMaxReferences ? `Maximum ${omniMaxReferences} images` : undefined}
          onClick={() => {
            const index = nextOmniRoleIndex("ingredient");
            addOmniImageInput(`ingredient_${index}`, `Ingredient ${index}`);
          }}
        >
          Add ingredient ({omniReferenceEdges.length}/{omniMaxReferences})
        </button>
      )}
      {isOmni && [OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(omniTask as never) && (
        <button
          type="button"
          className="ff-omni-add nodrag"
          disabled={omniReferenceEdges.length >= omniMaxReferences}
          title={omniReferenceEdges.length >= omniMaxReferences ? `Maximum ${omniMaxReferences} images` : undefined}
          onClick={() => {
            const index = nextOmniRoleIndex("reference_image");
            addOmniImageInput(`reference_image_${index}`, `Reference image ${index}`);
          }}
        >
          Add reference image ({omniReferenceEdges.length}/{omniMaxReferences})
        </button>
      )}

      {isOmni && (
        <div className="ff-omni-note">Audio is always generated natively.</div>
      )}
      {isOmni && omniTask === OMNI_TASKS["Image to video"] && !connectedOmniInputs.has("image") && (
        <div className="ff-node-warning">Image to video requires a connected first frame.</div>
      )}
      {isOmni && omniTask === OMNI_TASKS["Ingredients to video"]
        && omniReferenceEdges.length === 0 && omniReferenceVideoEdges.length === 0 && (
        <div className="ff-node-warning">Ingredients to video requires at least one reference image or video.</div>
      )}
      {isOmni && [OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(omniTask as never)
        && !connectedOmniInputs.has("video") && (
        <div className="ff-node-warning">{omniTask === OMNI_TASKS["Edit video"] ? "Edit video" : "Extend video"} requires a source video.</div>
      )}
      {isOmni && omniTask === OMNI_TASKS["Ingredients to video"] && (
        <div className="ff-omni-note">Reference videos: up to 3, MP4 only, 3 seconds or shorter, and must be public URLs.</div>
      )}
      {isOmni && [
        OMNI_TASKS["Image to video"],
        OMNI_TASKS["Ingredients to video"],
        OMNI_TASKS["Edit video"],
        OMNI_TASKS["Extend video"],
      ].includes(omniTask as never) && (
        <div className="ff-omni-note">Images: PNG, JPEG, JPG or WebP only; 20 MB maximum each. HEIC is not supported.</div>
      )}
      {isOmni && (omniTask === OMNI_TASKS["Edit video"] || omniTask === OMNI_TASKS["Extend video"]) && (
        <>
          <div className="ff-omni-note">
            Source video: MP4, public URL. Extend sources must be 10 seconds or shorter; total chain must not exceed 40 seconds.
          </div>
          {omniTask === OMNI_TASKS["Extend video"] && (
            <div className="ff-omni-note">To go beyond 10 seconds, connect the output of one Extend or Omni node into another.</div>
          )}
          {omniTask === OMNI_TASKS["Extend video"] && omniChainTotal !== null && (
            <div className={`ff-omni-note${omniChainTotal > 40 ? " ff-omni-warning" : ""}`}>
              Chain total: {omniChainTotal} s of 40 s
            </div>
          )}
          {omniTask === OMNI_TASKS["Extend video"] && omniSourceDuration !== null && omniSourceDuration > 10 && (
            <div className="ff-node-warning">Extend video sources must be 10 seconds or shorter.</div>
          )}
        </>
      )}
      {isOmni && omniOriginal && (
        <div className="ff-omni-note">720p availability is unverified on Atlas for Gemini Omni Flash (original).</div>
      )}

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

      {def.params.filter((param) => {
        if (isSeedance && !showSeedanceParam(param)) return false;
        if (isOmni && param.key === "aspect_ratio"
          && [OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(omniTask as never)) return false;
        return true;
      }).map((p) => (
        <label className={`ff-param${p.kind === "toggle" ? " ff-param-toggle" : ""}`} key={p.key}>
          <span>{p.key === "duration" && isOmni && omniTask === OMNI_TASKS["Extend video"]
            ? "Extension length (seconds)"
            : d.paramLabels?.[p.key] ?? p.label}</span>
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
              const optionLabel = (option: string) => isOmni && omniOriginal && p.key === "resolution" && option === "720p"
                ? "720p (Atlas availability unverified)"
                : p.optionLabels?.[option] ?? option;
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
              onChange={(e) => setParam(p.key, isOmni && p.key === "seed" && e.target.value === ""
                ? -1
                : e.target.value)} />
          ) : p.kind === "file" ? (
            <>
              <input className="nodrag" type="text" placeholder="https://…" value={d.params[p.key] ?? ""}
                onChange={(e) => setParam(p.key, e.target.value)} />
              <input className="nodrag" type="file"
                accept={isOmniImage ? "image/png,image/jpeg,image/webp" : "image/*"}
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
      {isOmni && (
        <div className="ff-node-cost">
          Estimated cost: {omniEstimatedCost}
          {omniTask !== OMNI_TASKS["Edit video"] && ` (${omniCostDuration}s × $${omniRate.toFixed(3)}/s × ${omniVariations})`}
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
