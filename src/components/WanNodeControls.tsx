"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, useEdges, useNodes, useReactFlow, useUpdateNodeInternals } from "@xyflow/react";
import { PORT_COLORS } from "@/lib/registry";
import {
  buildWanRequest,
  normalizeWanParams,
  WAN_CONFIRM_ABOVE_USD,
  WAN_MODELS,
  WAN_RATES,
  WAN_RESOLUTIONS,
  WAN_TASKS,
  type WanReferenceInput,
  type WanResolvedInputs,
  type WanStoredFile,
  validateWanImageMetadata,
} from "@/lib/wan";
import {
  getWanPrediction,
  submitWanPrediction,
  uploadWanMedia,
  wanDataUrlToFile,
  type WanUploadKind,
} from "@/lib/wan-api";
import { deleteWanDocument, loadWanDocument, saveWanDocument } from "@/lib/wan-storage";

type WanNodeControlsProps = {
  nodeId: string;
  nodeData: Record<string, unknown>;
};

type WanEdge = ReturnType<typeof useEdges>[number];
type WanImageValidation = {
  type: string;
  size: number;
  width: number;
  height: number;
  hasAlpha: boolean;
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown) {
  return isRecord(value) ? value : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nodeDataValue(node: ReturnType<typeof useNodes>[number] | undefined) {
  return asRecord(node?.data);
}

function sourceValue(
  node: ReturnType<typeof useNodes>[number] | undefined,
  sourceHandle: string,
) {
  const data = nodeDataValue(node);
  const params = asRecord(data.params);
  const outputs = asRecord(data.outputs);
  if (data.type === "input/image" && sourceHandle === "image") return params.url;
  if (data.type === "input/prompt" && sourceHandle === "text") {
    return params.assistant_enabled === true
      ? params.refined_prompt || params.text || outputs.text
      : params.text || outputs.text;
  }
  if (sourceHandle in outputs) return outputs[sourceHandle];
  return undefined;
}

function referenceKind(handle: string): WanReferenceInput["type"] | null {
  if (/^reference_image_\d+$/.test(handle)) return "image";
  if (/^reference_video_\d+$/.test(handle)) return "video";
  if (/^reference_audio_\d+$/.test(handle)) return "audio";
  return null;
}

function videoDuration(node: ReturnType<typeof useNodes>[number] | undefined) {
  const data = nodeDataValue(node);
  const params = asRecord(data.params);
  const duration = Number(params.duration ?? data.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function findWanVideoUrl(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\/\S+$/i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findWanVideoUrl(item);
      if (url) return url;
    }
  } else if (isRecord(value) && typeof value.url === "string") {
    return findWanVideoUrl(value.url);
  }
  return "";
}

function isLocalMedia(value: unknown) {
  return typeof value === "string"
    ? value.startsWith("data:")
    : isRecord(value) && (value.local === true || typeof value.id === "string"
      || typeof value.dataUrl === "string" || value.file instanceof File);
}

function wanImageDataKey(value: unknown) {
  if (typeof value === "string" && value.startsWith("data:")) return value;
  if (isRecord(value) && typeof value.dataUrl === "string") return value.dataUrl;
  if (value instanceof File) return `file:${value.name}:${value.size}:${value.lastModified}`;
  if (isRecord(value) && value.file instanceof File) {
    return `file:${value.file.name}:${value.file.size}:${value.file.lastModified}`;
  }
  return "";
}

async function inspectWanImage(file: File) {
  const basicMetadata = { type: file.type, size: file.size, width: 240, height: 240, hasAlpha: false };
  const basicErrors = validateWanImageMetadata(basicMetadata);
  if (basicErrors.some((error) => error.includes("20 MB") || error.includes("JPEG, PNG"))) {
    return { ...basicMetadata, width: 0, height: 0, errors: basicErrors };
  }
  const bitmap = await createImageBitmap(file);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let hasAlpha = false;
    if (file.type === "image/png" && bytes.length > 25) {
      hasAlpha = bytes[25] === 4 || bytes[25] === 6;
      for (let offset = 8; !hasAlpha && offset + 12 <= bytes.length;) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        const chunk = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
        if (chunk === "tRNS") hasAlpha = true;
        if (length > bytes.length - offset - 12) break;
        offset += length + 12;
      }
    }
    if (file.type === "image/bmp" && bytes.length >= 30) {
      hasAlpha = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(28, true) === 32;
    }
    if (file.type === "image/webp" && bytes.length >= 21
      && String.fromCharCode(...bytes.slice(12, 16)) === "VP8X") {
      hasAlpha = (bytes[20] & 0x10) !== 0;
    }
    const metadata = { type: file.type, size: file.size, width: bitmap.width, height: bitmap.height, hasAlpha };
    return { ...metadata, errors: validateWanImageMetadata(metadata) };
  } finally {
    bitmap.close();
  }
}

function isHttpMedia(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function localFile(value: unknown, fallbackName: string, fallbackType: string): File | null {
  if (value instanceof File) return value;
  if (typeof value === "string" && value.startsWith("data:")) {
    return wanDataUrlToFile(value, fallbackName, fallbackType);
  }
  if (isRecord(value)) {
    if (value.file instanceof File) return value.file;
    if (typeof value.dataUrl === "string") return wanDataUrlToFile(value.dataUrl, asString(value.name) || fallbackName, asString(value.type) || fallbackType);
    if (typeof value.value === "string") return localFile(value.value, asString(value.name) || fallbackName, asString(value.type) || fallbackType);
  }
  return null;
}

function WanInputPort({ id, label, type }: { id: string; label: string; type: "text" | "image" | "video" | "audio" }) {
  return (
    <div className="ff-port ff-in ff-wan-port">
      <Handle
        type="target"
        position={Position.Left}
        id={id}
        style={{ background: PORT_COLORS[type] }}
      />
      {label}
    </div>
  );
}

function WanMediaUpload(props: {
  kind: WanUploadKind;
  file?: File;
  onUpload: (file?: File) => void;
}) {
  const accept = props.kind === "document"
    ? ".docx,.doc,.xlsx,.xls,.pptx,.ppt,.pdf,.txt,.key,.pages,.numbers,.md"
    : props.kind === "image"
      ? "image/jpeg,image/png,image/bmp,image/webp"
      : props.kind === "video"
        ? "video/mp4,video/quicktime"
        : "audio/wav,audio/mpeg";
  return (
    <input
      className="nodrag"
      type="file"
      accept={accept}
      onChange={(event) => props.onUpload(event.currentTarget.files?.[0])}
    />
  );
}

export default function WanNodeControls({ nodeId, nodeData }: WanNodeControlsProps) {
  const nodes = useNodes();
  const edges = useEdges();
  const {
    addEdges,
    addNodes,
    deleteElements,
    getEdges,
    getNode,
    getNodes,
    updateNodeData,
  } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [canStopWaiting, setCanStopWaiting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [pollError, setPollError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [previewBody, setPreviewBody] = useState("");
  const [statusLine, setStatusLine] = useState("Idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [imageMetadata, setImageMetadata] = useState<Record<string, WanImageValidation>>({});
  const mounted = useRef(true);
  const pollController = useRef<AbortController | null>(null);

  const params = useMemo(() => normalizeWanParams(asRecord(nodeData.params)), [nodeData.params]);
  const task = params.task;
  const connectedEdges = useMemo(
    () => edges.filter((edge) => edge.target === nodeId),
    [edges, nodeId],
  );
  const incomingByHandle = useMemo(
    () => new Map(connectedEdges.map((edge) => [edge.targetHandle ?? "", edge])),
    [connectedEdges],
  );

  const setWanParams = (patch: Record<string, unknown>) => {
    updateNodeData(nodeId, (current: { data: Record<string, unknown> }) => ({
      params: {
        ...normalizeWanParams(asRecord(current.data.params)),
        ...patch,
      },
    }));
  };

  const setWanState = (
    line: string,
    detail = "",
    status: "idle" | "running" | "done" | "error" = "idle",
  ) => {
    if (!mounted.current || !getNode(nodeId)) return;
    setStatusLine(line);
    setStatusDetail(detail);
    updateNodeData(nodeId, { status });
  };

  const resolvedInputs = useMemo<WanResolvedInputs>(() => {
    const sourceNodes = new Map(nodes.map((node) => [node.id, node]));
    const promptEdge = incomingByHandle.get("prompt");
    const promptNode = promptEdge ? sourceNodes.get(promptEdge.source) : undefined;
    const prompt = promptEdge ? sourceValue(promptNode, promptEdge.sourceHandle ?? "text") : "";
    const imageEdge = incomingByHandle.get("image");
    const lastImageEdge = incomingByHandle.get("last_image");
    const withImageMetadata = (value: unknown) => {
      const key = wanImageDataKey(value);
      const metadata = key ? imageMetadata[key] : undefined;
      if (!metadata) return value;
      if (typeof value === "string") return { local: true, dataUrl: value, ...metadata };
      if (value instanceof File) return { local: true, file: value, ...metadata };
      return isRecord(value) ? { ...value, local: true, ...metadata } : value;
    };
    const referenceEdges = connectedEdges
      .filter((edge) => referenceKind(edge.targetHandle ?? "") !== null)
      .sort((left, right) => {
        const leftHandle = left.targetHandle ?? "";
        const rightHandle = right.targetHandle ?? "";
        const leftType = referenceKind(leftHandle)!;
        const rightType = referenceKind(rightHandle)!;
        const order = { image: 0, video: 1, audio: 2 };
        return order[leftType] - order[rightType]
          || Number(leftHandle.split("_").at(-1)) - Number(rightHandle.split("_").at(-1));
      });
    const references = referenceEdges
      .map((edge) => {
        const handle = edge.targetHandle ?? "";
        const type = referenceKind(handle);
        if (!type) return null;
        const source = sourceNodes.get(edge.source);
        const seconds = type === "video" ? videoDuration(source) : 0;
        const value = sourceValue(source, edge.sourceHandle ?? "");
        return {
          type,
          value: type === "image" ? withImageMetadata(value) : value,
          ...(seconds > 0 ? { seconds } : {}),
        } satisfies WanReferenceInput;
      })
      .filter((item): item is WanReferenceInput => item !== null);
    const videoSeconds = references
      .filter((reference) => reference.type === "video")
      .reduce((total, reference) => total + (reference.seconds ?? 0), 0);
    const audioSeconds = references
      .filter((reference) => reference.type === "audio")
      .reduce((total, reference) => total + (reference.seconds ?? 0), 0);
    const document = params.file;
    return {
      prompt,
      image: imageEdge
        ? withImageMetadata(sourceValue(sourceNodes.get(imageEdge.source), imageEdge.sourceHandle ?? ""))
        : undefined,
      last_image: lastImageEdge
        ? withImageMetadata(sourceValue(sourceNodes.get(lastImageEdge.source), lastImageEdge.sourceHandle ?? ""))
        : undefined,
      references,
      referenceVideoSeconds: videoSeconds,
      referenceAudioSeconds: audioSeconds,
      ...(document ? { file: document } : {}),
    };
  }, [connectedEdges, imageMetadata, incomingByHandle, nodes, params.file]);

  const localImageEntries = useMemo(() => {
    const values = [
      { value: resolvedInputs.image, label: "wan-first-frame" },
      { value: resolvedInputs.last_image, label: "wan-last-frame" },
      ...(resolvedInputs.references ?? [])
        .filter((reference) => reference.type === "image")
        .map((reference, index) => ({ value: reference.value, label: `wan-reference-${index + 1}` })),
    ];
    return values.flatMap(({ value, label }) => {
      if (!isLocalMedia(value)) return [];
      const key = wanImageDataKey(value);
      return key ? [{ key, value, label }] : [];
    });
  }, [resolvedInputs]);

  useEffect(() => {
    const unchecked = localImageEntries.filter((entry) => !imageMetadata[entry.key]);
    if (!unchecked.length) return;
    let cancelled = false;
    void Promise.all(unchecked.map(async (entry) => {
      try {
        const file = localFile(entry.value, entry.label, "image/jpeg");
        if (!file) throw new Error("Local image could not be read.");
        return { key: entry.key, metadata: await inspectWanImage(file) };
      } catch (error) {
        return {
          key: entry.key,
          metadata: {
            type: "",
            size: 0,
            width: 0,
            height: 0,
            hasAlpha: false,
            errors: [error instanceof Error ? error.message : "Local image could not be validated."],
          },
        };
      }
    })).then((results) => {
      if (cancelled) return;
      setImageMetadata((current) => ({
        ...current,
        ...Object.fromEntries(results.map(({ key, metadata }) => [key, metadata])),
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [imageMetadata, localImageEntries]);

  const request = useMemo(
    () => buildWanRequest({ params }, resolvedInputs),
    [params, resolvedInputs],
  );
  const promptEdge = incomingByHandle.get("prompt");
  const promptText = typeof resolvedInputs.prompt === "string" ? resolvedInputs.prompt : "";
  const localImageErrors = localImageEntries.flatMap((entry) => imageMetadata[entry.key]?.errors ?? []);
  const imageMetadataPending = localImageEntries.some((entry) => !imageMetadata[entry.key]);
  const requestErrors = [
    ...request.errors.filter((error) =>
      error !== "Connect a Prompt node with prompt text."
      && !(error === "A prompt is required." && !promptText.trim())
      && !(task === WAN_TASKS["Image to video"] && !incomingByHandle.has("image")
        && (error.startsWith("First frame must") || error === "A public first-frame image URL is required."))
    ),
    ...localImageErrors,
    ...(imageMetadataPending ? ["Checking local image dimensions and format."] : []),
  ];
  const imageReferences = connectedEdges.filter((edge) => /^reference_image_\d+$/.test(edge.targetHandle ?? ""));
  const videoReferences = connectedEdges.filter((edge) => /^reference_video_\d+$/.test(edge.targetHandle ?? ""));
  const audioReferences = connectedEdges.filter((edge) => /^reference_audio_\d+$/.test(edge.targetHandle ?? ""));
  const totalReferences = imageReferences.length + videoReferences.length + audioReferences.length;
  const videoSeconds = Number(resolvedInputs.referenceVideoSeconds ?? 0);
  const audioSeconds = referencesAudioSeconds(connectedEdges, nodes);
  const modelRate = WAN_RATES[params.model] ?? WAN_RATES[WAN_MODELS["Wan 3.0"]];
  const estimatedMinimum = params.duration === -1 ? null : Number(params.duration) * modelRate;
  const estimatedCost = estimatedMinimum === null
    ? "Length chosen by the model; cost depends on final length."
    : `from ~$${estimatedMinimum.toFixed(3)} (lowest-resolution rate; higher resolutions cost more)`;
  const needConfirmation = estimatedMinimum !== null && estimatedMinimum > WAN_CONFIRM_ABOVE_USD;
  const storedFile = params.file as WanStoredFile | null;
  const documentLabel = storedFile?.name ?? (typeof params.file === "string" ? params.file : "");
  const documentOrLink = Boolean(storedFile || params.link);

  const syncWanInputs = useCallback(async (nextTask: string, requestedReferenceCount: number) => {
    const requestedInputs = nextTask === WAN_TASKS["Image to video"]
      ? [
        { role: "first_frame", label: "First frame", handle: "image", y: -92 },
        { role: "last_frame", label: "Last frame", handle: "last_image", y: 112 },
      ]
      : nextTask === WAN_TASKS["Reference to video"]
        ? Array.from({ length: requestedReferenceCount }, (_, index) => ({
          role: `reference_image_${index + 1}`,
          label: `Reference ${index + 1}`,
          handle: `reference_image_${index + 1}`,
          y: (index - (requestedReferenceCount - 1) / 2) * 112,
        }))
        : [];
    const wantedRoles = new Set(requestedInputs.map((input) => input.role));
    const validHandles = new Set([
      "prompt",
      ...(nextTask === WAN_TASKS["Image to video"] ? ["image", "last_image"] : []),
      ...(nextTask === WAN_TASKS["Reference to video"] ? [
        ...Array.from({ length: requestedReferenceCount }, (_, index) => `reference_image_${index + 1}`),
        ...Array.from({ length: 5 }, (_, index) => `reference_video_${index + 1}`),
        ...Array.from({ length: 5 }, (_, index) => `reference_audio_${index + 1}`),
      ] : []),
    ]);
    const autoInputs = getNodes().filter((candidate) => {
      const data = asRecord(candidate.data);
      return data.autoCreatedFor === nodeId || data.wanAutoCreatedFor === nodeId;
    });
    const obsolete = autoInputs.filter((candidate) => {
      const data = asRecord(candidate.data);
      const role = asString(data.autoCreatedRole ?? data.wanAutoCreatedRole);
      return !wantedRoles.has(role);
    });
    const obsoleteIds = new Set(obsolete.map((candidate) => candidate.id));
    const obsoleteEdges = getEdges().filter((edge) =>
      (edge.target === nodeId && !validHandles.has(edge.targetHandle ?? ""))
      || obsoleteIds.has(edge.source)
    );
    if (obsolete.length || obsoleteEdges.length) {
      await deleteElements({
        nodes: obsolete.map((candidate) => ({ id: candidate.id })),
        edges: obsoleteEdges,
      });
    }

    const kept = autoInputs.filter((candidate) => !obsoleteIds.has(candidate.id));
    const existingRoleToNode = new Map(kept.map((candidate) => [
      asString(asRecord(candidate.data).autoCreatedRole ?? asRecord(candidate.data).wanAutoCreatedRole),
      candidate,
    ]));
    const position = getNode(nodeId)?.position ?? { x: 400, y: 200 };
    const additions = requestedInputs
      .filter((input) => !existingRoleToNode.has(input.role))
      .map((input) => {
        const inputId = `input/image-${crypto.randomUUID()}`;
        return {
          node: {
            id: inputId,
            type: "workflow",
            position: { x: position.x - 360, y: position.y + input.y },
            data: {
              type: "input/image",
              params: { url: "" },
              status: "idle",
              outputs: {},
              log: "",
              title: input.label,
              paramLabels: { url: `${input.label} image (upload or paste URL)` },
              autoCreatedFor: nodeId,
              autoCreatedRole: input.role,
            },
          },
          edge: {
            id: `${inputId}-${nodeId}-${input.role}`,
            source: inputId,
            sourceHandle: "image",
            target: nodeId,
            targetHandle: input.handle,
          },
        };
      });
    const edgesToRestore = requestedInputs.flatMap((input) => {
      const existingNode = existingRoleToNode.get(input.role);
      if (!existingNode || getEdges().some((edge) => edge.target === nodeId && edge.targetHandle === input.handle)) return [];
      return [{
        id: `${existingNode.id}-${nodeId}-${input.role}`,
        source: existingNode.id,
        sourceHandle: "image",
        target: nodeId,
        targetHandle: input.handle,
      }];
    });
    if (additions.length) addNodes(additions.map((addition) => addition.node));
    const edgesToAdd = [...additions.map((addition) => addition.edge), ...edgesToRestore];
    if (edgesToAdd.length) {
      window.requestAnimationFrame(() => {
        updateNodeInternals(nodeId);
        window.requestAnimationFrame(() => {
          const currentParams = asRecord(asRecord(getNode(nodeId)?.data).params);
          updateNodeInternals(nodeId);
          if (currentParams.task === nextTask) addEdges(edgesToAdd);
        });
      });
    }
  }, [addEdges, addNodes, deleteElements, getEdges, getNode, getNodes, nodeId, updateNodeInternals]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pollController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => updateNodeInternals(nodeId));
    void syncWanInputs(task, params.reference_count).catch((error: unknown) => {
      setSyncError(error instanceof Error ? error.message : "Wan input nodes could not be synchronized.");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nodeId, params.reference_count, syncWanInputs, task, updateNodeInternals]);

  useEffect(() => {
    if (params.last_output_url && asRecord(nodeData.outputs).video !== params.last_output_url) {
      updateNodeData(nodeId, { outputs: { video: params.last_output_url }, status: "done" });
    }
  }, [nodeId, nodeData.outputs, params.last_output_url, params.last_status, updateNodeData]);

  const changeTask = async (nextTask: string) => {
    setConfirmationOpen(false);
    try {
      const taskEdges = getEdges().filter((edge) =>
        edge.target === nodeId && edge.targetHandle !== "prompt",
      );
      if (taskEdges.length) await deleteElements({ edges: taskEdges });
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Wan connections could not be updated.");
      return;
    }
    if (nextTask !== WAN_TASKS["Reference to video"] && storedFile?.id) {
      void deleteWanDocument(storedFile.id);
    }
    setWanParams({
      task: nextTask,
      ...(nextTask !== WAN_TASKS["Reference to video"]
        ? { file: null, link: "", enable_thinking: false }
        : {}),
    });
    setSyncError("");
  };

  const addReferenceImage = () => {
    if (task !== WAN_TASKS["Reference to video"] || params.reference_count >= 10) return;
    setWanParams({ reference_count: Math.min(10, params.reference_count + 1) });
  };

  const changeLink = (value: string) => {
    setWanParams({
      link: value,
      ...(value.trim() ? { file: null, enable_thinking: true } : { enable_thinking: false }),
    });
    if (value.trim() && storedFile?.id) void deleteWanDocument(storedFile.id);
  };

  const changeDocument = async (file?: File) => {
    setGenerationError("");
    if (!file) return;
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    const allowed = ["docx", "doc", "xlsx", "xls", "pptx", "ppt", "pdf", "txt", "key", "pages", "numbers", "md"];
    if (!allowed.includes(extension)) {
      setGenerationError("Choose a supported document format.");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      setGenerationError("Documents must be 100 MB or smaller.");
      return;
    }
    const document: WanStoredFile = {
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type,
      size: file.size,
    };
    try {
      await saveWanDocument(document.id, file);
      if (storedFile?.id) await deleteWanDocument(storedFile.id);
      setWanParams({ file: document, link: "", enable_thinking: true });
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "The document could not be saved in this browser.");
    }
  };

  const clearDocument = () => {
    if (storedFile?.id) void deleteWanDocument(storedFile.id);
    setWanParams({ file: null, enable_thinking: false });
  };

  const stopPolling = () => {
    pollController.current?.abort();
    pollController.current = null;
    setActive(false);
    setCanStopWaiting(false);
    setWanState("Stopped waiting", "The job keeps running and is still billed on Atlas.");
  };

  const waitForWanPrediction = async (predictionId: string) => {
    const controller = new AbortController();
    pollController.current = controller;
    setActive(true);
    setCanStopWaiting(true);
    setPollError("");
    setGenerationError("");
    const startedAt = Date.now();
    setWanState("Submitted");
    try {
      while (Date.now() - startedAt < 15 * 60 * 1000 && !controller.signal.aborted) {
        const elapsed = Date.now() - startedAt;
        const delay = elapsed < 30_000 ? 3000 : elapsed < 90_000 ? 5000 : 8000;
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, delay);
          const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Polling stopped.", "AbortError"));
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        });
        if (controller.signal.aborted) return;
        const result = await getWanPrediction(predictionId, controller.signal);
        const status = result.status.toLowerCase();
        setWanParams({ last_status: status });
        if (status === "completed" || status === "succeeded") {
          const videoUrl = findWanVideoUrl(result.outputs);
          if (!videoUrl) throw new Error("Atlas completed the generation without returning a video URL.");
          setWanParams({ last_status: status, last_output_url: videoUrl });
          if (mounted.current && getNode(nodeId)) {
            updateNodeData(nodeId, {
              params: {
                ...normalizeWanParams(asRecord(asRecord(getNode(nodeId)?.data).params)),
                last_status: status,
                last_output_url: videoUrl,
              },
              outputs: { video: videoUrl },
              status: "done",
            });
          }
          setWanState("Completed", "Download it if you want to keep it (retention unverified on Atlas).", "done");
          return;
        }
        if (status === "failed") {
          const error = typeof result.error === "string"
            ? result.error
            : isRecord(result.error) && typeof result.error.message === "string"
              ? result.error.message
              : "Atlas generation failed.";
          setWanParams({ last_status: "failed" });
          setWanState("Failed", error, "error");
          setGenerationError(error);
          return;
        }
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
        setWanState(status === "created" ? "Submitted" : "Processing", `Elapsed ${elapsedLabel}`, "running");
      }
      if (!controller.signal.aborted) {
        setWanState("Timed out waiting", "Still running on Atlas. Resume checking.", "running");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : "Could not check the Atlas prediction.";
      setPollError(message);
      setWanState("Polling error", message, "error");
    } finally {
      if (pollController.current === controller) pollController.current = null;
      if (mounted.current) {
        setActive(false);
        setCanStopWaiting(false);
      }
    }
  };

  const resumeChecking = () => {
    if (params.prediction_id && !active) void waitForWanPrediction(params.prediction_id);
  };

  const resolveLocalValue = async (value: unknown, kind: WanUploadKind, name: string) => {
    if (isHttpMedia(value)) return value;
    let file = localFile(value, name, kind === "image" ? "image/jpeg"
      : kind === "video" ? "video/mp4"
        : kind === "audio" ? "audio/wav" : "application/octet-stream");
    if (!file && kind === "document" && isRecord(value) && typeof value.id === "string") {
      file = await loadWanDocument(value.id);
    }
    if (!file) {
      if (typeof value === "string" && value.startsWith("data:")) {
        file = wanDataUrlToFile(value, name, "application/octet-stream");
      } else {
        throw new Error(`${name} must be a public URL or a readable local file.`);
      }
    }
    return file;
  };

  const uploadInputs = async (inputs: WanResolvedInputs) => {
    const uploads: Array<{ key: "image" | "last_image" | "file" | number; value: unknown; kind: WanUploadKind; name: string }> = [];
    if (isLocalMedia(inputs.image)) uploads.push({ key: "image", value: inputs.image, kind: "image", name: "wan-first-frame" });
    if (isLocalMedia(inputs.last_image)) uploads.push({ key: "last_image", value: inputs.last_image, kind: "image", name: "wan-last-frame" });
    for (const [index, reference] of (inputs.references ?? []).entries()) {
      if (isLocalMedia(reference.value)) uploads.push({ key: index, value: reference.value, kind: reference.type, name: `wan-reference-${index + 1}` });
    }
    if (isLocalMedia(inputs.file)) uploads.push({ key: "file", value: inputs.file, kind: "document", name: "wan-document" });

    const resolved: WanResolvedInputs = {
      ...inputs,
      references: [...(inputs.references ?? [])],
    };
    let uploaded = 0;
    for (const item of uploads) {
      uploaded++;
      setUploadStatus(`Uploading ${uploaded} of ${uploads.length}`);
      setWanState(`Uploading ${uploaded} of ${uploads.length}`, "", "running");
      const fileOrUrl = await resolveLocalValue(item.value, item.kind, item.name);
      const url = typeof fileOrUrl === "string" ? fileOrUrl : await uploadWanMedia(fileOrUrl, item.kind);
      if (item.key === "image" || item.key === "last_image") {
        resolved[item.key] = url;
      } else if (item.key === "file") {
        resolved.file = url;
      } else if (resolved.references) {
        resolved.references[item.key] = { ...resolved.references[item.key], value: url };
      }
    }
    setUploadStatus("");
    return resolved;
  };

  const submitGeneration = async () => {
    if (active) return;
    setGenerationError("");
    setPollError("");
    setConfirmationOpen(false);
    const currentRequest = buildWanRequest({ params }, resolvedInputs);
    if (currentRequest.errors.length) {
      setGenerationError(currentRequest.errors[0]);
      return;
    }
    setActive(true);
    try {
      const uploadedInputs = await uploadInputs(resolvedInputs);
      const finalRequest = buildWanRequest({ params }, uploadedInputs);
      if (finalRequest.errors.length) throw new Error(finalRequest.errors[0]);
      setWanState("Submitted", "", "running");
      const submitted = await submitWanPrediction(finalRequest.body);
      setWanParams({ prediction_id: submitted.predictionId, last_status: submitted.status, last_output_url: "" });
      if (getNode(nodeId)) {
        updateNodeData(nodeId, { outputs: {}, status: "running" });
      }
      await waitForWanPrediction(submitted.predictionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wan generation failed.";
      setGenerationError(message);
      setWanState("Failed", message, "error");
    } finally {
      setUploadStatus("");
      setActive(false);
    }
  };

  const handleGenerate = () => {
    setGenerationError("");
    setPollError("");
    const currentRequest = buildWanRequest({ params }, resolvedInputs);
    if (currentRequest.errors.length) {
      setGenerationError(currentRequest.errors[0]);
      return;
    }
    if (needConfirmation) {
      setConfirmationOpen(true);
      return;
    }
    void submitGeneration();
  };

  const handlePreview = () => {
    setPreviewBody(JSON.stringify(request.body, null, 2));
    setPreviewOpen((open) => !open);
  };

  const taskPorts = task === WAN_TASKS["Image to video"]
    ? [
      { id: "image", label: "First frame (required)", type: "image" as const },
      { id: "last_image", label: "Last frame (optional)", type: "image" as const },
    ]
    : task === WAN_TASKS["Reference to video"]
      ? [
        ...Array.from({ length: params.reference_count }, (_, index) => ({
          id: `reference_image_${index + 1}`,
          label: `Reference image ${index + 1}`,
          type: "image" as const,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `reference_video_${index + 1}`,
          label: `Reference video ${index + 1}`,
          type: "video" as const,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `reference_audio_${index + 1}`,
          label: `Reference audio ${index + 1}`,
          type: "audio" as const,
        })),
      ]
      : [];
  const missingFirstFrame = task === WAN_TASKS["Image to video"] && !incomingByHandle.has("image");

  return (
    <section className="ff-wan-controls">
      <div className="ff-wan-field">
        <label htmlFor={`${nodeId}-model`}>Model</label>
        <select
          id={`${nodeId}-model`}
          className="nodrag"
          value={params.model}
          onChange={(event) => setWanParams({ model: event.target.value })}
        >
          <option value={WAN_MODELS["Wan 3.0"]}>Wan 3.0 · from $0.04/s</option>
          <option value={WAN_MODELS["Wan 3.0 Prime"]}>Wan 3.0 Prime · from $0.061/s</option>
        </select>
        <small>Prime is faster and costs more per second. Same inputs and limits.</small>
      </div>

      <div className="ff-wan-field">
        <label htmlFor={`${nodeId}-task`}>Task</label>
        <select id={`${nodeId}-task`} className="nodrag" value={task} onChange={(event) => changeTask(event.target.value)}>
          <option value={WAN_TASKS["Text to video"]}>Text to video</option>
          <option value={WAN_TASKS["Image to video"]}>Image to video</option>
          <option value={WAN_TASKS["Reference to video"]}>Reference to video</option>
        </select>
      </div>

      <WanInputPort id="prompt" label="Prompt" type="text" />
      {!promptEdge || !promptText.trim()
        ? <div className="ff-wan-warning">{promptEdge ? "The connected Prompt node is empty." : "Connect a Prompt node with prompt text."}</div>
        : null}
      {promptText.length > 20000 && <div className="ff-wan-warning">Prompt must not exceed 20,000 characters.</div>}
      <div className="ff-wan-note">Prompt: {promptText.length} / 20,000 characters.</div>

      {taskPorts.map((port) => <WanInputPort key={port.id} {...port} />)}
      {missingFirstFrame && <div className="ff-wan-warning">Image to video requires a connected first frame.</div>}
      {task === WAN_TASKS["Reference to video"] && (
        <>
          <button
            type="button"
            className="ff-wan-add nodrag"
            disabled={params.reference_count >= 10}
            onClick={addReferenceImage}
          >
            Add reference image ({Math.min(params.reference_count, 10)} / 10 slots)
          </button>
          <div className={totalReferences > 20 ? "ff-wan-warning" : "ff-wan-note"}>
            References: {totalReferences} / 20
          </div>
          <div className={imageReferences.length > 10 ? "ff-wan-warning" : "ff-wan-note"}>Images {imageReferences.length} / 10</div>
          <div className={videoReferences.length > 5 || videoSeconds > 15 ? "ff-wan-warning" : "ff-wan-note"}>
            Videos {videoReferences.length} / 5 ({videoSeconds} / 15 s total)
          </div>
          <div className={audioReferences.length > 5 || audioSeconds > 15 ? "ff-wan-warning" : "ff-wan-note"}>
            Audio {audioReferences.length} / 5 ({audioSeconds} / 15 s total)
          </div>
          {videoSeconds > 0 && (
            <div className="ff-wan-note">
              Input and output video together must stay within 30 seconds.
              {params.duration !== -1 && Number(params.duration) + videoSeconds > 30
                ? " The selected duration exceeds this limit."
                : ""}
            </div>
          )}
          <div className="ff-wan-note">
            Reference images: JPEG, JPG, PNG without alpha, BMP, or WebP; each edge 240–8000 px; aspect ratio up to 8:1; 20 MB.
          </div>
          <div className="ff-wan-note">
            Reference videos: MP4 or MOV, 5 maximum and 15 seconds total. Reference audio: WAV or MP3, 5 maximum and 15 seconds total.
          </div>
        </>
      )}

      <div className="ff-wan-field">
        <label htmlFor={`${nodeId}-duration`}>Duration</label>
        <select
          id={`${nodeId}-duration`}
          className="nodrag"
          value={String(params.duration)}
          onChange={(event) => setWanParams({ duration: Number(event.target.value) })}
        >
          <option value="-1">Smart (model picks)</option>
          {Array.from({ length: 29 }, (_, index) => index + 2).map((seconds) => (
            <option key={seconds} value={seconds}>{seconds} seconds</option>
          ))}
        </select>
      </div>

      <div className="ff-wan-field">
        <label htmlFor={`${nodeId}-resolution`}>Resolution</label>
        <select
          id={`${nodeId}-resolution`}
          className="nodrag"
          value={params.resolution}
          onChange={(event) => setWanParams({ resolution: event.target.value })}
        >
          {["Native", "Enhanced (upscaled, costs more)"].map((group) => (
            <optgroup key={group} label={group}>
              {WAN_RESOLUTIONS.filter((resolution) => resolution.group === group).map(({ value }) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <small>Enhanced tiers upscale the render and cost more <span className="ff-wan-unverified">unverified</span> (exact pricing).</small>
      </div>

      {task !== WAN_TASKS["Image to video"] && (
        <div className="ff-wan-field">
          <label htmlFor={`${nodeId}-ratio`}>Aspect ratio</label>
          <select
            id={`${nodeId}-ratio`}
            className="nodrag"
            value={params.ratio}
            onChange={(event) => setWanParams({ ratio: event.target.value })}
          >
            <option value="adaptive">Adaptive</option>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
            <option value="1:1">1:1</option>
            <option value="3:4">3:4</option>
            <option value="9:16">9:16</option>
          </select>
          {task === WAN_TASKS["Reference to video"] && <small>Adaptive lets the model choose from your references.</small>}
        </div>
      )}
      {task === WAN_TASKS["Image to video"] && <div className="ff-wan-note">The first frame sets the framing.</div>}
      {task === WAN_TASKS["Image to video"] && (
        <div className="ff-wan-note">
          Frames: JPEG, JPG, PNG without alpha, BMP, or WebP; each edge 240–8000 px; aspect ratio up to 8:1; 20 MB.
        </div>
      )}

      <label className="ff-wan-toggle">
        <span>Audio</span>
        <input
          className="nodrag"
          type="checkbox"
          checked={params.audio}
          onChange={(event) => setWanParams({ audio: event.target.checked })}
        />
      </label>
      <div className="ff-wan-note">Audio is generated natively. Same price on or off.</div>

      <div className="ff-wan-field">
        <label htmlFor={`${nodeId}-seed`}>Seed</label>
        <input
          id={`${nodeId}-seed`}
          className="nodrag"
          type="number"
          step={1}
          value={params.seed}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isInteger(value)) setWanParams({ seed: value });
          }}
        />
        <small>-1 = random.</small>
      </div>

      {task === WAN_TASKS["Reference to video"] && (
        <section className="ff-wan-document">
          <strong>Document or webpage (optional)</strong>
          <label className="ff-wan-field">
            <span>Webpage link</span>
            <input
              className="nodrag"
              type="url"
              placeholder="Public webpage URL"
              value={params.link}
              onChange={(event) => changeLink(event.target.value)}
            />
          </label>
          <label className="ff-wan-field">
            <span>Document</span>
            <WanMediaUpload kind="document" onUpload={(file) => void changeDocument(file)} />
            {documentLabel && (
              <span className="ff-wan-document-name">
                {documentLabel}
                <button className="nodrag" type="button" onClick={clearDocument}>Remove</button>
              </span>
            )}
            <small>DOCX, DOC, XLSX, XLS, PPTX, PPT, PDF, TXT, KEY, PAGES, NUMBERS, MD · 100 MB · 50 pages.</small>
          </label>
          <label className={`ff-wan-toggle${documentOrLink ? " ff-wan-locked" : ""}`}>
            <span>Deep thinking</span>
            <input
              className="nodrag"
              type="checkbox"
              checked={documentOrLink || params.enable_thinking}
              disabled={documentOrLink}
              onChange={(event) => setWanParams({ enable_thinking: event.target.checked })}
            />
          </label>
          <div className="ff-wan-note">
            {documentOrLink ? "Required for documents and webpages." : "Not recommended without a document or webpage."}
          </div>
        </section>
      )}

      {videoReferences.length > 0 && (
        <div className="ff-wan-note">Input video seconds may be billed too <span className="ff-wan-unverified">unverified on Atlas</span>.</div>
      )}
      <div className="ff-wan-cost">Estimated cost: {estimatedCost}</div>
      {syncError && <div className="ff-wan-warning">{syncError}</div>}
      {request.warnings.map((warning) => <div className="ff-wan-warning" key={warning}>{warning}</div>)}
      {requestErrors.map((error) => <div className="ff-wan-warning" key={error}>{error}</div>)}
      {generationError && <div className="ff-wan-warning">{generationError}</div>}
      {pollError && (
        <div className="ff-wan-poll-error">
          <span>{pollError}</span>
          <button className="nodrag" type="button" disabled={active} onClick={resumeChecking}>Retry polling</button>
        </div>
      )}

      <div className="ff-wan-status" role="status" aria-live="polite">
        <strong>{statusLine === "Idle" && params.last_status && !params.last_output_url
          ? params.last_status
          : params.last_output_url && statusLine === "Idle" ? "Completed" : statusLine}</strong>
        {statusDetail && <span>{statusDetail}</span>}
        {uploadStatus && <span>{uploadStatus}</span>}
      </div>
      {active && canStopWaiting ? (
        <button type="button" className="ff-wan-action nodrag" onClick={stopPolling}>Stop waiting</button>
      ) : (
        <div className="ff-wan-actions">
          <button
            type="button"
            className="ff-wan-action nodrag"
            disabled={active || requestErrors.length > 0}
            title={requestErrors[0] ?? (active ? "Generation is in progress." : "")}
            onClick={handleGenerate}
          >
            Generate
          </button>
          <button type="button" className="ff-wan-action ff-wan-secondary nodrag" onClick={handlePreview}>
            Preview request
          </button>
        </div>
      )}
      {confirmationOpen && (
        <div className="ff-wan-confirm">
          <span>This will spend about ${estimatedMinimum?.toFixed(3)} or more. Continue?</span>
          <button type="button" className="nodrag" onClick={() => void submitGeneration()}>Continue</button>
          <button type="button" className="nodrag" onClick={() => setConfirmationOpen(false)}>Go back</button>
        </div>
      )}
      {params.prediction_id && !params.last_output_url && !active && !pollError
        && !["failed", "completed", "succeeded"].includes(params.last_status.toLowerCase()) && (
        <button type="button" className="ff-wan-action ff-wan-secondary nodrag" onClick={resumeChecking}>
          Resume checking
        </button>
      )}
      {previewOpen && (
        <section className="ff-wan-preview">
          <strong>Request preview · no API call sent</strong>
          <pre>{previewBody}</pre>
          <button type="button" className="nodrag" onClick={() => setPreviewOpen(false)}>Close preview</button>
        </section>
      )}
    </section>
  );
}

function referencesAudioSeconds(edges: WanEdge[], nodes: ReturnType<typeof useNodes>) {
  return edges
    .filter((edge) => /^reference_audio_\d+$/.test(edge.targetHandle ?? ""))
    .reduce((total, edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      return total + videoDuration(source);
    }, 0);
}
