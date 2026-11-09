"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { registerEditorUploadBridge } from "@/lib/editor-upload-bridge";
import {
  loadEditorMedia,
  loadVideoEditorState,
  saveEditorMedia,
  saveVideoEditorState,
  type StoredVideoEditorState,
} from "@/lib/video-editor-storage";

export type VideoAsset = {
  id: string;
  name: string;
  src: string;
  file?: File;
  mediaId?: string;
};

type TimelineClip = VideoAsset & {
  duration: number;
  trimStart: number;
  trimEnd: number;
};

type VideoSequence = {
  id: string;
  name: string;
  clips: TimelineClip[];
  selectedId: string;
  playheadTime: number;
};

type ClipContextMenu = {
  clipId: string;
  x: number;
  y: number;
};

type ClipTrimDrag = {
  clipId: string;
  edge: "start" | "end";
  pointerId: number;
  startX: number;
  trimStart: number;
  trimEnd: number;
};

type EditorTool = "select" | "razor";

type ClipReorderDrag = {
  clipId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${(safeSeconds % 60).toFixed(1).padStart(4, "0")}`;
}

function loadMedia(video: HTMLVideoElement, src: string) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not load this video. Check that the file or source URL is available."));
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = src;
    video.load();
  });
}

async function fetchMediaFile(src: string, name: string) {
  let response: Response;
  try {
    response = await fetch(src);
  } catch {
    response = await fetch("/api/media/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: src }),
    });
  }
  if (!response.ok) {
    let message = `Could not download "${name}" (${response.status}).`;
    try {
      const payload: unknown = await response.json();
      if (typeof payload === "object" && payload !== null
        && "error" in payload && typeof payload.error === "string") {
        message = payload.error;
      }
    } catch {
      // Keep the status-based message if the response isn't JSON.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error(`"${name}" is empty and cannot be saved.`);
  if (blob.size > 512 * 1024 * 1024) throw new Error(`"${name}" is larger than the 512 MB editor-storage limit.`);
  return new File([blob], name, { type: blob.type || "video/mp4" });
}

export default function VideoEditor({ assets, hidden = false }: { assets: VideoAsset[]; hidden?: boolean }) {
  const [uploadedAssets, setUploadedAssets] = useState<VideoAsset[]>([]);
  const [sequences, setSequences] = useState<VideoSequence[]>([
    { id: "sequence-1", name: "Sequence 1", clips: [], selectedId: "", playheadTime: 0 },
  ]);
  const [activeSequenceId, setActiveSequenceId] = useState("sequence-1");
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [persistenceStatus, setPersistenceStatus] = useState("Restoring editor…");
  const [persistenceError, setPersistenceError] = useState("");
  const [draggingClipId, setDraggingClipId] = useState("");
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenu | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<"mov" | "mp4" | null>(null);
  const [exportStage, setExportStage] = useState("");
  const [loadingAssetId, setLoadingAssetId] = useState("");
  const [error, setError] = useState("");
  const previewRef = useRef<HTMLVideoElement>(null);
  const playbackWanted = useRef(false);
  const advancing = useRef(false);
  const pendingSeek = useRef<{ id: string; time: number } | null>(null);
  const clipButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const trimDrag = useRef<ClipTrimDrag | null>(null);
  const reorderDrag = useRef<ClipReorderDrag | null>(null);
  const suppressClipClick = useRef(false);
  const uploadsHeadingRef = useRef<HTMLHeadingElement>(null);
  const unsavedMediaName = uploadedAssets.find((asset) => !asset.mediaId)?.name
    ?? sequences.flatMap((sequence) => sequence.clips).find((clip) => !clip.mediaId)?.name;
  const persistenceValidationError = unsavedMediaName ? `Media for "${unsavedMediaName}" is not saved yet.` : "";

  useEffect(() => {
    let cancelled = false;
    const restoredUrls: string[] = [];

    void (async () => {
      try {
        const saved = await loadVideoEditorState();
        if (!saved) {
          if (!cancelled) {
            setPersistenceStatus("Saved on this device");
            setPersistenceReady(true);
          }
          return;
        }

        const mediaFiles = new Map<string, File>();
        const mediaIds = new Set([
          ...saved.uploadedAssets.map((asset) => asset.mediaId),
          ...saved.sequences.flatMap((sequence) => sequence.clips.map((clip) => clip.mediaId)),
        ]);
        await Promise.all([...mediaIds].map(async (mediaId) => {
          mediaFiles.set(mediaId, await loadEditorMedia(mediaId));
        }));

        const createAsset = (id: string, name: string, mediaId: string): VideoAsset => {
          const file = mediaFiles.get(mediaId);
          if (!file) throw new Error(`Saved media "${name}" could not be restored.`);
          const src = URL.createObjectURL(file);
          restoredUrls.push(src);
          return { id, name, mediaId, src, file };
        };
        const nextAssets = saved.uploadedAssets.map((asset) => createAsset(asset.id, asset.name, asset.mediaId));
        const nextSequences: VideoSequence[] = saved.sequences.map((sequence) => ({
          ...sequence,
          clips: sequence.clips.map((clip) => ({
            ...createAsset(clip.id, clip.name, clip.mediaId),
            duration: clip.duration,
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd,
          })),
        }));
        const nextActiveSequenceId = nextSequences.some((sequence) => sequence.id === saved.activeSequenceId)
          ? saved.activeSequenceId
          : nextSequences[0]?.id ?? "sequence-1";
        const activeSequence = nextSequences.find((sequence) => sequence.id === nextActiveSequenceId);
        const selectedClip = activeSequence?.clips.find((clip) => clip.id === activeSequence.selectedId)
          ?? activeSequence?.clips[0];
        if (activeSequence && selectedClip) {
          const clipOffset = activeSequence.clips.slice(0, activeSequence.clips.indexOf(selectedClip))
            .reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0);
          const clipTime = Math.min(
            selectedClip.trimEnd,
            Math.max(selectedClip.trimStart, selectedClip.trimStart + activeSequence.playheadTime - clipOffset),
          );
          pendingSeek.current = { id: selectedClip.id, time: clipTime };
        }

        if (cancelled) {
          restoredUrls.forEach((url) => URL.revokeObjectURL(url));
          return;
        }
        if (nextSequences.length > 0) setSequences(nextSequences);
        setUploadedAssets(nextAssets);
        setActiveSequenceId(nextActiveSequenceId);
        setActiveTool(saved.activeTool === "razor" ? "razor" : "select");
        setPersistenceStatus("Restored from this device");
        setPersistenceReady(true);
      } catch (caught) {
        restoredUrls.forEach((url) => URL.revokeObjectURL(url));
        if (cancelled) return;
        setPersistenceError(caught instanceof Error ? caught.message : "Could not restore the video editor.");
        setPersistenceStatus("Editor restore failed");
      }
    })();

    return () => {
      cancelled = true;
      restoredUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!persistenceReady) return;
    if (persistenceValidationError) return;
    const state: StoredVideoEditorState = {
      version: 1,
      sequences: sequences.map((sequence) => ({
        ...sequence,
        clips: sequence.clips.map((clip) => ({
          id: clip.id,
          name: clip.name,
          mediaId: clip.mediaId ?? "",
          duration: clip.duration,
          trimStart: clip.trimStart,
          trimEnd: clip.trimEnd,
        })),
      })),
      uploadedAssets: uploadedAssets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        mediaId: asset.mediaId ?? "",
      })),
      activeSequenceId,
      activeTool,
    };

    let cancelled = false;
    const persist = () => {
      setPersistenceStatus("Saving editor…");
      void saveVideoEditorState(state).then(() => {
        if (cancelled) return;
        setPersistenceError("");
        setPersistenceStatus("Saved on this device");
      }).catch((caught: unknown) => {
        if (cancelled) return;
        setPersistenceError(caught instanceof Error ? caught.message : "Could not save the video editor.");
        setPersistenceStatus("Editor save failed");
      });
    };
    const timeout = window.setTimeout(persist, 250);
    window.addEventListener("pagehide", persist);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("pagehide", persist);
    };
  }, [activeSequenceId, activeTool, persistenceReady, persistenceValidationError, sequences, uploadedAssets]);

  const activeSequence = sequences.find((sequence) => sequence.id === activeSequenceId) ?? sequences[0];
  const clips = activeSequence?.clips ?? [];
  const selectedId = activeSequence?.selectedId ?? "";
  const playheadTime = activeSequence?.playheadTime ?? 0;
  const setClips = (next: SetStateAction<TimelineClip[]>) => {
    setSequences((current) => current.map((sequence) => sequence.id === activeSequenceId
      ? { ...sequence, clips: typeof next === "function" ? next(sequence.clips) : next }
      : sequence));
  };
  const setSelectedId = (next: SetStateAction<string>) => {
    setSequences((current) => current.map((sequence) => sequence.id === activeSequenceId
      ? { ...sequence, selectedId: typeof next === "function" ? next(sequence.selectedId) : next }
      : sequence));
  };
  const setPlayheadTime = (next: SetStateAction<number>) => {
    setSequences((current) => current.map((sequence) => sequence.id === activeSequenceId
      ? { ...sequence, playheadTime: typeof next === "function" ? next(sequence.playheadTime) : next }
      : sequence));
  };
  const selectedClip = clips.find((clip) => clip.id === selectedId) ?? clips[0];
  const totalDuration = clips.reduce((total, clip) => total + Math.max(0, clip.trimEnd - clip.trimStart), 0);

  const createSequence = () => {
    const nextNumber = sequences.reduce((highest, sequence) => {
      const match = /^Sequence (\d+)$/.exec(sequence.name);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    const sequence: VideoSequence = {
      id: `sequence-${crypto.randomUUID()}`,
      name: `Sequence ${nextNumber}`,
      clips: [],
      selectedId: "",
      playheadTime: 0,
    };
    playbackWanted.current = false;
    previewRef.current?.pause();
    pendingSeek.current = null;
    setSequences((current) => [...current, sequence]);
    setActiveSequenceId(sequence.id);
    setClipContextMenu(null);
    setIsPlaying(false);
    setError("");
  };

  const switchSequence = (sequenceId: string) => {
    if (sequenceId === activeSequenceId) return;
    const nextSequence = sequences.find((sequence) => sequence.id === sequenceId);
    if (!nextSequence) return;
    const nextClip = nextSequence.clips.find((clip) => clip.id === nextSequence.selectedId) ?? nextSequence.clips[0];
    if (nextClip) {
      const clipIndex = nextSequence.clips.findIndex((clip) => clip.id === nextClip.id);
      const clipOffset = nextSequence.clips.slice(0, clipIndex)
        .reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0);
      const clipElapsed = Math.min(
        Math.max(0, nextSequence.playheadTime - clipOffset),
        nextClip.trimEnd - nextClip.trimStart,
      );
      pendingSeek.current = { id: nextClip.id, time: nextClip.trimStart + clipElapsed };
    } else {
      pendingSeek.current = null;
    }
    playbackWanted.current = false;
    previewRef.current?.pause();
    setActiveSequenceId(sequenceId);
    setClipContextMenu(null);
    setIsPlaying(false);
    setError("");
  };

  const renameSequence = (name: string) => {
    setSequences((current) => current.map((sequence) => sequence.id === activeSequenceId
      ? { ...sequence, name }
      : sequence));
  };

  const deleteSequence = () => {
    if (sequences.length <= 1 || !activeSequence) return;
    if (!window.confirm(`Delete "${activeSequence.name}" and all ${activeSequence.clips.length} clips in it?`)) return;
    const currentIndex = sequences.findIndex((sequence) => sequence.id === activeSequenceId);
    const nextSequence = sequences[currentIndex - 1] ?? sequences[currentIndex + 1];
    if (!nextSequence) return;
    playbackWanted.current = false;
    previewRef.current?.pause();
    pendingSeek.current = null;
    setSequences((current) => current.filter((sequence) => sequence.id !== activeSequenceId));
    setActiveSequenceId(nextSequence.id);
    setClipContextMenu(null);
    setIsPlaying(false);
    setError("");
  };

  const addAsset = async (asset: VideoAsset) => {
    const targetSequenceId = activeSequenceId;
    setError("");
    setLoadingAssetId(asset.id);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    let normalizedUrl: string | null = null;
    try {
      let clipAsset: VideoAsset = {
        id: asset.id,
        name: asset.name,
        src: asset.src,
        mediaId: asset.mediaId ?? `clip-media-${crypto.randomUUID()}`,
        ...(asset.file ? { file: asset.file } : {}),
      };
      try {
        await loadMedia(probe, asset.src);
      } catch (originalError) {
        if (!asset.file) throw originalError;
        const formData = new FormData();
        formData.append("clip", asset.file, asset.file.name);
        const response = await fetch("/api/video/normalize", { method: "POST", body: formData });
        if (!response.ok) {
          let message = `Could not prepare "${asset.name}" for preview (${response.status}).`;
          try {
            const payload: unknown = await response.json();
            if (typeof payload === "object" && payload !== null
              && "error" in payload && typeof payload.error === "string") {
              message = payload.error;
            }
          } catch {
            // Keep the status-based message if the server response isn't JSON.
          }
          throw new Error(message);
        }
        const normalizedVideo = await response.blob();
        if (normalizedVideo.size === 0) throw new Error(`Could not prepare "${asset.name}" for preview.`);
        normalizedUrl = URL.createObjectURL(normalizedVideo);
        const normalizedFile = new File([normalizedVideo], asset.name, { type: normalizedVideo.type || "video/mp4" });
        clipAsset = {
          ...clipAsset,
          src: normalizedUrl,
          file: normalizedFile,
        };
        await loadMedia(probe, normalizedUrl);
      }
      const duration = probe.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("This video does not have a supported duration.");
      }
      const clip: TimelineClip = {
        ...clipAsset,
        id: `${asset.id}-${crypto.randomUUID()}`,
        duration,
        trimStart: 0,
        trimEnd: duration,
      };
      const mediaFile = clipAsset.file ?? await fetchMediaFile(asset.src, asset.name);
      if (mediaFile.size > 512 * 1024 * 1024) {
        throw new Error(`"${asset.name}" is larger than the 512 MB editor-storage limit.`);
      }
      const mediaId = clipAsset.mediaId;
      if (!mediaId) throw new Error(`Could not assign persistent storage to "${asset.name}".`);
      await saveEditorMedia(mediaId, mediaFile);
      clip.file = mediaFile;
      setSequences((current) => current.map((sequence) => {
        if (sequence.id !== targetSequenceId) return sequence;
        const playheadTime = sequence.clips.reduce((total, currentClip) => total + currentClip.trimEnd - currentClip.trimStart, 0);
        return {
          ...sequence,
          clips: [...sequence.clips, clip],
          selectedId: clip.id,
          playheadTime,
        };
      }));
      if (normalizedUrl) {
        setUploadedAssets((current) => current.map((item) => item.id === asset.id
          ? { ...clipAsset, file: mediaFile }
          : item));
        URL.revokeObjectURL(asset.src);
        normalizedUrl = null;
      }
      playbackWanted.current = false;
      setIsPlaying(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add this video.");
    } finally {
      if (normalizedUrl) URL.revokeObjectURL(normalizedUrl);
      setLoadingAssetId("");
      probe.removeAttribute("src");
      probe.load();
    }
  };

  const updateClip = (id: string, changes: Partial<Pick<TimelineClip, "trimStart" | "trimEnd">>) => {
    const clip = clips.find((item) => item.id === id);
    if (!clip) return;
    const trimStart = Math.min(Math.max(0, changes.trimStart ?? clip.trimStart), clip.trimEnd - 0.1);
    const trimEnd = Math.min(clip.duration, Math.max(trimStart + 0.1, changes.trimEnd ?? clip.trimEnd));
    const durationChange = (trimEnd - trimStart) - (clip.trimEnd - clip.trimStart);
    const clipIndex = clips.findIndex((item) => item.id === id);
    const selectedIndex = clips.findIndex((item) => item.id === selectedClip?.id);

    setClips((current) => current.map((item) => item.id === id ? { ...item, trimStart, trimEnd } : item));

    if (selectedClip?.id === id) {
      const currentTime = previewRef.current?.currentTime ?? clip.trimStart;
      const nextTime = Math.min(Math.max(currentTime, trimStart), trimEnd);
      if (previewRef.current) previewRef.current.currentTime = nextTime;
      setPlayheadTime(getClipOffset(id) + nextTime - trimStart);
    } else if (clipIndex < selectedIndex) {
      setPlayheadTime((current) => Math.max(0, current + durationChange));
    }
  };

  const splitClipAt = (clipId: string, clientX: number, element: HTMLElement) => {
    if (isExporting) return;
    const clip = clips.find((item) => item.id === clipId);
    if (!clip) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
    const splitTime = clip.trimStart + fraction * (clip.trimEnd - clip.trimStart);
    if (splitTime - clip.trimStart < 0.1 || clip.trimEnd - splitTime < 0.1) return;

    const offset = getClipOffset(clipId);
    const leftClip: TimelineClip = {
      ...clip,
      id: `${clip.id}-left-${crypto.randomUUID()}`,
      trimEnd: splitTime,
    };
    const rightClip: TimelineClip = {
      ...clip,
      id: `${clip.id}-right-${crypto.randomUUID()}`,
      trimStart: splitTime,
    };
    playbackWanted.current = false;
    previewRef.current?.pause();
    setIsPlaying(false);
    setClips((current) => current.flatMap((item) => item.id === clipId ? [leftClip, rightClip] : [item]));
    setSelectedId(rightClip.id);
    pendingSeek.current = { id: rightClip.id, time: splitTime };
    setPlayheadTime(offset + splitTime - clip.trimStart);
    setClipContextMenu(null);
  };

  const startTrimDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    clip: TimelineClip,
    edge: ClipTrimDrag["edge"],
  ) => {
    if (isExporting) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    trimDrag.current = {
      clipId: clip.id,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
    };
    playbackWanted.current = false;
    previewRef.current?.pause();
    setIsPlaying(false);
    selectClip(clip.id);
  };

  const moveTrimDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = trimDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = (event.clientX - drag.startX) / 72;
    if (drag.edge === "start") {
      updateClip(drag.clipId, { trimStart: drag.trimStart + delta });
    } else {
      updateClip(drag.clipId, { trimEnd: drag.trimEnd + delta });
    }
  };

  const stopTrimDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (trimDrag.current?.pointerId !== event.pointerId) return;
    trimDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const nudgeTrim = (clip: TimelineClip, edge: ClipTrimDrag["edge"], direction: -1 | 1) => {
    updateClip(clip.id, edge === "start"
      ? { trimStart: clip.trimStart + direction * 0.1 }
      : { trimEnd: clip.trimEnd + direction * 0.1 });
  };

  const setClipOrder = (reordered: TimelineClip[]) => {
    setClips(reordered);
    const active = reordered.find((clip) => clip.id === selectedId) ?? reordered[0];
    if (!active) {
      setPlayheadTime(0);
      return;
    }
    const index = reordered.findIndex((clip) => clip.id === active.id);
    const offset = reordered.slice(0, index).reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0);
    const localTime = active.id === selectedId && previewRef.current
      ? Math.min(Math.max(0, previewRef.current.currentTime - active.trimStart), active.trimEnd - active.trimStart)
      : 0;
    setPlayheadTime(offset + localTime);
  };

  const moveClip = (id: string, offset: -1 | 1) => {
    const index = clips.findIndex((clip) => clip.id === id);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= clips.length) return;
    const reordered = [...clips];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    setClipOrder(reordered);
  };

  const moveClipTo = (id: string, targetIndex: number) => {
    const sourceIndex = clips.findIndex((clip) => clip.id === id);
    if (sourceIndex < 0 || sourceIndex === targetIndex) return;
    const reordered = [...clips];
    const [clip] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, clip);
    setClipOrder(reordered);
  };

  const startClipReorder = (event: ReactPointerEvent<HTMLButtonElement>, clipId: string) => {
    if (isExporting || activeTool !== "select" || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    reorderDrag.current = {
      clipId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  };

  const moveClipReorder = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = reorderDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 5) {
      drag.dragging = true;
      suppressClipClick.current = true;
      playbackWanted.current = false;
      previewRef.current?.pause();
      setIsPlaying(false);
      selectClip(drag.clipId);
      setDraggingClipId(drag.clipId);
    }
  };

  const finishClipReorder = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = reorderDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    reorderDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.dragging) return;

    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-clip-id]");
    const targetId = target?.dataset.clipId;
    if (targetId && targetId !== drag.clipId) {
      const targetIndex = clips.findIndex((clip) => clip.id === targetId);
      const bounds = target?.getBoundingClientRect();
      if (targetIndex >= 0 && bounds) {
        moveClipTo(drag.clipId, targetIndex + (event.clientX >= bounds.left + bounds.width / 2 ? 1 : 0));
      }
    }
    setDraggingClipId("");
    window.setTimeout(() => {
      suppressClipClick.current = false;
    }, 0);
  };

  const removeClip = (id: string) => {
    const index = clips.findIndex((clip) => clip.id === id);
    const next = clips.filter((clip) => clip.id !== id);
    const nextSelected = selectedId === id
      ? next[Math.min(index, next.length - 1)]
      : next.find((clip) => clip.id === selectedId) ?? next[Math.min(index, next.length - 1)];
    const nextSelectedIndex = nextSelected ? next.findIndex((clip) => clip.id === nextSelected.id) : -1;
    const nextOffset = next.slice(0, Math.max(0, nextSelectedIndex))
      .reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0);
    if (nextSelected) {
      const currentTime = nextSelected.id === selectedId && previewRef.current
        ? previewRef.current.currentTime
        : nextSelected.trimStart;
      pendingSeek.current = { id: nextSelected.id, time: currentTime };
    } else {
      pendingSeek.current = null;
    }
    setSelectedId(nextSelected?.id ?? "");
    setPlayheadTime(nextOffset + (nextSelected && nextSelected.id === selectedId && previewRef.current
      ? Math.min(Math.max(0, previewRef.current.currentTime - nextSelected.trimStart), nextSelected.trimEnd - nextSelected.trimStart)
      : 0));
    setClips(next);
    setClipContextMenu(null);
    playbackWanted.current = false;
    setIsPlaying(false);
    previewRef.current?.pause();
    window.requestAnimationFrame(() => clipButtonRefs.current.get(nextSelected?.id ?? "")?.focus());
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && clipContextMenu) {
      setClipContextMenu(null);
      return;
    }
    if ((event.key !== "Delete" && event.key !== "Backspace") || !selectedClip || isExporting) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    removeClip(selectedClip.id);
  };

  const addUploads = useCallback(async (files: FileList | File | null, includeImages = false) => {
    if (!files) return false;
    const selectedFiles = files instanceof File ? [files] : Array.from(files);
    const accepted = selectedFiles.filter((file) => file.type.startsWith("video/")
      || (includeImages && file.type.startsWith("image/")));
    if (accepted.length !== selectedFiles.length) setError("Only video files can be added to the editor.");
    try {
      const nextAssets = await Promise.all(accepted.map(async (file) => {
        if (file.size > 512 * 1024 * 1024) {
          throw new Error(`"${file.name}" is larger than the 512 MB editor-storage limit.`);
        }
        const id = `upload-${crypto.randomUUID()}`;
        await saveEditorMedia(id, file);
        return {
          id,
          name: file.name,
          src: URL.createObjectURL(file),
          file,
          mediaId: id,
        };
      }));
      setUploadedAssets((current) => [...current, ...nextAssets]);
      setPersistenceError("");
      return accepted.length === selectedFiles.length && accepted.length > 0;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not save uploaded media.";
      setPersistenceError(message);
      setPersistenceStatus("Editor save failed");
      throw caught;
    }
  }, []);

  const focusUploads = useCallback(() => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      uploadsHeadingRef.current?.scrollIntoView({ block: "nearest" });
      uploadsHeadingRef.current?.focus({ preventScroll: true });
    }));
  }, []);

  useEffect(() => registerEditorUploadBridge(async (file) => {
    if (!await addUploads(file, true)) throw new Error("The editor accepts image and video files only.");
  }, focusUploads), [addUploads, focusUploads]);

  const getClipOffset = (id: string) => {
    const index = clips.findIndex((clip) => clip.id === id);
    return clips.slice(0, Math.max(0, index)).reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0);
  };

  const selectClip = (clipId: string) => {
    const clip = clips.find((item) => item.id === clipId);
    if (!clip) return;
    playbackWanted.current = false;
    setIsPlaying(false);
    previewRef.current?.pause();
    setPlayheadTime(getClipOffset(clipId)
      + (selectedId === clipId && previewRef.current
        ? Math.min(Math.max(0, previewRef.current.currentTime - clip.trimStart), clip.trimEnd - clip.trimStart)
        : 0));
    if (selectedId !== clipId) pendingSeek.current = { id: clip.id, time: clip.trimStart };
    setSelectedId(clipId);
  };

  const seekTimeline = (time: number) => {
    if (clips.length === 0) return;
    const boundedTime = Math.min(Math.max(0, time), totalDuration);
    let elapsed = 0;
    let targetClip = clips[clips.length - 1];
    let targetTime = targetClip.trimEnd;
    for (const clip of clips) {
      const clipLength = clip.trimEnd - clip.trimStart;
      if (boundedTime < elapsed + clipLength) {
        targetClip = clip;
        targetTime = clip.trimStart + boundedTime - elapsed;
        break;
      }
      elapsed += clipLength;
    }

    playbackWanted.current = false;
    setIsPlaying(false);
    previewRef.current?.pause();
    setPlayheadTime(boundedTime);
    if (targetClip.id !== selectedClip?.id) {
      pendingSeek.current = { id: targetClip.id, time: targetTime };
      setSelectedId(targetClip.id);
    } else if (previewRef.current) {
      previewRef.current.currentTime = targetTime;
    }
  };

  const handleTimeUpdate = () => {
    const video = previewRef.current;
    if (!video || !selectedClip) return;
    setPlayheadTime(getClipOffset(selectedClip.id)
      + Math.min(Math.max(0, video.currentTime - selectedClip.trimStart), selectedClip.trimEnd - selectedClip.trimStart));
    if (!playbackWanted.current || advancing.current
      || (!video.ended && video.currentTime < selectedClip.trimEnd - 0.05)) return;
    advancing.current = true;
    const index = clips.findIndex((clip) => clip.id === selectedClip.id);
    const next = clips[index + 1];
    if (!next) {
      playbackWanted.current = false;
      setIsPlaying(false);
      video.pause();
      video.currentTime = selectedClip.trimEnd;
    } else {
      setPlayheadTime(getClipOffset(selectedClip.id) + selectedClip.trimEnd - selectedClip.trimStart);
      pendingSeek.current = { id: next.id, time: next.trimStart };
      setSelectedId(next.id);
    }
    window.setTimeout(() => {
      advancing.current = false;
    }, 100);
  };

  const togglePlayback = async () => {
    const video = previewRef.current;
    if (!video || !selectedClip || isExporting) return;
    setError("");
    if (playbackWanted.current) {
      playbackWanted.current = false;
      setIsPlaying(false);
      video.pause();
      return;
    }
    playbackWanted.current = true;
    setIsPlaying(true);
    if (video.currentTime < selectedClip.trimStart || video.currentTime >= selectedClip.trimEnd) {
      video.currentTime = selectedClip.trimStart;
    }
    try {
      await video.play();
    } catch {
      playbackWanted.current = false;
      setIsPlaying(false);
      setError("The browser could not play this video.");
    }
  };

  const exportVideo = async (format: "mov" | "mp4") => {
    if (clips.length === 0 || !activeSequence) return;
    setError("");
    playbackWanted.current = false;
    previewRef.current?.pause();
    setIsPlaying(false);
    setIsExporting(true);
    setExportingFormat(format);
    setExportStage("Preparing clips for upload…");

    try {
      const formData = new FormData();
      formData.append("format", format);
      formData.append("timeline", JSON.stringify(clips.map(({ trimStart, trimEnd }) => ({
        start: trimStart,
        end: trimEnd,
      }))));

      for (const clip of clips) {
        let response: Response;
        try {
          response = await fetch(clip.src);
        } catch {
          throw new Error(`Could not read "${clip.name}" in this browser. Download the video and upload it from your device before exporting.`);
        }
        if (!response.ok) {
          throw new Error(`Could not read "${clip.name}" (${response.status}). Download the video and upload it from your device before exporting.`);
        }
        const video = await response.blob();
        if (video.size === 0) throw new Error(`"${clip.name}" is empty and cannot be exported.`);
        formData.append("clip", video, clip.name);
      }

      setExportStage(`Uploading clips and rendering H.264 ${format.toUpperCase()} on the server…`);
      const response = await fetch("/api/video/export", { method: "POST", body: formData });
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error(`Video export failed (${response.status}). Check the server's FFmpeg setup and upload limits.`);
        }
        const message = typeof payload === "object" && payload !== null
          && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Video export failed (${response.status}).`;
        throw new Error(message);
      }

      const blob = await response.blob();
      if (blob.size === 0) throw new Error("The server returned an empty export.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const safeName = activeSequence.name.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "sequence";
      link.download = `${safeName}.${format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${format.toUpperCase()} export failed.`);
    } finally {
      setIsExporting(false);
      setExportingFormat(null);
      setExportStage("");
    }
  };

  return (
    <section className="ff-editor-layout" hidden={hidden} onKeyDown={handleEditorKeyDown} onClick={() => clipContextMenu && setClipContextMenu(null)}>
      <aside className="ff-editor-sidebar">
        <div className="ff-editor-heading">
          <span className="ff-overline">VIDEO EDITOR</span>
          <h1>Make a cut</h1>
          <p>Arrange clips, trim the start and end, then export H.264 MOV or MP4 files.</p>
        </div>

        <section className="ff-editor-media">
          <div className="ff-editor-section-heading">
            <h2>Workflow videos</h2>
            <span>{assets.length}</span>
          </div>
          {assets.length === 0 && <p className="ff-editor-empty">Run a video node in your workflow to add generated clips here.</p>}
          {assets.map((asset) => (
            <button className="ff-editor-asset" key={asset.id} onClick={() => void addAsset(asset)} disabled={isExporting || Boolean(loadingAssetId)}>
              <span aria-hidden="true">▶</span>
              <span>{asset.name}</span>
              <strong>+</strong>
            </button>
          ))}
        </section>

        <section className="ff-editor-media">
          <div className="ff-editor-section-heading">
            <h2 ref={uploadsHeadingRef} tabIndex={-1}>Footage</h2>
            <label className="ff-editor-upload">
              Add files
              <input
                type="file"
                accept="video/*"
                multiple
                onChange={(event) => {
                  void addUploads(event.target.files).catch((caught: unknown) => {
                    setError(caught instanceof Error ? caught.message : "Could not save uploaded media.");
                  });
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          {uploadedAssets.map((asset) => (
            asset.file?.type.startsWith("image/") ? (
              <div className="ff-editor-asset" key={asset.id} title="Images are available in Uploads; the timeline accepts video clips.">
                <img className="ff-editor-upload-thumbnail" src={asset.src} alt="" />
                <span>{asset.name}</span>
                <strong aria-hidden="true">IMG</strong>
              </div>
            ) : (
              <button className="ff-editor-asset" key={asset.id} onClick={() => void addAsset(asset)} disabled={isExporting || Boolean(loadingAssetId)}>
                <span aria-hidden="true">▣</span>
                <span>{loadingAssetId === asset.id ? "Preparing video…" : asset.name}</span>
                <strong>+</strong>
              </button>
            )
          ))}
          {uploadedAssets.length === 0 && <p className="ff-editor-empty">Upload video clips from this device.</p>}
        </section>

        <p className="ff-editor-sidebar-note">Footage, sequences, and timeline edits are saved in this browser. MOV and MP4 exports use H.264 video and AAC audio.</p>
      </aside>

      <div className="ff-editor-workspace">
        <div className="ff-editor-preview">
          {selectedClip ? (
            <video
              key={selectedClip.id}
              ref={previewRef}
              src={selectedClip.src}
              playsInline
              onCanPlay={(event) => {
                const video = event.currentTarget;
                if (!selectedClip) return;
                const pending = pendingSeek.current;
                if (pending?.id === selectedClip.id) {
                  video.currentTime = pending.time;
                  pendingSeek.current = null;
                } else if (video.currentTime < selectedClip.trimStart || video.currentTime >= selectedClip.trimEnd) {
                  video.currentTime = selectedClip.trimStart;
                }
                setPlayheadTime(getClipOffset(selectedClip.id) + video.currentTime - selectedClip.trimStart);
                if (playbackWanted.current) void video.play().catch(() => setError("The browser could not play this video."));
              }}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleTimeUpdate}
              onError={() => setError("Could not load this video. Check that the file or source URL is available.")}
            />
          ) : (
            <div className="ff-editor-preview-empty">
              <span aria-hidden="true">▶</span>
              <strong>Your timeline preview</strong>
              <p>Add a generated video or upload a clip to begin.</p>
            </div>
          )}
          {selectedClip && (
            <div className="ff-editor-preview-controls">
              <button type="button" className="ff-editor-play" onClick={() => void togglePlayback()} disabled={isExporting}>
                {isPlaying ? "Pause" : "Play"}
              </button>
              <span>{selectedClip.name}</span>
              <span>{formatTime(selectedClip.trimStart)} – {formatTime(selectedClip.trimEnd)}</span>
            </div>
          )}
        </div>

        <div className="ff-editor-timeline">
          <div className="ff-editor-timeline-heading">
            <div>
              <span className="ff-editor-sequence-label">Sequence</span>
              <select
                className="ff-editor-sequence-select"
                aria-label="Active sequence"
                value={activeSequenceId}
                disabled={isExporting}
                onChange={(event) => switchSequence(event.target.value)}
              >
                {sequences.map((sequence) => (
                  <option key={sequence.id} value={sequence.id}>{sequence.name}</option>
                ))}
              </select>
              <label className="ff-editor-sequence-name-label" htmlFor="ff-editor-sequence-name">Name</label>
              <input
                className="ff-editor-sequence-name"
                id="ff-editor-sequence-name"
                aria-label="Rename active sequence"
                value={activeSequence?.name ?? ""}
                disabled={isExporting}
                onChange={(event) => renameSequence(event.target.value)}
                onBlur={(event) => {
                  if (!event.currentTarget.value.trim()) renameSequence("Sequence");
                }}
              />
              <button
                type="button"
                className="ff-editor-sequence-action"
                onClick={createSequence}
                disabled={isExporting}
              >
                + New
              </button>
              <button
                type="button"
                className="ff-editor-sequence-action ff-editor-sequence-delete"
                onClick={deleteSequence}
                disabled={isExporting || sequences.length <= 1}
                title={sequences.length <= 1 ? "Keep at least one sequence" : "Delete active sequence"}
              >
                Delete
              </button>
              <span>{clips.length} clips · {formatTime(totalDuration)} · {formatTime(playheadTime)}</span>
              <div className="ff-editor-tools" role="group" aria-label="Timeline tools">
                <button
                  type="button"
                  className="ff-editor-tool"
                  aria-label="Selection tool"
                  aria-pressed={activeTool === "select"}
                  title="Selection tool"
                  disabled={isExporting}
                  onClick={() => setActiveTool("select")}
                >
                  <span aria-hidden="true">↖</span>
                </button>
                <button
                  type="button"
                  className="ff-editor-tool"
                  aria-label="Razor tool"
                  aria-pressed={activeTool === "razor"}
                  title="Razor tool: click a clip to split it"
                  disabled={isExporting}
                  onClick={() => setActiveTool("razor")}
                >
                  <span aria-hidden="true">✂</span>
                </button>
                <button
                  type="button"
                  className="ff-editor-tool"
                  aria-label="Ripple delete selected clip"
                  title="Ripple delete selected clip"
                  disabled={!selectedClip || isExporting}
                  onClick={() => selectedClip && removeClip(selectedClip.id)}
                >
                  <span aria-hidden="true">⌫</span>
                </button>
              </div>
            </div>
            <div className="ff-editor-export-actions">
              <button type="button" className="ff-run" onClick={() => void exportVideo("mov")} disabled={clips.length === 0 || isExporting}>
                {isExporting && exportingFormat === "mov" ? "Rendering MOV…" : "Export MOV"}
              </button>
              <button
                type="button"
                className="ff-editor-sequence-action ff-editor-export-secondary"
                onClick={() => void exportVideo("mp4")}
                disabled={clips.length === 0 || isExporting}
              >
                {isExporting && exportingFormat === "mp4" ? "Rendering MP4…" : "Export MP4"}
              </button>
            </div>
          </div>
          <p className="ff-editor-instructions">
            Create sequences with + New. Add videos with + to the active sequence; rename or switch sequences here. Choose the Razor tool and click a clip to split it. Use Ripple delete to remove the selected clip and close the gap. Drag a clip&apos;s edge to trim its start or end, or use the In and Out fields for exact times. Drag clips to reorder; right-click or select a clip and press Delete to remove it. Exports are H.264 MOV or MP4 at 1280 × 720 with AAC audio.
          </p>
          {isExporting && (
            <div className="ff-editor-export-status" role="status" aria-live="polite">
              <span className="ff-editor-export-spinner" />
              {exportStage}
            </div>
          )}
          {error && <p className="ff-editor-error" role="alert">{error}</p>}
          {clips.length === 0 ? (
            <p className="ff-editor-empty ff-editor-timeline-empty">This sequence is empty. Add videos with + from the media list.</p>
          ) : (
            <div className="ff-editor-track-scroll">
              <div className="ff-editor-track" style={{ width: `${Math.max(totalDuration * 72, 1)}px` }}>
                <div className="ff-editor-ruler" aria-label="Timeline ruler">
                  {Array.from(
                    { length: Math.floor(totalDuration / (totalDuration > 30 ? 5 : 1)) + 1 },
                    (_, index) => index * (totalDuration > 30 ? 5 : 1),
                  ).map((time) => (
                    <span
                      className="ff-editor-ruler-tick"
                      key={time}
                      style={{ left: `${(time / totalDuration) * 100}%` }}
                    >
                      <span>{formatTime(time)}</span>
                    </span>
                  ))}
                  <input
                    className="ff-editor-scrubber"
                    type="range"
                    aria-label="Timeline playhead"
                    aria-valuetext={formatTime(playheadTime)}
                    min="0"
                    max={totalDuration}
                    step="0.01"
                    value={Math.min(playheadTime, totalDuration)}
                    disabled={isExporting}
                    onChange={(event) => seekTimeline(Number(event.target.value))}
                  />
                </div>
                <div
                  className="ff-editor-playhead"
                  style={{ left: `${(playheadTime / totalDuration) * 100}%` }}
                  aria-hidden="true"
                />
                <ol className="ff-editor-clip-list">
                  {clips.map((clip, index) => (
                    <li
                      className={clip.id === selectedClip?.id ? "ff-editor-clip ff-editor-clip-active" : "ff-editor-clip"}
                      key={clip.id}
                      data-clip-id={clip.id}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        playbackWanted.current = false;
                        setIsPlaying(false);
                        previewRef.current?.pause();
                        selectClip(clip.id);
                        setClipContextMenu({
                          clipId: clip.id,
                          x: Math.max(8, Math.min(event.clientX, window.innerWidth - 168)),
                          y: Math.max(8, Math.min(event.clientY, window.innerHeight - 52)),
                        });
                      }}
                      style={{ flexBasis: `${((clip.trimEnd - clip.trimStart) / totalDuration) * 100}%` }}
                      data-dragging={draggingClipId === clip.id || undefined}
                    >
                      <div className="ff-editor-clip-trim-bar" aria-label={`${clip.name} trim handles`}>
                        <button
                          type="button"
                          className="ff-editor-trim-handle ff-editor-trim-handle-start"
                          aria-label={`Trim start of ${clip.name}`}
                          title="Drag to trim the start"
                          disabled={isExporting}
                          onPointerDown={(event) => startTrimDrag(event, clip, "start")}
                          onPointerMove={moveTrimDrag}
                          onPointerUp={stopTrimDrag}
                          onPointerCancel={stopTrimDrag}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                              event.preventDefault();
                              nudgeTrim(clip, "start", event.key === "ArrowLeft" ? -1 : 1);
                            }
                          }}
                        />
                        <span className="ff-editor-trim-bar-fill" />
                        <button
                          type="button"
                          className="ff-editor-trim-handle ff-editor-trim-handle-end"
                          aria-label={`Trim end of ${clip.name}`}
                          title="Drag to trim the end"
                          disabled={isExporting}
                          onPointerDown={(event) => startTrimDrag(event, clip, "end")}
                          onPointerMove={moveTrimDrag}
                          onPointerUp={stopTrimDrag}
                          onPointerCancel={stopTrimDrag}
                          onKeyDown={(event) => {
                            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                              event.preventDefault();
                              nudgeTrim(clip, "end", event.key === "ArrowLeft" ? -1 : 1);
                            }
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className={`ff-editor-clip-select${activeTool === "razor"
                          ? " ff-editor-clip-select-razor"
                          : " ff-editor-clip-select-draggable"}`}
                        draggable={false}
                        ref={(element) => {
                          if (element) clipButtonRefs.current.set(clip.id, element);
                          else clipButtonRefs.current.delete(clip.id);
                        }}
                        onPointerDown={(event) => startClipReorder(event, clip.id)}
                        onPointerMove={moveClipReorder}
                        onPointerUp={finishClipReorder}
                        onPointerCancel={finishClipReorder}
                        onClick={(event) => {
                          if (suppressClipClick.current) {
                            suppressClipClick.current = false;
                            return;
                          }
                          if (activeTool === "razor") {
                            splitClipAt(clip.id, event.clientX, event.currentTarget.parentElement ?? event.currentTarget);
                          } else {
                            selectClip(clip.id);
                          }
                        }}
                      >
                        <span className="ff-editor-clip-number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="ff-editor-clip-name">{clip.name}</span>
                        <span className="ff-editor-clip-duration">{formatTime(clip.trimEnd - clip.trimStart)}</span>
                      </button>
                      <div className="ff-editor-trim">
                        <label>
                          In
                          <input
                            type="number"
                            min="0"
                            max={Math.max(0, clip.trimEnd - 0.1)}
                            step="0.1"
                            value={clip.trimStart.toFixed(1)}
                            disabled={isExporting}
                            onChange={(event) => updateClip(clip.id, { trimStart: Number(event.target.value) })}
                          />
                          s
                        </label>
                        <label>
                          Out
                          <input
                            type="number"
                            min={clip.trimStart + 0.1}
                            max={clip.duration}
                            step="0.1"
                            value={clip.trimEnd.toFixed(1)}
                            disabled={isExporting}
                            onChange={(event) => updateClip(clip.id, { trimEnd: Number(event.target.value) })}
                          />
                          s
                        </label>
                      </div>
                      <div className="ff-editor-clip-actions">
                        <button type="button" aria-label={`Move ${clip.name} up`} title="Move up" onClick={() => moveClip(clip.id, -1)} disabled={index === 0 || isExporting}>↑</button>
                        <button type="button" aria-label={`Move ${clip.name} down`} title="Move down" onClick={() => moveClip(clip.id, 1)} disabled={index === clips.length - 1 || isExporting}>↓</button>
                        <button type="button" aria-label={`Remove ${clip.name}`} title="Remove clip" onClick={() => removeClip(clip.id)} disabled={isExporting}>×</button>
                      </div>
                    </li>
                  ))}
                </ol>
                {clipContextMenu && clips.some((clip) => clip.id === clipContextMenu.clipId) && (
                  <div
                    className="ff-editor-context-menu"
                    role="menu"
                    style={{ left: clipContextMenu.x, top: clipContextMenu.y }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      autoFocus
                      onClick={() => removeClip(clipContextMenu.clipId)}
                    >
                      Delete clip
                      <span>Delete</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          <p className="ff-editor-footer" role="status" aria-live="polite">{persistenceStatus}</p>
          {(persistenceError || persistenceValidationError) && (
            <p className="ff-editor-error" role="alert">{persistenceError || persistenceValidationError}</p>
          )}
          <p className="ff-editor-footer">Server export requires FFmpeg with libx264 installed. Clips are uploaded for rendering and removed from the server afterward; keep this tab open until the download starts.</p>
        </div>
      </div>
    </section>
  );
}
