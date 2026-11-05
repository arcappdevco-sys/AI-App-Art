"use client";
import { createContext, Fragment, useContext } from "react";
import { Handle, Position, useEdges, useReactFlow, type NodeProps } from "@xyflow/react";
import { fal } from "@fal-ai/client";
import { registry, PORT_COLORS } from "@/lib/registry";
import { SEEDANCE_MODELS, SEEDANCE_RATES } from "@/lib/seedance";
import { VEO_MODELS, VEO_RATES } from "@/lib/veo";
import { OMNI_DEFAULTS, OMNI_MODELS, OMNI_RATES, OMNI_TASKS } from "@/lib/omni";
import { KLING_DEFAULTS, KLING_MODELS, KLING_RATES, KLING_TASKS } from "@/lib/kling";

export const WorkflowRunContext = createContext<{
  runNode: (nodeId: string) => void;
  isRunning: boolean;
} | null>(null);

function Media({ value }: { value: unknown }) {
  if (typeof value !== "string" || !value) return null;
  const isVideo = /\.(mp4|webm|mov)(\?|$)/i.test(value);
  const isImage = /^data:image\//.test(value) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(value);
  if (!isVideo && !isImage) return null;

  return (
    <>
      {isVideo ? (
        <video className="ff-media nodrag" src={value} controls loop muted />
      ) : (
        <img className="ff-media" src={value} alt="" />
      )}
      <div className="ff-media-actions">
        <a className="ff-download" href={value} target="_blank" rel="noreferrer">Download</a>
      </div>
    </>
  );
}

export default function WorkflowNode({ id, data }: NodeProps) {
  const { addEdges, addNodes, deleteElements, getEdges, getNode, getNodes, updateNodeData } = useReactFlow();
  const runControl = useContext(WorkflowRunContext);
  const renderedEdges = useEdges();
  const d = data as any;
  const def = registry[d.type];
  const isSeedance = d.type === "video/seedance";
  const seedanceAtlasTask = isSeedance
    && d.params.model === SEEDANCE_MODELS["Seedance 2.5"]
    && ["text-to-video", "image-to-video"].includes(String(d.params.task));
  const seedanceImageToVideo = seedanceAtlasTask && d.params.task === "image-to-video";
  const isVeo = d.type === "video/veo";
  const isOmni = d.type === "video/google-omni";
  const isKling = d.type === "video/kling";
  const isSeedanceImage = d.type === "input/image" && renderedEdges.some((edge) =>
    edge.source === id
    && (getNode(edge.target)?.data as { type?: string } | undefined)?.type === "video/seedance"
  );
  const isOmniImage = d.type === "input/image" && (
    d.omniAutoCreatedFor
    || renderedEdges.some((edge) => edge.source === id
      && (getNode(edge.target)?.data as { type?: string } | undefined)?.type === "video/google-omni")
  );
  const isKlingImage = d.type === "input/image" && (
    d.klingAutoCreatedFor
    || renderedEdges.some((edge) => edge.source === id
      && (getNode(edge.target)?.data as { type?: string } | undefined)?.type === "video/kling")
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

  const syncKlingInputs = async (requestedTask: string, requestedModel = String(d.params.model)) => {
    const isV3 = requestedModel !== KLING_MODELS["Kling 4.0"];
    const allowedTasks = isV3
      ? [KLING_TASKS["Text to video"], KLING_TASKS["Image to video"]]
      : Object.values(KLING_TASKS);
    const task = (allowedTasks as string[]).includes(requestedTask) ? requestedTask : KLING_TASKS["Text to video"];
    const currentNodes = getNodes();
    const existing = currentNodes.filter((candidate) =>
      (candidate.data as { klingAutoCreatedFor?: string }).klingAutoCreatedFor === id
    );
    const roleOf = (candidate: typeof existing[number]) =>
      (candidate.data as { klingRole?: string }).klingRole ?? "";
    const existingMiddle = existing.map(roleOf)
      .filter((role) => /^middle_\d+$/.test(role))
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
    const existingIngredients = existing.map(roleOf)
      .filter((role) => /^ingredient_\d+$/.test(role))
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
    const existingReferences = existing.map(roleOf)
      .filter((role) => /^reference_image_\d+$/.test(role))
      .sort((a, b) => Number(a.split("_")[2]) - Number(b.split("_")[2]));
    const wantedRoles = new Set<string>();
    if (task === KLING_TASKS["Image to video"]) {
      wantedRoles.add("first_frame");
      wantedRoles.add("last_frame");
      if (!isV3) existingMiddle.forEach((role) => wantedRoles.add(role));
    } else if (task === KLING_TASKS["Ingredients to video"]) {
      for (let index = 1; index <= Math.max(3, Math.min(10, existingIngredients.length)); index++) {
        wantedRoles.add(`ingredient_${index}`);
      }
      for (const role of existingMiddle) wantedRoles.add(role);
      if (existing.some((candidate) => roleOf(candidate) === "first_frame")) wantedRoles.add("first_frame");
      if (existing.some((candidate) => roleOf(candidate) === "last_frame")) wantedRoles.add("last_frame");
    } else if (task === KLING_TASKS["Edit video"]) {
      existingReferences.slice(0, 10).forEach((role) => wantedRoles.add(role));
    }

    const handleFor = (role: string) => {
      if (role === "first_frame") return "image";
      if (role === "last_frame") return isV3 ? "end_image" : "last_image";
      if (/^middle_\d+$/.test(role)) return "middle_images";
      if (/^ingredient_\d+$/.test(role) || /^reference_image_\d+$/.test(role)) return "reference_images";
      return "";
    };
    const validHandles = new Set<string>(["prompt"]);
    if (task === KLING_TASKS["Image to video"]) {
      validHandles.add("image");
      validHandles.add(isV3 ? "end_image" : "last_image");
      if (!isV3 && existingMiddle.length) validHandles.add("middle_images");
    } else if (task === KLING_TASKS["Ingredients to video"]) {
      validHandles.add("reference_images");
      validHandles.add("middle_images");
      validHandles.add("image");
      validHandles.add("last_image");
      for (let index = 1; index <= 5; index++) validHandles.add(`reference_video_${index}`);
    } else if (task === KLING_TASKS["Edit video"]) {
      validHandles.add("video");
      validHandles.add("reference_images");
      for (let index = 1; index <= 4; index++) validHandles.add(`reference_video_${index}`);
    }
    const obsolete = existing.filter((candidate) => !wantedRoles.has(roleOf(candidate)));
    const obsoleteIds = new Set(obsolete.map(({ id: inputId }) => inputId));
    const staleEdges = getEdges().filter((edge) =>
      (edge.target === id && !validHandles.has(edge.targetHandle ?? "")) || obsoleteIds.has(edge.source)
    );
    if (obsolete.length || staleEdges.length) {
      await deleteElements({
        nodes: obsolete.map(({ id: inputId }) => ({ id: inputId })),
        edges: staleEdges,
      });
    }
    if (String(d.params.model) !== requestedModel) setParam("model", requestedModel);
    setParam("task", task);
    if (task !== KLING_TASKS["Ingredients to video"] && task !== KLING_TASKS["Edit video"]) {
      setParam("elements", []);
      setParam("voice_ids", []);
    }
    if (task === KLING_TASKS["Ingredients to video"]) {
      setParam("aspect_ratio", d.params.aspect_ratio === "Auto" ? "Auto" : "Auto");
    }
    const defaultRoles = task === KLING_TASKS["Image to video"]
      ? ["first_frame", "last_frame"]
      : task === KLING_TASKS["Ingredients to video"]
        ? Array.from({ length: 3 }, (_, index) => `ingredient_${index + 1}`)
        : [];
    const desiredRoles = [...new Set([...defaultRoles, ...wantedRoles])];
    const present = new Set(existing
      .filter((candidate) => !obsoleteIds.has(candidate.id))
      .map(roleOf));
    const labels: Record<string, string> = {
      first_frame: "First frame",
      last_frame: "Last frame",
    };
    const position = getNode(id)?.position ?? { x: 400, y: 200 };
    const additions = desiredRoles.filter((role) => !present.has(role)).map((role) => {
      const index = Number(role.split("_").at(-1)) || 1;
      const label = role.startsWith("middle_") ? `Middle keyframe ${index}`
        : role.startsWith("ingredient_") ? `Ingredient ${index}`
          : role.startsWith("reference_image_") ? `Reference image ${index}`
            : labels[role];
      const targetHandle = handleFor(role) || (role === "last_frame" && isV3 ? "end_image" : "");
      const inputId = `input/image-${crypto.randomUUID()}`;
      return {
        node: {
          id: inputId,
          type: "workflow",
          position: { x: position.x - 360, y: position.y + (index - 2) * 145 },
          data: {
            type: "input/image",
            params: { url: "" },
            status: "idle",
            outputs: {},
            log: "",
            title: label,
            paramLabels: { url: `${label} image (upload or paste URL)` },
            klingAutoCreatedFor: id,
            klingRole: role,
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
    const retainedEdges = getEdges().filter((edge) =>
      edge.target === id && edge.source && !obsoleteIds.has(edge.source)
    );
    const rewired: typeof retainedEdges = [];
    for (const candidate of existing.filter((node) => wantedRoles.has(roleOf(node)))) {
      const role = roleOf(candidate);
      const desiredHandle = handleFor(role);
      if (!desiredHandle) continue;
      const old = retainedEdges.find((edge) => edge.source === candidate.id);
      if (old && old.targetHandle !== desiredHandle) {
        rewired.push({
          ...old,
          id: `${old.source}-${id}-${role}-${desiredHandle}`,
          targetHandle: desiredHandle,
        });
      } else if (!old) {
        rewired.push({
          id: `${candidate.id}-${id}-${role}`,
          source: candidate.id,
          sourceHandle: "image",
          target: id,
          targetHandle: desiredHandle,
        });
      }
    }
    if (rewired.length) {
      const remove = getEdges().filter((edge) => rewired.some((replacement) =>
        replacement.source === edge.source && replacement.target === edge.target
          && replacement.id !== edge.id
      ));
      if (remove.length) await deleteElements({ edges: remove });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const currentParams = (getNode(id)?.data as { params?: Record<string, unknown> } | undefined)?.params;
          if (currentParams?.task === task && currentParams?.model === requestedModel) addEdges(rewired);
        });
      });
    }
    if (!additions.length) return;
    addNodes(additions.map(({ node }) => node));
    const edgesToAdd = additions.map(({ edge }) => edge);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const current = (getNode(id)?.data as { params?: Record<string, unknown> } | undefined)?.params;
        if (current?.task === task && current?.model === requestedModel) addEdges(edgesToAdd);
      });
    });
  };

  const addKlingImageInput = (role: string, label: string, targetHandle: string) => {
    const klingImageHandles = ["image", "middle_images", "last_image", "end_image", "reference_images"];
    const currentEdges = getEdges().filter((edge) => edge.target === id);
    const ownedImageNodes = getNodes().filter((candidate) => {
      const meta = candidate.data as { klingAutoCreatedFor?: string; klingRole?: string };
      return meta.klingAutoCreatedFor === id
        && Boolean(meta.klingRole && /^(first_frame|last_frame|middle_\d+|ingredient_\d+|reference_image_\d+)$/.test(meta.klingRole));
    });
    const ownedIds = new Set(ownedImageNodes.map((candidate) => candidate.id));
    const manualImageEdges = currentEdges.filter((edge) =>
      klingImageHandles.includes(edge.targetHandle ?? "") && !ownedIds.has(edge.source)
    );
    if (ownedImageNodes.length + manualImageEdges.length >= 10) return;
    if (role.startsWith("middle_")
      && ownedImageNodes.filter((candidate) => (candidate.data as { klingRole?: string }).klingRole?.startsWith("middle_")).length >= 8) return;
    if (ownedImageNodes.some((candidate) => (candidate.data as { klingRole?: string }).klingRole === role)) return;
    if ((role === "first_frame" && currentEdges.some((edge) => edge.targetHandle === "image"))
      || (role === "last_frame" && currentEdges.some((edge) => ["last_image", "end_image"].includes(edge.targetHandle ?? "")))) return;
    const inputId = `input/image-${crypto.randomUUID()}`;
    const position = getNode(id)?.position ?? { x: 400, y: 200 };
    const ownedCount = getNodes().filter((candidate) =>
      (candidate.data as { klingAutoCreatedFor?: string }).klingAutoCreatedFor === id
    ).length;
    const node = {
      id: inputId,
      type: "workflow",
      position: { x: position.x - 360, y: position.y + (ownedCount - 1) * 130 },
      data: {
        type: "input/image",
        params: { url: "" },
        status: "idle",
        outputs: {},
        log: "",
        title: label,
        paramLabels: { url: `${label} image (upload or paste URL)` },
        klingAutoCreatedFor: id,
        klingRole: role,
      },
    };
    addNodes(node);
    const edge = {
      id: `${inputId}-${id}-${role}`,
      source: inputId,
      sourceHandle: "image",
      target: id,
      targetHandle,
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => addEdges(edge)));
  };

  const setKlingSubject = (index: number, patch: Record<string, unknown>) => {
    const current = Array.isArray(d.params.elements) ? [...d.params.elements] : [];
    current[index] = { ...(current[index] as Record<string, unknown>), ...patch };
    setParam("elements", current);
  };

  const setKlingSubjectImage = async (
    index: number,
    field: "frontal_image" | "reference_video" | "extra_images",
    file?: File,
    extraIndex = 0
  ) => {
    if (!file) return;
    try {
      const isVideo = field === "reference_video";
      const allowedTypes = isVideo ? ["video/mp4", "video/quicktime"] : ["image/jpeg", "image/png"];
      const maximumBytes = isVideo ? 300 * 1024 * 1024 : 30 * 1024 * 1024;
      if (!allowedTypes.includes(file.type)) throw new Error(isVideo ? "Subject video must be MP4 or MOV." : "Subject images must be JPG, JPEG, or PNG.");
      if (file.size > maximumBytes) throw new Error(isVideo ? "Videos must be 300 MB or smaller." : "Images must be 30 MB or smaller.");
      if (!isVideo) {
        const bitmap = await createImageBitmap(file);
        const ratio = bitmap.width / bitmap.height;
        if (bitmap.width < 300 || bitmap.height < 300 || ratio < 0.4 || ratio > 2.5) {
          bitmap.close();
          throw new Error("Images must be at least 300 px on each side with a 2:5 to 5:2 aspect ratio.");
        }
        bitmap.close();
      }
      const localValue = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unable to read media file."));
        reader.onerror = () => reject(new Error("Unable to read media file."));
        reader.readAsDataURL(file);
      });
      if (field === "extra_images") {
        const subject = d.params.elements[index] as Record<string, unknown>;
        const extra = Array.isArray(subject.extra_images) ? [...subject.extra_images] : [];
        extra[extraIndex] = localValue;
        setKlingSubject(index, { extra_images: extra });
      } else {
        setKlingSubject(index, { [field]: localValue });
      }
      updateNodeData(id, { log: "" });
    } catch (error) {
      updateNodeData(id, { status: "error", log: error instanceof Error ? error.message : String(error) });
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
      if (value === "image-to-video" && !["480p", "720p", "1080p"].includes(String(d.params.resolution))) {
        setParam("resolution", "720p");
      }
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
    if (isKling && key === "task") {
      if (value === KLING_TASKS["Ingredients to video"]) setParam("aspect_ratio", "Auto");
      else if (d.params.aspect_ratio === "Auto" || d.params.aspect_ratio === "21:9" && String(d.params.model) !== KLING_MODELS["Kling 4.0"]) {
        setParam("aspect_ratio", "16:9");
      }
      void syncKlingInputs(value);
      return;
    }
    if (isKling && key === "model") {
      const currentTask = String(d.params.task);
      const nextIsV3 = value !== KLING_MODELS["Kling 4.0"];
      const task = nextIsV3 && ![KLING_TASKS["Text to video"], KLING_TASKS["Image to video"]].includes(currentTask as never)
        ? KLING_TASKS["Text to video"]
        : currentTask;
      const currentDuration = String(d.params.duration);
      if (nextIsV3 && (Number(currentDuration) < 3 || Number(currentDuration) > 15)) setParam("duration", "5");
      setParam("resolution", "1080p");
      setParam("sound", false);
      if (nextIsV3 && (String(d.params.aspect_ratio) === "21:9" || String(d.params.aspect_ratio) === "Auto")) {
        setParam("aspect_ratio", "16:9");
      }
      if (task === KLING_TASKS["Ingredients to video"]) setParam("aspect_ratio", "Auto");
      void syncKlingInputs(task, value);
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
      if (isKlingImage) {
        if (!["image/jpeg", "image/png"].includes(file.type)) {
          throw new Error("Images must be JPG, JPEG, or PNG.");
        }
        if (file.size > 30 * 1024 * 1024) throw new Error("Images must be 30 MB or smaller.");
        const bitmap = await createImageBitmap(file);
        const ratio = bitmap.width / bitmap.height;
        if (bitmap.width < 300 || bitmap.height < 300 || ratio < 0.4 || ratio > 2.5) {
          bitmap.close();
          throw new Error("Images must be at least 300 px on each side with a 2:5 to 5:2 aspect ratio.");
        }
        bitmap.close();
        const localImage = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
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
      if (isSeedanceImage) {
        const formData = new FormData();
        formData.append("file", file);
        const response = await fetch("/api/atlas/upload", { method: "POST", body: formData });
        const result = await response.json() as { url?: unknown; error?: unknown };
        if (!response.ok || typeof result.url !== "string") {
          throw new Error(typeof result.error === "string" ? result.error : "Atlas Cloud image upload failed.");
        }
        setParam(key, result.url);
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
  const klingTask = String(d.params?.task ?? KLING_TASKS["Text to video"]);
  const klingModel = String(d.params?.model ?? KLING_MODELS["Kling 4.0"]);
  const klingIsV3 = klingModel !== KLING_MODELS["Kling 4.0"];
  const klingIsImageTask = klingTask === KLING_TASKS["Image to video"];
  const klingIsIngredients = klingTask === KLING_TASKS["Ingredients to video"];
  const klingIsEdit = klingTask === KLING_TASKS["Edit video"];
  const klingIncoming = renderedEdges.filter((edge) => edge.target === id);
  const klingConnectedHandles = new Set(klingIncoming.map((edge) => edge.targetHandle));
  const klingKeyframeEdges = klingIncoming.filter((edge) =>
    ["image", "middle_images", "last_image", "end_image"].includes(edge.targetHandle ?? "")
  );
  const klingReferenceImageEdges = klingIncoming.filter((edge) => edge.targetHandle === "reference_images");
  const klingReferenceVideoEdges = klingIncoming.filter((edge) => /^reference_video_[1-5]$/.test(edge.targetHandle ?? ""));
  const klingSourceVideoEdge = klingIncoming.find((edge) => edge.targetHandle === "video");
  const klingPromptEdge = klingIncoming.find((edge) => edge.targetHandle === "prompt");
  const klingPromptNode = klingPromptEdge ? getNode(klingPromptEdge.source) : undefined;
  const klingPrompt = String((klingPromptNode?.data as { params?: { text?: unknown } } | undefined)?.params?.text ?? "");
  const klingSubjects = Array.isArray(d.params?.elements) ? d.params.elements as Record<string, unknown>[] : [];
  const klingVoiceIds = Array.isArray(d.params?.voice_ids) ? d.params.voice_ids as string[] : [];
  const klingInputCount = klingKeyframeEdges.length + klingReferenceImageEdges.length
    + klingReferenceVideoEdges.length + Number(Boolean(klingSourceVideoEdge))
    + klingSubjects.length + klingVoiceIds.filter(Boolean).length
    + klingSubjects.reduce((count, subject) => count
      + (subject.kind === "new" && subject.type === "video"
        ? Number(Boolean(subject.reference_video))
        : subject.kind === "new" && subject.type === "image"
          ? Number(Boolean(subject.frontal_image)) + (Array.isArray(subject.extra_images)
            ? subject.extra_images.filter(Boolean).length
            : 0)
          : 0), 0);
  const klingDuration = Number(d.params?.duration ?? KLING_DEFAULTS.duration);
  const klingRate = KLING_RATES[klingModel] ?? 0;
  const klingCost = `~$${(klingDuration * klingRate).toFixed(3)} (${klingDuration}s × $${klingRate.toFixed(3)}/s)`;
  const klingOwnedNodes = getNodes().filter((candidate) =>
    (candidate.data as { klingAutoCreatedFor?: string }).klingAutoCreatedFor === id
  );
  const klingRoleIndices = (prefix: string) => klingOwnedNodes
    .map((candidate) => (candidate.data as { klingRole?: string }).klingRole ?? "")
    .filter((role) => new RegExp(`^${prefix}_\\d+$`).test(role))
    .map((role) => Number(role.split("_").at(-1)));
  const klingNextRole = (prefix: string) => {
    return Math.max(0, ...klingRoleIndices(prefix)) + 1;
  };
  const klingImageTotal = klingKeyframeEdges.length + klingReferenceImageEdges.length;
  const klingInputVisible = (name: string) => {
    if (name === "prompt") return true;
    if (klingIsImageTask) {
      if (name === "image" || name === "middle_images" && !klingIsV3) return true;
      return klingIsV3 ? name === "end_image" : name === "last_image";
    }
    if (klingIsIngredients) {
      return ["image", "middle_images", "last_image", "reference_images"].includes(name)
        || /^reference_video_[1-5]$/.test(name);
    }
    if (klingIsEdit) return name === "video" || name === "reference_images"
      || /^reference_video_[1-4]$/.test(name);
    return false;
  };
  const klingAspectOptions = klingIsV3
    ? ["16:9", "9:16", "1:1"]
    : klingIsIngredients
      ? ["Auto", "16:9", "9:16", "1:1", "21:9"]
      : ["16:9", "9:16", "1:1", "21:9"];
  const klingAspectVisible = klingTask === KLING_TASKS["Text to video"] || klingIsIngredients;
  const klingVideoCount = klingReferenceVideoEdges.length + Number(Boolean(klingSourceVideoEdge));
  const klingSubjectVideoCount = klingSubjects.filter((subject) => subject.kind === "new" && subject.type === "video").length;
  const updateKlingSubjectCount = (value: string) => {
    const next = klingSubjects.slice();
    if (value) next.push({
      kind: "new",
      name: "",
      description: "",
      type: "image",
      frontal_image: "",
      extra_images: [""],
      reference_video: "",
    });
    setParam("elements", next);
  };
  const updateKlingVoiceCount = (value: string) => {
    const next = klingVoiceIds.slice();
    if (value) next.push("");
    setParam("voice_ids", next);
  };
  const klingReferenceTagHint = klingIsImageTask
    ? "@image_1 (first frame), @image_2 ... (middle, then last)"
    : klingIsIngredients
      ? "@image_N, @video_N, @element_N, @voice_N"
      : klingIsEdit
        ? "The video to edit is @video_1; other inputs are @image_N, @video_2 onward, @element_N, @voice_N"
        : "";

  return (
    <div className="ff-node" data-status={d.status}>
      <div className="ff-head">
        <span className="ff-node-label">{d.title ?? def.label}</span>
        {d.status && d.status !== "idle" && (
          <span className="ff-node-status" aria-live="polite">
            {d.status === "running" ? "Running" : d.status === "queued" ? "Queued" : d.status === "done" ? "Done" : d.status === "error" ? "Error" : ""}
          </span>
        )}
        <i className="ff-dot" />
        {def.category !== "Input" && runControl && (
          <button
            className="ff-node-run"
            type="button"
            aria-label={`Run ${d.title ?? def.label}`}
            title="Run this node and the nodes connected upstream"
            disabled={runControl.isRunning}
            onClick={(event) => {
              event.stopPropagation();
              runControl.runNode(id);
            }}
          >
            Run
          </button>
        )}
      </div>
      {def.integration === "pending" && (
        <div className="ff-node-notice">API setup required before this model can run.</div>
      )}
      {isSeedance && (
        <div className={`ff-node-notice${seedanceAtlasTask ? "" : " ff-access-pending"}`}>
          {seedanceAtlasTask
            ? `Atlas Cloud API connected: Seedance 2.5 ${d.params.task === "text-to-video" ? "Text" : "Image"} to video.`
            : "Atlas Cloud API is connected for Seedance 2.5 Text to video and Image to video only."}
        </div>
      )}
      {seedanceImageToVideo && (
        <div className="ff-node-hint">
          Connect any image output directly to First frame or Last frame; Run executes upstream nodes first.
          Output aspect ratio follows the first-frame image on Atlas Cloud.
        </div>
      )}

      {Object.entries(def.inputs)
        .filter(([name]) => {
          if (isOmni) return showOmniInput(name);
          if (isKling) return klingInputVisible(name);
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
              {isKling
                ? name === "middle_images" ? "Middle keyframes"
                  : name === "end_image" ? "Last frame"
                    : /^reference_video_/.test(name) ? `Reference video ${name.split("_").at(-1)}`
                      : inputLabels[name] ?? name
                : inputLabels[name] ?? name}
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
            {isKling && name === "prompt" && (
              <>
                {klingReferenceTagHint && <div className="ff-node-hint">{klingReferenceTagHint}</div>}
                <div className={`ff-kling-note${klingPrompt.length > (/[^\u0000-\u007f]/.test(klingPrompt) ? 11000 : 26000) ? " ff-kling-warning" : ""}`}>
                  Prompt maximum: 26,000 characters (11,000 for non-English text). Image-to-video prompts are optional.
                  {klingIsIngredients && <div>If your prompt mentions none of the references, all of them are used automatically.</div>}
                  {!klingIsImageTask && <div>You can describe what to avoid in the prompt.</div>}
                </div>
              </>
            )}
            {isSeedance && name === "prompt" && d.params.task === "reference-to-video" && (
              <div className="ff-node-hint">
                Refer to references as @Image1, @Image2, @Video1, @Audio1
              </div>
            )}
          </Fragment>
        ))}

      {isKling && klingIsImageTask && !klingConnectedHandles.has("image") && (
        <div className="ff-node-warning">Image to video requires a connected first frame.</div>
      )}
      {isKling && klingIsEdit && !klingConnectedHandles.has("video") && (
        <div className="ff-node-warning">Edit video requires a connected source video.</div>
      )}
      {isKling && klingIsIngredients && klingReferenceImageEdges.length === 0
        && klingReferenceVideoEdges.length === 0 && klingSubjects.length === 0 && (
        <div className="ff-node-warning">Ingredients to video requires at least one reference image, reference video, or subject.</div>
      )}
      {isKling && klingTask !== KLING_TASKS["Text to video"] && (
        <div className="ff-kling-note">Keyframe images: JPG, JPEG, or PNG; 30 MB maximum; at least 300 px per side; aspect ratio 2:5 to 5:2.</div>
      )}
      {isKling && (klingIsIngredients || klingIsEdit) && (
        <div className="ff-kling-note">Reference and source videos: MP4 or MOV, 300 MB maximum, 3 to 30 seconds; references must total 3 to 30 seconds; 700 to 4553 px. Input video seconds are billed.</div>
      )}

      {isKling && (klingIsIngredients || klingIsEdit) && (
        <section className="ff-kling-editor">
          <div className="ff-kling-editor-heading">
            <strong>Subjects (elements)</strong>
            <button type="button" className="ff-kling-small-button nodrag" disabled={klingSubjects.length >= 7}
              onClick={() => updateKlingSubjectCount("new")}>
              Add subject ({klingSubjects.length}/7)
            </button>
          </div>
          {klingSubjects.map((subject, index) => {
            const existing = subject.kind === "existing";
            const videoCharacter = subject.kind === "new" && subject.type === "video";
            return (
              <div className="ff-kling-subject" key={`subject-${index}`}>
                <div className="ff-kling-editor-heading">
                  <strong>Subject {index + 1}</strong>
                  <button type="button" className="ff-kling-remove nodrag"
                    onClick={() => setParam("elements", klingSubjects.filter((_, subjectIndex) => subjectIndex !== index))}>
                    Remove
                  </button>
                </div>
                <label className="ff-kling-field">
                  <span>Subject source</span>
                  <select className="nodrag" value={existing ? "existing" : "new"}
                    onChange={(event) => setKlingSubject(index, event.target.value === "existing"
                      ? { kind: "existing", id: "", name: "" }
                      : { kind: "new", name: "", description: "", type: "image", frontal_image: "", extra_images: [""] })}>
                    <option value="existing">Existing subject ID</option>
                    <option value="new">New subject</option>
                  </select>
                </label>
                {existing ? (
                  <label className="ff-kling-field">
                    <span>Existing subject ID (64-bit integer)</span>
                    <input className="nodrag" type="text" inputMode="numeric" value={String(subject.id ?? "")}
                      onChange={(event) => setKlingSubject(index, { id: event.target.value, name: "" })} />
                  </label>
                ) : (
                  <>
                    <label className="ff-kling-field">
                      <span>Name (max 20 characters)</span>
                      <input className="nodrag" maxLength={20} value={String(subject.name ?? "")}
                        onChange={(event) => setKlingSubject(index, { name: event.target.value })} />
                    </label>
                    <label className="ff-kling-field">
                      <span>Description (max 100 characters)</span>
                      <textarea className="nodrag nowheel" rows={2} maxLength={100} value={String(subject.description ?? "")}
                        onChange={(event) => setKlingSubject(index, { description: event.target.value })} />
                    </label>
                    <label className="ff-kling-field">
                      <span>Subject type</span>
                      <select className="nodrag" value={String(subject.type ?? "image")}
                        onChange={(event) => setKlingSubject(index, event.target.value === "video"
                          ? { type: "video", reference_video: "" }
                          : { type: "image", frontal_image: "", extra_images: [""] })}>
                        <option value="image">Image-based</option>
                        <option value="video" disabled={klingSubjectVideoCount >= 3 && !videoCharacter}>Video character</option>
                      </select>
                    </label>
                    {videoCharacter ? (
                      <>
                        <label className="ff-kling-field">
                          <span>Reference video (3 to 8 seconds)</span>
                          <input className="nodrag" type="text" placeholder="Public MP4 or MOV URL"
                            value={String(subject.reference_video ?? "")}
                            onChange={(event) => setKlingSubject(index, { reference_video: event.target.value })} />
                          <input className="nodrag" type="file" accept="video/mp4,video/quicktime"
                            onChange={(event) => void setKlingSubjectImage(index, "reference_video", event.target.files?.[0])} />
                        </label>
                        <div className="ff-kling-note">Video characters are for realistic humans only.</div>
                      </>
                    ) : (
                      <>
                        <label className="ff-kling-field">
                          <span>Frontal image (required)</span>
                          <input className="nodrag" type="text" placeholder="Public JPG or PNG URL"
                            value={String(subject.frontal_image ?? "")}
                            onChange={(event) => setKlingSubject(index, { frontal_image: event.target.value })} />
                          <input className="nodrag" type="file" accept="image/jpeg,image/png"
                            onChange={(event) => void setKlingSubjectImage(index, "frontal_image", event.target.files?.[0])} />
                        </label>
                        {(Array.isArray(subject.extra_images) ? subject.extra_images : [""]).map((image, imageIndex) => (
                          <label className="ff-kling-field" key={`subject-${index}-image-${imageIndex}`}>
                            <span>Extra image {imageIndex + 1}</span>
                            <input className="nodrag" type="text" placeholder="Public JPG or PNG URL" value={String(image ?? "")}
                              onChange={(event) => {
                                const extra = Array.isArray(subject.extra_images) ? [...subject.extra_images] : [""];
                                extra[imageIndex] = event.target.value;
                                setKlingSubject(index, { extra_images: extra });
                              }} />
                            <input className="nodrag" type="file" accept="image/jpeg,image/png"
                              onChange={(event) => void setKlingSubjectImage(index, "extra_images", event.target.files?.[0], imageIndex)} />
                          </label>
                        ))}
                        <button type="button" className="ff-kling-small-button nodrag"
                          disabled={(Array.isArray(subject.extra_images) ? subject.extra_images.length : 0) >= 3}
                          onClick={() => setKlingSubject(index, {
                            extra_images: [...(Array.isArray(subject.extra_images) ? subject.extra_images : []), ""],
                          })}>
                          Add extra image
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}
      {isKling && (klingIsIngredients || klingIsEdit) && (
        <section className="ff-kling-editor">
          <div className="ff-kling-editor-heading">
            <strong>Voice IDs</strong>
            <button type="button" className="ff-kling-small-button nodrag" disabled={klingVoiceIds.length >= 3}
              onClick={() => updateKlingVoiceCount("new")}>
              Add Voice ID ({klingVoiceIds.length}/3)
            </button>
          </div>
          {klingVoiceIds.map((voice, index) => (
            <label className="ff-kling-field" key={`voice-${index}`}>
              <span>Voice ID {index + 1}</span>
              <div className="ff-kling-inline">
                <input className="nodrag" type="text" value={voice}
                  onChange={(event) => setParam("voice_ids", klingVoiceIds.map((value, voiceIndex) =>
                    voiceIndex === index ? event.target.value : value
                  ))} />
                <button type="button" className="ff-kling-remove nodrag"
                  onClick={() => setParam("voice_ids", klingVoiceIds.filter((_, voiceIndex) => voiceIndex !== index))}>
                  Remove
                </button>
              </div>
            </label>
          ))}
        </section>
      )}
      {isKling && (klingIsIngredients || klingIsEdit) && (
        <div className={`ff-kling-note${klingInputCount > 15 ? " ff-kling-warning" : ""}`}>Inputs: {klingInputCount} / 15</div>
      )}

      {isKling && klingIsIngredients && (
        <div className="ff-kling-button-list">
          <button type="button" className="ff-kling-add nodrag" disabled={klingImageTotal >= 10}
            onClick={() => {
              const index = klingNextRole("ingredient");
              addKlingImageInput(`ingredient_${index}`, `Ingredient ${index}`, "reference_images");
            }}>
            Add ingredient ({klingReferenceImageEdges.length}/10)
          </button>
          <button type="button" className="ff-kling-add nodrag"
            disabled={klingImageTotal >= 10 || klingConnectedHandles.has("image") || klingOwnedNodes.some((candidate) => (candidate.data as { klingRole?: string }).klingRole === "first_frame")}
            onClick={() => addKlingImageInput("first_frame", "First frame", "image")}>
            Add first frame
          </button>
          <button type="button" className="ff-kling-add nodrag"
            disabled={klingImageTotal >= 10 || klingRoleIndices("middle").length >= 8}
            onClick={() => {
              const index = klingNextRole("middle");
              addKlingImageInput(`middle_${index}`, `Middle keyframe ${index}`, "middle_images");
            }}>
            Add middle keyframe
          </button>
          <button type="button" className="ff-kling-add nodrag"
            disabled={klingImageTotal >= 10 || klingConnectedHandles.has("last_image") || klingOwnedNodes.some((candidate) => (candidate.data as { klingRole?: string }).klingRole === "last_frame")}
            onClick={() => addKlingImageInput("last_frame", "Last frame", "last_image")}>
            Add last frame
          </button>
        </div>
      )}
      {isKling && klingIsImageTask && !klingIsV3 && (
        <div className="ff-kling-button-list">
          <button type="button" className="ff-kling-add nodrag"
            disabled={klingImageTotal >= 10 || klingRoleIndices("middle").length >= 8}
            onClick={() => {
              const index = klingNextRole("middle");
              addKlingImageInput(`middle_${index}`, `Middle keyframe ${index}`, "middle_images");
            }}>
            Add middle keyframe ({klingRoleIndices("middle").length}/8)
          </button>
        </div>
      )}
      {isKling && klingIsEdit && (
        <button type="button" className="ff-kling-add nodrag" disabled={klingReferenceImageEdges.length >= 10}
          onClick={() => {
            const index = klingNextRole("reference_image");
            addKlingImageInput(`reference_image_${index}`, `Reference image ${index}`, "reference_images");
          }}>
          Add reference image ({klingReferenceImageEdges.length}/10)
        </button>
      )}
      {isKling && !klingIsV3 && <div className="ff-kling-note">Audio is generated natively. There is no audio control.</div>}
      {isKling && klingIsV3 && <div className="ff-kling-note">Resolution is fixed by the selected V3.0 tier.</div>}
      {isKling && klingIsV3 && klingIsImageTask && (
        <div className="ff-kling-note">The last frame is passed as end_image for V3.0.</div>
      )}

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
        if (seedanceImageToVideo && param.key === "ratio") return false;
        if (seedanceImageToVideo && param.key === "bitrate_mode") return false;
        if (isOmni && param.key === "aspect_ratio"
          && [OMNI_TASKS["Edit video"], OMNI_TASKS["Extend video"]].includes(omniTask as never)) return false;
        if (isKling && param.key === "aspect_ratio" && !klingAspectVisible) return false;
        if (isKling && param.key === "resolution" && klingIsV3) return false;
        if (isKling && param.key === "sound" && !klingIsV3) return false;
        return true;
      }).map((p) => (
        <label className={`ff-param${p.kind === "toggle" ? " ff-param-toggle" : ""}`} key={p.key}>
          <span>
            {p.key === "duration" && isOmni && omniTask === OMNI_TASKS["Extend video"]
              ? "Extension length (seconds)"
              : p.key === "duration" && isKling && klingIsEdit
                ? "Output length (seconds)"
                : d.paramLabels?.[p.key] ?? p.label}
          </span>
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
              const actualOptions = isKling && p.key === "aspect_ratio"
                ? klingAspectOptions
                : seedanceImageToVideo && p.key === "resolution"
                  ? options.filter((option) => ["480p", "720p", "1080p"].includes(option))
                  : options;
              const selectedValue = actualOptions.includes(d.params[p.key])
                ? d.params[p.key]
                : p.key === "aspect_ratio" && isKling && klingIsIngredients
                  ? "Auto"
                  : p.default ?? actualOptions[0] ?? "";
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
                options: group.options.filter((option) => actualOptions.includes(option)),
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
                    : actualOptions.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
                </select>
              );
            })()
          ) : p.kind === "textarea" ? (
            <textarea className="nodrag nowheel" rows={3} value={d.params[p.key] ?? ""}
              onChange={(e) => setParam(p.key, e.target.value)} />
          ) : p.kind === "number" ? (
            <input className="nodrag" type={isKling && p.key === "cfg_scale" ? "range" : "number"}
              min={isKling && p.key === "cfg_scale" ? 0 : undefined}
              max={isKling && p.key === "cfg_scale" ? 1 : undefined}
              step={isKling && p.key === "cfg_scale" ? 0.01 : p.key === "seed" ? 1 : undefined}
              value={d.params[p.key] ?? 0}
              onChange={(e) => setParam(p.key, isOmni && p.key === "seed" && e.target.value === ""
                ? -1
                : e.target.value)} />
          ) : p.kind === "file" ? (
            <>
              <input className="nodrag" type="text" placeholder="https://…" value={d.params[p.key] ?? ""}
                onChange={(e) => setParam(p.key, e.target.value)} />
              <input className="nodrag" type="file"
                accept={isKlingImage ? "image/jpeg,image/png" : isOmniImage ? "image/png,image/jpeg,image/webp" : "image/*"}
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
          {isKling && p.key === "resolution" && (
            <small className="ff-param-help">1080p-esr enhances a 720p render. 2k-esr and 4k-esr enhance a 1080p render (not native). Billed as the source generation plus the enhancement.</small>
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
      {isKling && (
        <div className="ff-node-cost">
          Estimated cost: {klingCost}
          {klingVideoCount > 0 || klingSubjects.some((subject) => subject.type === "video" && subject.reference_video)
            ? <div>Input video seconds are billed too.</div>
            : null}
          {String(d.params.resolution ?? "").endsWith("-esr") && <div>Enhanced resolutions cost extra.</div>}
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
