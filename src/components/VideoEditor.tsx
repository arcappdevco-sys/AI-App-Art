"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { registerEditorUploadBridge } from "@/lib/editor-upload-bridge";
import {
  deleteEditorMedia,
  loadEditorMedia,
  loadVideoEditorState,
  reconcileEditorMedia,
  saveEditorMedia,
  saveVideoEditorState,
  type StoredEditorKeyer,
  type StoredEditorTransition,
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
  audioWaveform?: number[] | null;
  keyer?: StoredEditorKeyer;
};

type TimelineAudioClip = VideoAsset & {
  duration: number;
  start: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
};

type TimelineTransition = StoredEditorTransition;

type VideoSequence = {
  id: string;
  name: string;
  clips: TimelineClip[];
  audioClips: TimelineAudioClip[];
  transitions: TimelineTransition[];
  selectedId: string;
  playheadTime: number;
};

type EditorHistorySnapshot = {
  sequences: VideoSequence[];
  uploadedAssets: VideoAsset[];
  activeSequenceId: string;
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

type EditorTool = "select" | "razor" | "transition";
type KeyerViewChannel = "rgb" | "red" | "green" | "blue" | "alpha";
const EDITOR_HISTORY_LIMIT = 50;
const DEFAULT_KEYER: StoredEditorKeyer = {
  enabled: false,
  color: "#00ff00",
  similarity: 0.28,
  softness: 0.2,
  spillSuppression: 0,
};

function isKeyerViewChannel(value: string): value is KeyerViewChannel {
  return value === "rgb" || value === "red" || value === "green" || value === "blue" || value === "alpha";
}

type ClipReorderDrag = {
  clipId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

type TransitionResizeDrag = {
  leftClipId: string;
  edge: "start" | "end";
  pointerId: number;
  startX: number;
  duration: number;
  snapshot: EditorHistorySnapshot;
};

function getClipTimelineOffset(clips: TimelineClip[], transitions: TimelineTransition[], clipId: string) {
  const index = clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return 0;
  const overlap = transitions.reduce((total, transition) => {
    const leftIndex = clips.findIndex((clip) => clip.id === transition.leftClipId);
    return leftIndex >= 0 && leftIndex < index && clips[leftIndex + 1]?.id === transition.rightClipId
      ? total + transition.duration
      : total;
  }, 0);
  return clips.slice(0, index).reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0) - overlap;
}

function getSequenceTimelineDuration(clips: TimelineClip[], transitions: TimelineTransition[]) {
  return clips.reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0)
    - transitions.reduce((total, transition) => {
      const leftIndex = clips.findIndex((clip) => clip.id === transition.leftClipId);
      return leftIndex >= 0 && clips[leftIndex + 1]?.id === transition.rightClipId
        ? total + transition.duration
        : total;
    }, 0);
}

function getSnapshotMedia(snapshot: EditorHistorySnapshot) {
    const media = new Map<string, File>();
    const addMedia = (asset: VideoAsset) => {
      if (asset.mediaId && asset.file) media.set(asset.mediaId, asset.file);
    };
    snapshot.uploadedAssets.forEach(addMedia);
    snapshot.sequences.forEach((sequence) => {
      sequence.clips.forEach(addMedia);
      sequence.audioClips.forEach(addMedia);
    });
    return media;
}

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

async function getSourceAudioWaveform(file: File): Promise<number[] | null> {
  const formData = new FormData();
  formData.append("clip", file, file.name);
  const response = await fetch("/api/video/waveform", { method: "POST", body: formData });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Could not analyze the audio in "${file.name}" (${response.status}).`);
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null
      && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Could not analyze the audio in "${file.name}" (${response.status}).`;
    throw new Error(message);
  }
  if (typeof payload !== "object" || payload === null || !("waveform" in payload)) {
    throw new Error(`The server returned invalid audio analysis for "${file.name}".`);
  }
  const waveform: unknown = payload.waveform;
  if (waveform === null) return null;
  if (!Array.isArray(waveform)
    || !waveform.every((sample: unknown) => typeof sample === "number" && Number.isFinite(sample))) {
    throw new Error(`The server returned invalid audio analysis for "${file.name}".`);
  }
  return waveform;
}

function loadAudioMetadata(audio: HTMLAudioElement, src: string) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not read this audio file's duration."));
    };
    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    audio.src = src;
    audio.load();
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
    { id: "sequence-1", name: "Sequence 1", clips: [], audioClips: [], transitions: [], selectedId: "", playheadTime: 0 },
  ]);
  const [activeSequenceId, setActiveSequenceId] = useState("sequence-1");
  const [activeTool, setActiveTool] = useState<EditorTool>("select");
  const [selectedTransitionId, setSelectedTransitionId] = useState("");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [persistenceStatus, setPersistenceStatus] = useState("Restoring editor…");
  const [persistenceError, setPersistenceError] = useState("");
  const [draggingClipId, setDraggingClipId] = useState("");
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenu | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [keyerViewChannel, setKeyerViewChannel] = useState<KeyerViewChannel>("rgb");
  const [isExporting, setIsExporting] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<"mov" | "mp4" | "png" | null>(null);
  const [exportStage, setExportStage] = useState("");
  const [loadingAssetId, setLoadingAssetId] = useState("");
  const [loadingAudioAssetId, setLoadingAudioAssetId] = useState("");
  const [removingFootageId, setRemovingFootageId] = useState("");
  const [isRestoringHistory, setIsRestoringHistory] = useState(false);
  const [error, setError] = useState("");
  const previewRef = useRef<HTMLVideoElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const keyerCanvasRef = useRef<HTMLCanvasElement>(null);
  const transitionPreviewRef = useRef<HTMLVideoElement>(null);
  const audioElements = useRef(new Map<string, HTMLAudioElement>());
  const playbackWanted = useRef(false);
  const advancing = useRef(false);
  const pendingSeek = useRef<{ id: string; time: number } | null>(null);
  const clipButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const trimDrag = useRef<ClipTrimDrag | null>(null);
  const reorderDrag = useRef<ClipReorderDrag | null>(null);
  const transitionResizeDrag = useRef<TransitionResizeDrag | null>(null);
  const suppressClipClick = useRef(false);
  const uploadsHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorSnapshotRef = useRef<EditorHistorySnapshot>({
    sequences,
    uploadedAssets,
    activeSequenceId,
  });
  const undoStack = useRef<EditorHistorySnapshot[]>([]);
  const redoStack = useRef<EditorHistorySnapshot[]>([]);
  const historyRestoreInProgress = useRef(false);
  const renameStart = useRef<{ snapshot: EditorHistorySnapshot; sequenceId: string; name: string } | null>(null);
  const audioEditStart = useRef<EditorHistorySnapshot | null>(null);
  const keyerEditStart = useRef<EditorHistorySnapshot | null>(null);
  const unsavedMediaName = uploadedAssets.find((asset) => !asset.mediaId)?.name
    ?? sequences.flatMap((sequence) => [...sequence.clips, ...sequence.audioClips]).find((clip) => !clip.mediaId)?.name;
  const persistenceValidationError = unsavedMediaName ? `Media for "${unsavedMediaName}" is not saved yet.` : "";

  useEffect(() => {
    editorSnapshotRef.current = { sequences, uploadedAssets, activeSequenceId };
  }, [activeSequenceId, sequences, uploadedAssets]);

  const updateHistoryAvailability = useCallback(() => {
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  const recordHistory = useCallback((snapshot = editorSnapshotRef.current) => {
    undoStack.current = [...undoStack.current, snapshot].slice(-EDITOR_HISTORY_LIMIT);
    redoStack.current = [];
    updateHistoryAvailability();
  }, [updateHistoryAvailability]);

  const restoreHistorySnapshot = async (snapshot: EditorHistorySnapshot) => {
    const currentSnapshot = editorSnapshotRef.current;
    const currentMedia = getSnapshotMedia(currentSnapshot);
    const nextMedia = getSnapshotMedia(snapshot);
    await reconcileEditorMedia(currentMedia, nextMedia);

    const currentAssets = new Map(currentSnapshot.uploadedAssets.map((asset) => [asset.id, asset]));
    const restoredAssets = snapshot.uploadedAssets.map((asset) => {
      const currentAsset = currentAssets.get(asset.id);
      return !currentAsset && asset.file
        ? { ...asset, src: URL.createObjectURL(asset.file) }
        : asset;
    });
    const restoredSources = new Set(snapshot.sequences.flatMap((sequence) =>
      [...sequence.clips, ...sequence.audioClips].map((clip) => clip.src)));
    currentSnapshot.uploadedAssets.forEach((asset) => {
      if (!snapshot.uploadedAssets.some((nextAsset) => nextAsset.id === asset.id)
        && !restoredSources.has(asset.src) && asset.src.startsWith("blob:")) {
        URL.revokeObjectURL(asset.src);
      }
    });
    const restoredSnapshot = { ...snapshot, uploadedAssets: restoredAssets };
    playbackWanted.current = false;
    previewRef.current?.pause();
    pauseAudio();
    setIsPlaying(false);
    editorSnapshotRef.current = restoredSnapshot;
    setSequences(restoredSnapshot.sequences);
    setUploadedAssets(restoredSnapshot.uploadedAssets);
    setActiveSequenceId(restoredSnapshot.activeSequenceId);
    setClipContextMenu(null);
    const active = restoredSnapshot.sequences.find((sequence) => sequence.id === restoredSnapshot.activeSequenceId);
    const selected = active?.clips.find((clip) => clip.id === active.selectedId) ?? active?.clips[0];
    if (active && selected) {
      const offset = getClipTimelineOffset(active.clips, active.transitions, selected.id);
      const elapsed = Math.min(
        Math.max(0, active.playheadTime - offset),
        selected.trimEnd - selected.trimStart,
      );
      pendingSeek.current = { id: selected.id, time: selected.trimStart + elapsed };
    } else {
      pendingSeek.current = null;
    }
    setError("");
  };

  const undo = async () => {
    const previous = undoStack.current.at(-1);
    if (!previous || historyRestoreInProgress.current) return;
    historyRestoreInProgress.current = true;
    setIsRestoringHistory(true);
    try {
      const current = editorSnapshotRef.current;
      await restoreHistorySnapshot(previous);
      undoStack.current = undoStack.current.slice(0, -1);
      redoStack.current = [...redoStack.current, current].slice(-EDITOR_HISTORY_LIMIT);
      updateHistoryAvailability();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not restore the previous editor state.";
      setPersistenceError(message);
      setPersistenceStatus("Editor restore failed");
      setError(message);
    } finally {
      historyRestoreInProgress.current = false;
      setIsRestoringHistory(false);
    }
  };

  const redo = async () => {
    const next = redoStack.current.at(-1);
    if (!next || historyRestoreInProgress.current) return;
    historyRestoreInProgress.current = true;
    setIsRestoringHistory(true);
    try {
      const current = editorSnapshotRef.current;
      await restoreHistorySnapshot(next);
      redoStack.current = redoStack.current.slice(0, -1);
      undoStack.current = [...undoStack.current, current].slice(-EDITOR_HISTORY_LIMIT);
      updateHistoryAvailability();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not restore the next editor state.";
      setPersistenceError(message);
      setPersistenceStatus("Editor restore failed");
      setError(message);
    } finally {
      historyRestoreInProgress.current = false;
      setIsRestoringHistory(false);
    }
  };

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
          ...saved.sequences.flatMap((sequence) => [
            ...sequence.clips.map((clip) => clip.mediaId),
            ...(sequence.audioClips ?? []).map((clip) => clip.mediaId),
          ]),
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
          transitions: sequence.transitions ?? [],
          clips: sequence.clips.map((clip) => ({
            ...createAsset(clip.id, clip.name, clip.mediaId),
            duration: clip.duration,
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd,
            audioWaveform: clip.audioWaveform ?? null,
            keyer: clip.keyer,
          })),
          audioClips: (sequence.audioClips ?? []).map((clip) => ({
            ...createAsset(clip.id, clip.name, clip.mediaId),
            duration: clip.duration,
            start: clip.start,
            trimStart: clip.trimStart,
            trimEnd: clip.trimEnd,
            volume: clip.volume,
          })),
        }));
        const nextActiveSequenceId = nextSequences.some((sequence) => sequence.id === saved.activeSequenceId)
          ? saved.activeSequenceId
          : nextSequences[0]?.id ?? "sequence-1";
        const activeSequence = nextSequences.find((sequence) => sequence.id === nextActiveSequenceId);
        const selectedClip = activeSequence?.clips.find((clip) => clip.id === activeSequence.selectedId)
          ?? activeSequence?.clips[0];
        if (activeSequence && selectedClip) {
          const clipOffset = getClipTimelineOffset(activeSequence.clips, activeSequence.transitions, selectedClip.id);
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
        setActiveTool(saved.activeTool === "razor" || saved.activeTool === "transition" ? saved.activeTool : "select");
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
      version: 4,
      sequences: sequences.map((sequence) => ({
        ...sequence,
        transitions: sequence.transitions,
        clips: sequence.clips.map((clip) => ({
          id: clip.id,
          name: clip.name,
          mediaId: clip.mediaId ?? "",
          duration: clip.duration,
          trimStart: clip.trimStart,
          trimEnd: clip.trimEnd,
          audioWaveform: clip.audioWaveform ?? null,
          keyer: clip.keyer,
        })),
        audioClips: sequence.audioClips.map((clip) => ({
          id: clip.id,
          name: clip.name,
          mediaId: clip.mediaId ?? "",
          duration: clip.duration,
          start: clip.start,
          trimStart: clip.trimStart,
          trimEnd: clip.trimEnd,
          volume: clip.volume,
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
  const audioClips = activeSequence?.audioClips ?? [];
  const transitions = activeSequence?.transitions ?? [];
  const selectedId = activeSequence?.selectedId ?? "";
  const playheadTime = activeSequence?.playheadTime ?? 0;
  const setClips = (next: SetStateAction<TimelineClip[]>) => {
    setSequences((current) => current.map((sequence) => {
      if (sequence.id !== activeSequenceId) return sequence;
      const clips = typeof next === "function" ? next(sequence.clips) : next;
      const transitions: TimelineTransition[] = [];
      for (let index = 0; index < clips.length - 1; index += 1) {
        const left = clips[index];
        const right = clips[index + 1];
        const transition = sequence.transitions.find((item) => item.leftClipId === left.id
          && item.rightClipId === right.id);
        if (!transition) continue;
        const incoming = transitions.find((item) => item.rightClipId === left.id);
        const maxDuration = Math.min(
          left.trimEnd - left.trimStart - (incoming?.duration ?? 0),
          right.trimEnd - right.trimStart,
        ) - 0.1;
        if (maxDuration >= 0.1) {
          transitions.push({ ...transition, duration: Math.min(transition.duration, maxDuration) });
        }
      }
      const duration = clips.reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0)
        - transitions.reduce((total, transition) => total + transition.duration, 0);
      const audioClips = duration < 0.1 ? [] : sequence.audioClips.flatMap((clip) => {
        const start = Math.min(clip.start, Math.max(0, duration - 0.1));
        const trimEnd = Math.min(clip.trimEnd, clip.trimStart + duration - start);
        return trimEnd - clip.trimStart >= 0.1 ? [{ ...clip, start, trimEnd }] : [];
      });
      return {
        ...sequence,
        clips,
        audioClips,
        transitions,
        playheadTime: Math.min(sequence.playheadTime, Math.max(0, duration)),
      };
    }));
  };
  const setTransitions = (next: TimelineTransition[]) => {
    setSequences((current) => current.map((sequence) => {
      if (sequence.id !== activeSequenceId) return sequence;
      const transitions: TimelineTransition[] = [];
      for (let index = 0; index < sequence.clips.length - 1; index += 1) {
        const left = sequence.clips[index];
        const right = sequence.clips[index + 1];
        const transition = next.find((item) => item.leftClipId === left.id
          && item.rightClipId === right.id);
        if (!transition || transition.duration < 0.1) continue;
        const incoming = transitions.find((item) => item.rightClipId === left.id);
        const maxDuration = Math.min(
          left.trimEnd - left.trimStart - (incoming?.duration ?? 0),
          right.trimEnd - right.trimStart,
        ) - 0.1;
        if (maxDuration >= 0.1) {
          transitions.push({ ...transition, duration: Math.min(transition.duration, maxDuration) });
        }
      }
      const duration = sequence.clips.reduce((total, clip) => total + clip.trimEnd - clip.trimStart, 0)
        - transitions.reduce((total, transition) => total + transition.duration, 0);
      const audioClips = duration < 0.1 ? [] : sequence.audioClips.flatMap((clip) => {
        const start = Math.min(clip.start, Math.max(0, duration - 0.1));
        const trimEnd = Math.min(clip.trimEnd, clip.trimStart + duration - start);
        return trimEnd - clip.trimStart >= 0.1 ? [{ ...clip, start, trimEnd }] : [];
      });
      const selectedClip = sequence.clips.find((clip) => clip.id === sequence.selectedId);
      const currentOffset = selectedClip
        ? getClipTimelineOffset(sequence.clips, sequence.transitions, selectedClip.id)
        : 0;
      const currentElapsed = selectedClip
        ? Math.min(
          Math.max(0, sequence.playheadTime - currentOffset),
          selectedClip.trimEnd - selectedClip.trimStart,
        )
        : 0;
      return {
        ...sequence,
        transitions,
        audioClips,
        playheadTime: selectedClip
          ? Math.min(
            getClipTimelineOffset(sequence.clips, transitions, selectedClip.id) + currentElapsed,
            Math.max(0, duration),
          )
          : Math.min(sequence.playheadTime, Math.max(0, duration)),
      };
    }));
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
  const totalDuration = Math.max(0, clips.reduce((total, clip) => total + Math.max(0, clip.trimEnd - clip.trimStart), 0)
    - transitions.reduce((total, transition) => total + transition.duration, 0));
  const selectedKeyer = selectedClip ? { ...DEFAULT_KEYER, ...selectedClip.keyer } : DEFAULT_KEYER;
  const hasSelectedClip = Boolean(selectedClip);
  const changePreviewZoom = useCallback((delta: number) => {
    setPreviewZoom((current) => Math.round(Math.min(4, Math.max(0.5, current + delta)) * 10) / 10);
  }, []);

  useEffect(() => {
    const preview = previewContainerRef.current;
    if (!preview || !hasSelectedClip) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      changePreviewZoom(event.deltaY < 0 ? 0.1 : -0.1);
    };
    preview.addEventListener("wheel", handleWheel, { passive: false });
    return () => preview.removeEventListener("wheel", handleWheel);
  }, [changePreviewZoom, hasSelectedClip]);

  useEffect(() => {
    const video = previewRef.current;
    const canvas = keyerCanvasRef.current;
    if (!selectedKeyer.enabled || !video || !canvas) return;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      const errorFrame = window.requestAnimationFrame(() => {
        setError("The browser could not initialize the chroma-key preview.");
      });
      return () => window.cancelAnimationFrame(errorFrame);
    }

    const match = /^#([0-9a-f]{6})$/i.exec(selectedKeyer.color);
    const colorHex = match?.[1] ?? "00ff00";
    const keyColor = [
      Number.parseInt(colorHex.slice(0, 2), 16),
      Number.parseInt(colorHex.slice(2, 4), 16),
      Number.parseInt(colorHex.slice(4, 6), 16),
    ];
    const threshold = Math.min(1, Math.max(0, selectedKeyer.similarity));
    const softness = Math.max(0.005, selectedKeyer.softness);
    const spillSuppression = Math.min(1, Math.max(0, selectedKeyer.spillSuppression));
    const spillChannel = keyColor[2] > keyColor[1] ? 2 : 1;
    const otherChannels = spillChannel === 1 ? [0, 2] : [0, 1];
    let frameRequest = 0;
    let frameFailed = false;

    const renderFrame = () => {
      if (frameFailed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || video.videoWidth === 0 || video.videoHeight === 0) return;

      try {
        const scale = Math.min(1, 960 / video.videoWidth, 540 / video.videoHeight);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.drawImage(video, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        const pixels = image.data;
        const softnessRange = 1 / softness;
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index] - keyColor[0];
          const green = pixels[index + 1] - keyColor[1];
          const blue = pixels[index + 2] - keyColor[2];
          const distance = Math.sqrt(red * red + green * green + blue * blue) / 441.673;
          const amount = Math.min(1, Math.max(0, (distance - threshold) * softnessRange));
          const smoothAmount = amount * amount * (3 - 2 * amount);
          const outputAlpha = Math.round(pixels[index + 3] * smoothAmount);
          if (spillSuppression > 0 && smoothAmount > 0) {
            const spill = Math.max(0, pixels[index + spillChannel] - Math.max(
              pixels[index + otherChannels[0]],
              pixels[index + otherChannels[1]],
            )) * spillSuppression * smoothAmount;
            pixels[index + spillChannel] = Math.max(0, pixels[index + spillChannel] - spill);
            pixels[index + otherChannels[0]] = Math.min(255, pixels[index + otherChannels[0]] + spill / 2);
            pixels[index + otherChannels[1]] = Math.min(255, pixels[index + otherChannels[1]] + spill / 2);
          }
          if (keyerViewChannel === "alpha") {
            pixels[index] = outputAlpha;
            pixels[index + 1] = outputAlpha;
            pixels[index + 2] = outputAlpha;
            pixels[index + 3] = 255;
          } else {
            if (keyerViewChannel !== "rgb") {
              const channelIndex = keyerViewChannel === "red" ? 0 : keyerViewChannel === "green" ? 1 : 2;
              const channel = pixels[index + channelIndex];
              pixels[index] = channel;
              pixels[index + 1] = channel;
              pixels[index + 2] = channel;
            }
            pixels[index + 3] = outputAlpha;
          }
        }
        context.putImageData(image, 0, 0);
      } catch {
        frameFailed = true;
        setError("Could not process this video frame in the browser. Upload the video from this device and try again.");
      }

      if (!frameFailed && !video.paused && !video.ended) {
        frameRequest = window.requestAnimationFrame(renderFrame);
      }
    };

    const startRendering = () => {
      window.cancelAnimationFrame(frameRequest);
      frameRequest = window.requestAnimationFrame(renderFrame);
    };
    const renderPausedFrame = () => {
      window.cancelAnimationFrame(frameRequest);
      renderFrame();
    };

    video.addEventListener("play", startRendering);
    video.addEventListener("pause", renderPausedFrame);
    video.addEventListener("seeked", renderPausedFrame);
    video.addEventListener("loadeddata", renderPausedFrame);
    renderPausedFrame();
    if (!video.paused && !video.ended) startRendering();

    return () => {
      video.removeEventListener("play", startRendering);
      video.removeEventListener("pause", renderPausedFrame);
      video.removeEventListener("seeked", renderPausedFrame);
      video.removeEventListener("loadeddata", renderPausedFrame);
      window.cancelAnimationFrame(frameRequest);
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [
    selectedClip?.id,
    selectedKeyer.color,
    selectedKeyer.enabled,
    selectedKeyer.similarity,
    selectedKeyer.softness,
    selectedKeyer.spillSuppression,
    keyerViewChannel,
  ]);

  const pauseAudio = () => {
    transitionPreviewRef.current?.pause();
    audioElements.current.forEach((audio) => audio.pause());
  };

  const syncAudioPlayback = (timelineTime: number, shouldPlay: boolean) => {
    for (const clip of audioClips) {
      const audio = audioElements.current.get(clip.id);
      if (!audio) continue;
      audio.volume = Math.min(1, Math.max(0, clip.volume));
      const elapsed = timelineTime - clip.start;
      const clipLength = clip.trimEnd - clip.trimStart;
      if (elapsed < 0 || elapsed >= clipLength) {
        audio.pause();
        continue;
      }
      const sourceTime = clip.trimStart + elapsed;
      if (Math.abs(audio.currentTime - sourceTime) > 0.25) audio.currentTime = sourceTime;
      if (shouldPlay && playbackWanted.current) {
        if (audio.paused) void audio.play().catch(() => setError(`Could not play audio "${clip.name}".`));
      } else {
        audio.pause();
      }
    }
  };

  const beginAudioEdit = () => {
    audioEditStart.current = editorSnapshotRef.current;
  };

  const finishAudioEdit = () => {
    const snapshot = audioEditStart.current;
    audioEditStart.current = null;
    if (snapshot && JSON.stringify(snapshot.sequences) !== JSON.stringify(editorSnapshotRef.current.sequences)) {
      recordHistory(snapshot);
    }
  };

  const beginKeyerEdit = () => {
    if (!keyerEditStart.current) keyerEditStart.current = editorSnapshotRef.current;
  };

  const finishKeyerEdit = () => {
    const snapshot = keyerEditStart.current;
    keyerEditStart.current = null;
    if (snapshot && JSON.stringify(snapshot.sequences) !== JSON.stringify(editorSnapshotRef.current.sequences)) {
      recordHistory(snapshot);
    }
  };

  const createSequence = () => {
    const nextNumber = sequences.reduce((highest, sequence) => {
      const match = /^Sequence (\d+)$/.exec(sequence.name);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    const sequence: VideoSequence = {
      id: `sequence-${crypto.randomUUID()}`,
      name: `Sequence ${nextNumber}`,
      clips: [],
      audioClips: [],
      transitions: [],
      selectedId: "",
      playheadTime: 0,
    };
    playbackWanted.current = false;
    previewRef.current?.pause();
    pauseAudio();
    pendingSeek.current = null;
    recordHistory();
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
      const clipOffset = getClipTimelineOffset(nextSequence.clips, nextSequence.transitions, nextClip.id);
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
    pauseAudio();
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
    pauseAudio();
    pendingSeek.current = null;
    recordHistory();
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
      let waveformError = "";
      try {
        clip.audioWaveform = await getSourceAudioWaveform(mediaFile);
      } catch (caught) {
        waveformError = caught instanceof Error ? caught.message : `Could not analyze the audio in "${asset.name}".`;
      }
      const mediaId = clipAsset.mediaId;
      if (!mediaId) throw new Error(`Could not assign persistent storage to "${asset.name}".`);
      await saveEditorMedia(mediaId, mediaFile);
      clip.file = mediaFile;
      const currentSnapshot = editorSnapshotRef.current;
      const historySnapshot = normalizedUrl
        ? {
          ...currentSnapshot,
          uploadedAssets: currentSnapshot.uploadedAssets.map((item) => item.id === asset.id
            ? { ...clipAsset, file: mediaFile }
            : item),
        }
        : currentSnapshot;
      recordHistory(historySnapshot);
      setSequences((current) => current.map((sequence) => {
        if (sequence.id !== targetSequenceId) return sequence;
        const playheadTime = getSequenceTimelineDuration(sequence.clips, sequence.transitions);
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
      setError(waveformError);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add this video.");
    } finally {
      if (normalizedUrl) URL.revokeObjectURL(normalizedUrl);
      setLoadingAssetId("");
      probe.removeAttribute("src");
      probe.load();
    }
  };

  const addAudioAsset = async (asset: VideoAsset) => {
    const file = asset.file;
    if (!file || !file.type.startsWith("audio/")) {
      setError(`"${asset.name}" is not available as a local audio file.`);
      return;
    }
    if (!activeSequence || totalDuration < 0.1) {
      setError("Add a video clip to the active sequence before placing audio.");
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      setError(`"${asset.name}" is too large to export. Audio clips must be 200 MB or smaller.`);
      return;
    }
    setError("");
    setLoadingAudioAssetId(asset.id);
    const probe = document.createElement("audio");
    probe.preload = "metadata";
    try {
      await loadAudioMetadata(probe, asset.src);
      const duration = probe.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`"${asset.name}" does not have a supported duration.`);
      }
      const start = Math.min(Math.max(0, activeSequence.playheadTime), Math.max(0, totalDuration - 0.1));
      const trimEnd = Math.min(duration, totalDuration - start);
      if (trimEnd < 0.1) throw new Error("There is not enough room at the playhead for this audio clip.");
      const clip: TimelineAudioClip = {
        ...asset,
        id: `audio-${crypto.randomUUID()}`,
        duration,
        start,
        trimStart: 0,
        trimEnd,
        volume: 1,
      };
      recordHistory();
      setSequences((current) => current.map((sequence) => sequence.id === activeSequenceId
        ? { ...sequence, audioClips: [...sequence.audioClips, clip] }
        : sequence));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not add "${asset.name}" to the audio track.`);
    } finally {
      setLoadingAudioAssetId("");
      probe.removeAttribute("src");
      probe.load();
    }
  };

  const updateAudioClip = (
    id: string,
    changes: Partial<Pick<TimelineAudioClip, "start" | "trimStart" | "trimEnd" | "volume">>,
  ) => {
    setSequences((current) => current.map((sequence) => {
      if (sequence.id !== activeSequenceId) return sequence;
      const clip = sequence.audioClips.find((item) => item.id === id);
      if (!clip) return sequence;
      const sequenceDuration = sequence.clips.reduce((sum, item) => sum + item.trimEnd - item.trimStart, 0);
      const start = Math.min(Math.max(0, changes.start ?? clip.start), Math.max(0, sequenceDuration - 0.1));
      const trimStart = Math.min(Math.max(0, changes.trimStart ?? clip.trimStart), clip.duration - 0.1);
      const maxTrimEnd = Math.min(clip.duration, trimStart + Math.max(0.1, sequenceDuration - start));
      const trimEnd = Math.min(maxTrimEnd, Math.max(trimStart + 0.1, changes.trimEnd ?? clip.trimEnd));
      const volume = Math.min(1, Math.max(0, changes.volume ?? clip.volume));
      return {
        ...sequence,
        audioClips: sequence.audioClips.map((item) => item.id === id
          ? { ...item, start, trimStart, trimEnd, volume }
          : item),
      };
    }));
  };

  const removeAudioClip = (id: string) => {
    if (!audioClips.some((clip) => clip.id === id)) return;
    recordHistory();
    audioElements.current.get(id)?.pause();
    setSequences((current) => current.map((sequence) => sequence.id === activeSequenceId
      ? { ...sequence, audioClips: sequence.audioClips.filter((clip) => clip.id !== id) }
      : sequence));
  };

  const updateClip = (
    id: string,
    changes: Partial<Pick<TimelineClip, "trimStart" | "trimEnd">>,
    trackHistory = true,
  ) => {
    const clip = clips.find((item) => item.id === id);
    if (!clip) return;
    const trimStart = Math.min(Math.max(0, changes.trimStart ?? clip.trimStart), clip.trimEnd - 0.1);
    const trimEnd = Math.min(clip.duration, Math.max(trimStart + 0.1, changes.trimEnd ?? clip.trimEnd));
    if (trimStart === clip.trimStart && trimEnd === clip.trimEnd) return;
    if (trackHistory) recordHistory();
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

  const updateSelectedClipKeyer = (changes: Partial<StoredEditorKeyer>) => {
    if (!selectedClip) return;
    const keyer = { ...selectedKeyer, ...changes };
    setClips((current) => current.map((clip) => clip.id === selectedClip.id ? { ...clip, keyer } : clip));
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
    recordHistory();
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
    recordHistory();
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
      updateClip(drag.clipId, { trimStart: drag.trimStart + delta }, false);
    } else {
      updateClip(drag.clipId, { trimEnd: drag.trimEnd + delta }, false);
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
    if (reordered.every((clip, index) => clip.id === clips[index]?.id)) return;
    recordHistory();
    setClips(reordered);
    const active = reordered.find((clip) => clip.id === selectedId) ?? reordered[0];
    if (!active) {
      setPlayheadTime(0);
      return;
    }
    const offset = getClipTimelineOffset(reordered, transitions, active.id);
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
    if (index < 0) return;
    recordHistory();
    const next = clips.filter((clip) => clip.id !== id);
    const nextSelected = selectedId === id
      ? next[Math.min(index, next.length - 1)]
      : next.find((clip) => clip.id === selectedId) ?? next[Math.min(index, next.length - 1)];
    const nextOffset = nextSelected
      ? getClipTimelineOffset(next, transitions, nextSelected.id)
      : 0;
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
    pauseAudio();
    window.requestAnimationFrame(() => clipButtonRefs.current.get(nextSelected?.id ?? "")?.focus());
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && clipContextMenu) {
      setClipContextMenu(null);
      return;
    }
    const target = event.target;
    const isEditingText = target instanceof HTMLElement
      && target.closest("input, textarea, select, [contenteditable='true']");
    if ((event.ctrlKey || event.metaKey) && !isEditingText && !isExporting) {
      const key = event.key.toLowerCase();
      if (key === "z" && !isRestoringHistory) {
        event.preventDefault();
        if (event.shiftKey) void redo();
        else void undo();
        return;
      }
      if (key === "y" && !isRestoringHistory) {
        event.preventDefault();
        void redo();
        return;
      }
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedTransition && !isExporting) {
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      removeTransition(selectedTransition.leftClipId);
      return;
    }
    if ((event.key !== "Delete" && event.key !== "Backspace") || !selectedClip || isExporting) return;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    removeClip(selectedClip.id);
  };

  const addUploads = useCallback(async (files: FileList | File | null, includeImages = false) => {
    if (!files) return false;
    const selectedFiles = files instanceof File ? [files] : Array.from(files);
    const accepted = selectedFiles.filter((file) => file.type.startsWith("video/")
      || file.type.startsWith("audio/")
      || (includeImages && file.type.startsWith("image/")));
    if (accepted.length !== selectedFiles.length) setError("Only video and audio files can be added to Footage.");
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
      if (nextAssets.length > 0) recordHistory();
      setUploadedAssets((current) => [...current, ...nextAssets]);
      setPersistenceError("");
      return accepted.length === selectedFiles.length && accepted.length > 0;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not save uploaded media.";
      setPersistenceError(message);
      setPersistenceStatus("Editor save failed");
      throw caught;
    }
  }, [recordHistory]);

  const removeUploadedAsset = async (asset: VideoAsset) => {
    if (removingFootageId || isRestoringHistory) return;
    setRemovingFootageId(asset.id);
    setError("");
    try {
      const current = editorSnapshotRef.current;
      const inUse = asset.mediaId && current.sequences.some((sequence) =>
        [...sequence.clips, ...sequence.audioClips].some((clip) => clip.mediaId === asset.mediaId));
      const sourceInUse = current.sequences.some((sequence) =>
        [...sequence.clips, ...sequence.audioClips].some((clip) => clip.src === asset.src));
      if (asset.mediaId && !inUse) await deleteEditorMedia(asset.mediaId);
      recordHistory(current);
      setUploadedAssets((assetsNow) => assetsNow.filter((item) => item.id !== asset.id));
      if (!sourceInUse && asset.src.startsWith("blob:")) URL.revokeObjectURL(asset.src);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not remove "${asset.name}" from Footage.`);
    } finally {
      setRemovingFootageId("");
    }
  };

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
    return getClipTimelineOffset(clips, transitions, id);
  };

  const getTransitionAtTime = (time: number) => transitions.find((transition) => {
    const left = clips.find((clip) => clip.id === transition.leftClipId);
    const rightIndex = clips.findIndex((clip) => clip.id === transition.rightClipId);
    if (!left || rightIndex < 0 || clips[rightIndex - 1]?.id !== left.id) return false;
    const start = getClipOffset(left.id) + left.trimEnd - left.trimStart - transition.duration;
    return time >= start && time < start + transition.duration;
  });

  const getTransitionStart = (transition: TimelineTransition) => {
    const left = clips.find((clip) => clip.id === transition.leftClipId);
    if (!left) return 0;
    return getClipOffset(left.id) + left.trimEnd - left.trimStart - transition.duration;
  };

  const maxTransitionDuration = (left: TimelineClip, right: TimelineClip) => {
    const incoming = transitions.find((transition) => transition.rightClipId === left.id);
    const outgoing = transitions.find((transition) => transition.leftClipId === right.id);
    return Math.max(0, Math.min(
      left.trimEnd - left.trimStart - (incoming?.duration ?? 0),
      right.trimEnd - right.trimStart - (outgoing?.duration ?? 0),
    ) - 0.1);
  };

  const previewTransition = getTransitionAtTime(playheadTime);
  const selectedClipOutgoingTransition = transitions.find((transition) => transition.leftClipId === selectedClip?.id);
  const previewTransitionClip = previewTransition
    ? clips.find((clip) => clip.id === previewTransition.rightClipId)
    : selectedClipOutgoingTransition
      ? clips.find((clip) => clip.id === selectedClipOutgoingTransition.rightClipId)
    : undefined;
  const selectedTransition = transitions.find((transition) => transition.leftClipId === selectedTransitionId);

  const syncTransitionPlayback = (timelineTime: number, shouldPlay: boolean) => {
    const transition = getTransitionAtTime(timelineTime);
    const nextClip = transition && clips.find((clip) => clip.id === transition.rightClipId);
    const video = transitionPreviewRef.current;
    const progress = transition
      ? Math.min(1, Math.max(0, (timelineTime - getTransitionStart(transition)) / transition.duration))
      : 0;
    if (previewRef.current) previewRef.current.volume = 1 - progress;
    if (!video) return;
    if (!transition) {
      const upcoming = transitions.find((item) => item.leftClipId === selectedClip?.id);
      const upcomingClip = upcoming && clips.find((clip) => clip.id === upcoming.rightClipId);
      if (shouldPlay && upcomingClip) {
        video.muted = true;
        video.volume = 0;
        if (video.paused) void video.play().catch(() => {
          playbackWanted.current = false;
          previewRef.current?.pause();
          setIsPlaying(false);
          setError("The browser could not prepare the transition preview.");
        });
      } else {
        video.pause();
      }
      return;
    }
    if (!nextClip) {
      video?.pause();
      return;
    }
    video.muted = false;
    video.volume = progress;
    const sourceTime = nextClip.trimStart + timelineTime - getTransitionStart(transition);
    if (Math.abs(video.currentTime - sourceTime) > 0.15) video.currentTime = sourceTime;
    if (shouldPlay && playbackWanted.current) {
      if (video.paused) void video.play().catch(() => {
        playbackWanted.current = false;
        previewRef.current?.pause();
        pauseAudio();
        setIsPlaying(false);
        setError("The browser could not play the transition preview.");
      });
    } else {
      video.pause();
    }
  };

  const changeTransitionBoundary = (left: TimelineClip, right: TimelineClip) => {
    const existing = transitions.find((transition) => transition.leftClipId === left.id
      && transition.rightClipId === right.id);
    if (existing) {
      setSelectedTransitionId(left.id);
      return;
    }
    if (activeTool !== "transition") return;
    const maxDuration = maxTransitionDuration(left, right);
    if (maxDuration < 0.1) {
      setError("These clips are too short to add a cross dissolve.");
      return;
    }
    const duration = Math.min(1, maxDuration);
    playbackWanted.current = false;
    previewRef.current?.pause();
    pauseAudio();
    setIsPlaying(false);
    recordHistory();
    setTransitions([...transitions, { leftClipId: left.id, rightClipId: right.id, duration }]);
    setSelectedTransitionId(left.id);
    const transitionStart = getClipOffset(left.id) + left.trimEnd - left.trimStart - duration;
    const sourceTime = left.trimEnd - duration;
    if (selectedId === left.id && previewRef.current) {
      previewRef.current.currentTime = sourceTime;
    } else {
      pendingSeek.current = { id: left.id, time: sourceTime };
    }
    setSelectedId(left.id);
    setPlayheadTime(transitionStart);
    setError("");
  };

  const updateTransitionDuration = (leftClipId: string, duration: number) => {
    const transition = transitions.find((item) => item.leftClipId === leftClipId);
    if (!transition || !Number.isFinite(duration)) return;
    const leftIndex = clips.findIndex((clip) => clip.id === transition.leftClipId);
    const left = clips[leftIndex];
    const right = clips[leftIndex + 1];
    if (!left || right?.id !== transition.rightClipId) return;
    const maxDuration = maxTransitionDuration(left, right);
    setTransitions(transitions.map((item) => item.leftClipId === leftClipId
      ? { ...item, duration: Math.min(maxDuration, Math.max(0.1, duration)) }
      : item));
  };

  const removeTransition = (leftClipId: string) => {
    if (!transitions.some((transition) => transition.leftClipId === leftClipId)) return;
    playbackWanted.current = false;
    previewRef.current?.pause();
    pauseAudio();
    setIsPlaying(false);
    recordHistory();
    setTransitions(transitions.filter((transition) => transition.leftClipId !== leftClipId));
    setSelectedTransitionId("");
  };

  const startTransitionResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    transition: TimelineTransition,
    edge: TransitionResizeDrag["edge"],
  ) => {
    if (isExporting || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    transitionResizeDrag.current = {
      leftClipId: transition.leftClipId,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      duration: transition.duration,
      snapshot: editorSnapshotRef.current,
    };
    playbackWanted.current = false;
    previewRef.current?.pause();
    pauseAudio();
    setIsPlaying(false);
    setSelectedTransitionId(transition.leftClipId);
  };

  const moveTransitionResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = transitionResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const direction = drag.edge === "start" ? -1 : 1;
    updateTransitionDuration(drag.leftClipId, drag.duration + direction * (event.clientX - drag.startX) / 72);
  };

  const finishTransitionResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = transitionResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    transitionResizeDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (JSON.stringify(drag.snapshot.sequences) !== JSON.stringify(editorSnapshotRef.current.sequences)) {
      recordHistory(drag.snapshot);
    }
  };

  const selectClip = (clipId: string) => {
    const clip = clips.find((item) => item.id === clipId);
    if (!clip) return;
    const clipIndex = clips.findIndex((item) => item.id === clipId);
    const incomingTransition = clipIndex > 0
      ? transitions.find((transition) => transition.rightClipId === clipId)
      : undefined;
    const initialTime = clip.trimStart + (incomingTransition?.duration ?? 0);
    const sourceTime = selectedId === clipId && previewRef.current
      ? previewRef.current.currentTime
      : initialTime;
    playbackWanted.current = false;
    setIsPlaying(false);
    previewRef.current?.pause();
    pauseAudio();
    transitionPreviewRef.current?.pause();
    setPlayheadTime(getClipOffset(clipId)
      + Math.min(Math.max(0, sourceTime - clip.trimStart), clip.trimEnd - clip.trimStart));
    if (selectedId !== clipId) pendingSeek.current = { id: clip.id, time: initialTime };
    setSelectedId(clipId);
  };

  const seekTimeline = (time: number) => {
    if (clips.length === 0) return;
    const boundedTime = Math.min(Math.max(0, time), totalDuration);
    let targetClip = clips[clips.length - 1];
    let targetTime = targetClip.trimEnd;
    for (const clip of clips) {
      const clipLength = clip.trimEnd - clip.trimStart;
      const clipOffset = getClipOffset(clip.id);
      if (boundedTime < clipOffset + clipLength) {
        targetClip = clip;
        targetTime = clip.trimStart + boundedTime - clipOffset;
        break;
      }
    }

    playbackWanted.current = false;
    setIsPlaying(false);
    previewRef.current?.pause();
    pauseAudio();
    syncAudioPlayback(boundedTime, false);
    setPlayheadTime(boundedTime);
    if (targetClip.id !== selectedClip?.id) {
      pendingSeek.current = { id: targetClip.id, time: targetTime };
      setSelectedId(targetClip.id);
    } else if (previewRef.current) {
      previewRef.current.currentTime = targetTime;
    }
    syncTransitionPlayback(boundedTime, false);
  };

  const handleTimeUpdate = () => {
    const video = previewRef.current;
    if (!video || !selectedClip) return;
    const timelineTime = getClipOffset(selectedClip.id)
      + Math.min(Math.max(0, video.currentTime - selectedClip.trimStart), selectedClip.trimEnd - selectedClip.trimStart);
    setPlayheadTime(timelineTime);
    syncAudioPlayback(timelineTime, playbackWanted.current);
    syncTransitionPlayback(timelineTime, playbackWanted.current);
    if (!playbackWanted.current || advancing.current
      || (!video.ended && video.currentTime < selectedClip.trimEnd - 0.05)) return;
    advancing.current = true;
    const index = clips.findIndex((clip) => clip.id === selectedClip.id);
    const next = clips[index + 1];
    if (!next) {
      playbackWanted.current = false;
      setIsPlaying(false);
      video.pause();
      pauseAudio();
      video.currentTime = selectedClip.trimEnd;
    } else {
      setPlayheadTime(getClipOffset(selectedClip.id) + selectedClip.trimEnd - selectedClip.trimStart);
      const transition = transitions.find((item) => item.leftClipId === selectedClip.id
        && item.rightClipId === next.id);
      pendingSeek.current = { id: next.id, time: next.trimStart + (transition?.duration ?? 0) };
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
      pauseAudio();
      return;
    }
    playbackWanted.current = true;
    setIsPlaying(true);
    if (video.currentTime < selectedClip.trimStart || video.currentTime >= selectedClip.trimEnd) {
      video.currentTime = selectedClip.trimStart;
    }
    const transitionVideo = transitionPreviewRef.current;
    const transition = getTransitionAtTime(playheadTime);
    if (transitionVideo && previewTransitionClip) {
      transitionVideo.muted = true;
      transitionVideo.currentTime = transition
        ? previewTransitionClip.trimStart + playheadTime - getTransitionStart(transition)
        : previewTransitionClip.trimStart;
    }
    try {
      const playRequests = [video.play()];
      if (transitionVideo) playRequests.push(transitionVideo.play());
      await Promise.all(playRequests);
      const timelineTime = getClipOffset(selectedClip.id) + video.currentTime - selectedClip.trimStart;
      syncAudioPlayback(timelineTime, true);
      syncTransitionPlayback(timelineTime, true);
    } catch {
      playbackWanted.current = false;
      setIsPlaying(false);
      pauseAudio();
      setError("The browser could not play this video.");
    }
  };

  const exportVideo = async (format: "mov" | "mp4" | "png") => {
    if (clips.length === 0 || !activeSequence) return;
    setError("");
    playbackWanted.current = false;
    previewRef.current?.pause();
    pauseAudio();
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
      formData.append("transitions", JSON.stringify(transitions.map((transition) => ({
        afterClipIndex: clips.findIndex((clip) => clip.id === transition.leftClipId),
        duration: transition.duration,
      }))));
      formData.append("keyers", JSON.stringify(clips.map((clip) => ({ ...DEFAULT_KEYER, ...clip.keyer }))));
      if (format !== "png") {
        formData.append("audioTimeline", JSON.stringify(audioClips.map((clip, fileIndex) => ({
          fileIndex,
          start: clip.start,
          trimStart: clip.trimStart,
          trimEnd: clip.trimEnd,
          volume: clip.volume,
        }))));
      }

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

      for (const clip of format === "png" ? [] : audioClips) {
        const file = clip.file;
        if (!file) throw new Error(`Could not read audio "${clip.name}" from this device.`);
        if (file.size > 200 * 1024 * 1024) {
          throw new Error(`"${clip.name}" is too large to export. Audio clips must be 200 MB or smaller.`);
        }
        formData.append("audio", file, clip.name);
      }

      setExportStage(format === "png"
        ? "Uploading clips and rendering transparent 30 fps PNG frames…"
        : `Uploading video and audio tracks and rendering transitions in H.264 ${format.toUpperCase()} on the server…`);
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
      link.download = format === "png" ? `${safeName}-transparent-frames.zip` : `${safeName}.${format}`;
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
          <p>Arrange video and audio, trim clips, adjust volume, then export H.264 MOV or MP4 files.</p>
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
                accept="video/*,audio/*"
                multiple
                disabled={Boolean(removingFootageId) || isRestoringHistory}
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
            <div className="ff-editor-asset-row" key={asset.id}>
              {asset.file?.type.startsWith("image/") ? (
                <div className="ff-editor-asset ff-editor-image-asset" title="Images are available in Footage; the timeline accepts video and audio clips.">
                  <img className="ff-editor-upload-thumbnail" src={asset.src} alt="" />
                  <span>{asset.name}</span>
                  <strong aria-hidden="true">IMG</strong>
                </div>
              ) : asset.file?.type.startsWith("audio/") ? (
                <button
                  className="ff-editor-asset"
                  onClick={() => void addAudioAsset(asset)}
                  disabled={isExporting || Boolean(loadingAudioAssetId) || Boolean(removingFootageId) || isRestoringHistory}
                  title="Add audio at the current playhead position"
                >
                  <span aria-hidden="true">♫</span>
                  <span>{loadingAudioAssetId === asset.id ? "Reading audio…" : asset.name}</span>
                  <strong>{loadingAudioAssetId === asset.id ? "…" : "+ Audio"}</strong>
                </button>
              ) : (
                <button
                  className="ff-editor-asset"
                  onClick={() => void addAsset(asset)}
                  disabled={isExporting || Boolean(loadingAssetId) || Boolean(removingFootageId) || isRestoringHistory}
                >
                  <span aria-hidden="true">▣</span>
                  <span>{loadingAssetId === asset.id ? "Preparing video…" : asset.name}</span>
                  <strong>+</strong>
                </button>
              )}
              <button
                type="button"
                className="ff-editor-asset-delete"
                aria-label={`Delete ${asset.name} from Footage`}
                title="Delete from Footage"
                disabled={isExporting || Boolean(loadingAssetId) || Boolean(loadingAudioAssetId)
                  || Boolean(removingFootageId) || isRestoringHistory}
                onClick={() => void removeUploadedAsset(asset)}
              >
                ×
              </button>
            </div>
          ))}
          {uploadedAssets.length === 0 && <p className="ff-editor-empty">Upload video or audio files from this device.</p>}
        </section>

        <p className="ff-editor-sidebar-note">Footage, sequences, and timeline edits are saved in this browser. Transitions and audio tracks are included in MOV and MP4 exports.</p>
      </aside>

      <div className="ff-editor-workspace">
        <div
          className={`ff-editor-preview${selectedKeyer.enabled ? " ff-editor-key-preview" : ""}`}
          ref={previewContainerRef}
        >
          {selectedClip ? (
            <video
              key={selectedClip.id}
              ref={previewRef}
              className={selectedKeyer.enabled ? "ff-editor-preview-keyed-source" : undefined}
              style={{ transform: `scale(${previewZoom})` }}
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
                const timelineTime = getClipOffset(selectedClip.id) + video.currentTime - selectedClip.trimStart;
                setPlayheadTime(timelineTime);
                const transition = getTransitionAtTime(timelineTime);
                const transitionProgress = transition
                  ? (timelineTime - getTransitionStart(transition)) / transition.duration
                  : 0;
                video.volume = 1 - transitionProgress;
                syncAudioPlayback(timelineTime, playbackWanted.current);
                syncTransitionPlayback(timelineTime, playbackWanted.current);
                if (playbackWanted.current) {
                  void video.play().catch(() => {
                    playbackWanted.current = false;
                    setIsPlaying(false);
                    pauseAudio();
                    setError("The browser could not play this video.");
                  });
                }
              }}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleTimeUpdate}
              onError={() => {
                playbackWanted.current = false;
                setIsPlaying(false);
                pauseAudio();
                setError("Could not load this video. Check that the file or source URL is available.");
              }}
            />
          ) : (
            <div className="ff-editor-preview-empty">
              <span aria-hidden="true">▶</span>
              <strong>Your timeline preview</strong>
              <p>Add a generated video or upload a clip to begin.</p>
            </div>
          )}
          {selectedClip && selectedKeyer.enabled && (
            <canvas
              ref={keyerCanvasRef}
              className="ff-editor-keyer-canvas"
              style={{ transform: `scale(${previewZoom})` }}
              aria-label={`Chroma-key preview for ${selectedClip.name}`}
            />
          )}
          {previewTransitionClip && (previewTransition || selectedClipOutgoingTransition) && (
            <video
              key={`transition-${previewTransitionClip.id}`}
              ref={transitionPreviewRef}
              className="ff-editor-transition-preview"
              src={previewTransitionClip.src}
              style={{
                transform: `scale(${previewZoom})`,
                opacity: previewTransition
                  ? Math.min(1, Math.max(0,
                    (playheadTime - getTransitionStart(previewTransition)) / previewTransition.duration))
                  : 0,
              }}
              playsInline
              muted
              aria-hidden="true"
              onCanPlay={(event) => {
                const video = event.currentTarget;
                const transition = getTransitionAtTime(playheadTime);
                const activeTransition = transition?.rightClipId === previewTransitionClip.id ? transition : undefined;
                const sourceTime = activeTransition
                  ? previewTransitionClip.trimStart + playheadTime - getTransitionStart(activeTransition)
                  : previewTransitionClip.trimStart;
                video.currentTime = sourceTime;
                video.muted = !activeTransition;
                video.volume = activeTransition
                  ? Math.min(1, Math.max(0,
                    (playheadTime - getTransitionStart(activeTransition)) / activeTransition.duration))
                  : 0;
                if (playbackWanted.current) {
                  void video.play().catch(() => {
                    playbackWanted.current = false;
                    previewRef.current?.pause();
                    pauseAudio();
                    setIsPlaying(false);
                    setError("The browser could not play the transition preview.");
                  });
                }
              }}
              onError={() => {
                playbackWanted.current = false;
                setIsPlaying(false);
                pauseAudio();
                setError("Could not load the next video for the transition preview.");
              }}
            />
          )}
          {selectedClip && (
            <div className="ff-editor-preview-controls">
              <button type="button" className="ff-editor-play" onClick={() => void togglePlayback()} disabled={isExporting}>
                {isPlaying ? "Pause" : "Play"}
              </button>
              <span>{selectedClip.name}</span>
              <span>{formatTime(selectedClip.trimStart)} – {formatTime(selectedClip.trimEnd)}</span>
              <label className="ff-editor-zoom-control">
                <span>Zoom</span>
                <input
                  type="range"
                  aria-label="Preview zoom"
                  min="0.5"
                  max="4"
                  step="0.1"
                  value={previewZoom}
                  onChange={(event) => setPreviewZoom(Number(event.target.value))}
                />
                <output>{Math.round(previewZoom * 100)}%</output>
              </label>
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
                onFocus={() => {
                  renameStart.current = {
                    snapshot: editorSnapshotRef.current,
                    sequenceId: activeSequenceId,
                    name: activeSequence?.name ?? "",
                  };
                }}
                onBlur={(event) => {
                  const initial = renameStart.current;
                  if (initial && initial.sequenceId === activeSequenceId && initial.name !== event.currentTarget.value) {
                    recordHistory(initial.snapshot);
                  }
                  renameStart.current = null;
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
                  aria-label="Undo"
                  title="Undo (Ctrl/Cmd+Z)"
                  disabled={!canUndo || isExporting || isRestoringHistory || Boolean(removingFootageId)}
                  onClick={() => void undo()}
                >
                  <span aria-hidden="true">↶</span>
                </button>
                <button
                  type="button"
                  className="ff-editor-tool"
                  aria-label="Redo"
                  title="Redo (Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z)"
                  disabled={!canRedo || isExporting || isRestoringHistory || Boolean(removingFootageId)}
                  onClick={() => void redo()}
                >
                  <span aria-hidden="true">↷</span>
                </button>
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
                  aria-label="Transition tool"
                  aria-pressed={activeTool === "transition"}
                  title="Transition tool: click between clips to add a cross dissolve"
                  disabled={isExporting}
                  onClick={() => setActiveTool("transition")}
                >
                  <span aria-hidden="true">⇄</span>
                </button>
                <button
                  type="button"
                  className="ff-editor-tool"
                  aria-label="Chroma key effect"
                  aria-pressed={selectedKeyer.enabled}
                  title={selectedKeyer.enabled ? "Disable chroma key on selected clip" : "Enable chroma key on selected clip"}
                  disabled={!selectedClip || isExporting}
                  onClick={() => {
                    if (!selectedClip) return;
                    recordHistory();
                    updateSelectedClipKeyer({ enabled: !selectedKeyer.enabled });
                    setError("");
                  }}
                >
                  <span aria-hidden="true">◉</span>
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
              <button
                type="button"
                className="ff-editor-sequence-action ff-editor-export-secondary"
                onClick={() => void exportVideo("png")}
                disabled={clips.length === 0 || isExporting}
                title="Export a transparent 30 fps PNG sequence in a ZIP file (up to 60 seconds)"
              >
                {isExporting && exportingFormat === "png" ? "Rendering PNGs…" : "Export PNGs"}
              </button>
            </div>
          </div>
          <p className="ff-editor-instructions">
            Video clips with embedded audio show a source waveform automatically, aligned to the visible trim. Add audio from Footage to place a separate track at the playhead. Set its start, source in/out points, and volume; overlapping audio clips are mixed. Audio plays in sync with video and is included in exports. Choose the Transition tool and click between clips to add a cross dissolve; select its marker to change the duration or remove it. Transitions overlap adjacent clips, shorten the sequence, and crossfade their source audio. Undo and redo with Ctrl/Cmd+Z and Ctrl/Cmd+Y; history holds up to 50 actions and clears on reload. Create sequences with + New. Add videos with + to the active sequence; rename or switch sequences here. Choose the Razor tool and click a clip to split it. Use Ripple delete to remove the selected clip and close the gap. Drag a clip&apos;s edge to trim its start or end, or use the In and Out fields for exact times. Drag clips to reorder; right-click or select a clip and press Delete to remove it. Exports are H.264 MOV or MP4 at 1280 × 720 with AAC audio.
          </p>
          {selectedClip && (
            <section className="ff-editor-keyer-controls" aria-labelledby="ff-editor-keyer-heading">
              <div className="ff-editor-keyer-heading">
                <strong id="ff-editor-keyer-heading">Chroma key</strong>
                <span>Preview effect · source footage stays unchanged</span>
                <label className="ff-editor-keyer-toggle">
                  <input
                    type="checkbox"
                    aria-label="Enable chroma key"
                    checked={selectedKeyer.enabled}
                    disabled={isExporting}
                    onChange={(event) => {
                      recordHistory();
                      updateSelectedClipKeyer({ enabled: event.target.checked });
                      setError("");
                    }}
                  />
                  Enable
                </label>
              </div>
              {selectedKeyer.enabled && (
                <>
                  <div className="ff-editor-keyer-fields">
                    <label className="ff-editor-keyer-channel">
                      View channel
                      <select
                        aria-label="Chroma key view channel"
                        value={keyerViewChannel}
                        onChange={(event) => {
                          const channel = event.target.value;
                          if (isKeyerViewChannel(channel)) setKeyerViewChannel(channel);
                        }}
                      >
                        <option value="rgb">RGB</option>
                        <option value="red">Red</option>
                        <option value="green">Green</option>
                        <option value="blue">Blue</option>
                        <option value="alpha">Alpha</option>
                      </select>
                    </label>
                  </div>
                  <div className="ff-editor-keyer-fields">
                  <label className="ff-editor-keyer-color">
                    Screen color
                    <input
                      type="color"
                      aria-label="Chroma key color"
                      value={selectedKeyer.color}
                      disabled={isExporting}
                      onPointerDown={beginKeyerEdit}
                      onPointerUp={finishKeyerEdit}
                      onKeyDown={beginKeyerEdit}
                      onKeyUp={finishKeyerEdit}
                      onBlur={finishKeyerEdit}
                      onChange={(event) => updateSelectedClipKeyer({ color: event.target.value })}
                    />
                  </label>
                  <label className="ff-editor-keyer-range">
                    Similarity
                    <input
                      type="range"
                      aria-label="Chroma key similarity"
                      min="0"
                      max="0.8"
                      step="0.01"
                      value={selectedKeyer.similarity}
                      disabled={isExporting}
                      onPointerDown={beginKeyerEdit}
                      onPointerUp={finishKeyerEdit}
                      onKeyDown={beginKeyerEdit}
                      onKeyUp={finishKeyerEdit}
                      onBlur={finishKeyerEdit}
                      onChange={(event) => updateSelectedClipKeyer({ similarity: Number(event.target.value) })}
                    />
                    <output>{selectedKeyer.similarity.toFixed(2)}</output>
                  </label>
                  <label className="ff-editor-keyer-range">
                    Edge softness
                    <input
                      type="range"
                      aria-label="Chroma key edge softness"
                      min="0.01"
                      max="0.6"
                      step="0.01"
                      value={selectedKeyer.softness}
                      disabled={isExporting}
                      onPointerDown={beginKeyerEdit}
                      onPointerUp={finishKeyerEdit}
                      onKeyDown={beginKeyerEdit}
                      onKeyUp={finishKeyerEdit}
                      onBlur={finishKeyerEdit}
                      onChange={(event) => updateSelectedClipKeyer({ softness: Number(event.target.value) })}
                    />
                    <output>{selectedKeyer.softness.toFixed(2)}</output>
                  </label>
                  <label className="ff-editor-keyer-range">
                    Spill suppression
                    <input
                      type="range"
                      aria-label="Chroma key spill suppression"
                      min="0"
                      max="1"
                      step="0.01"
                      value={selectedKeyer.spillSuppression}
                      disabled={isExporting}
                      onPointerDown={beginKeyerEdit}
                      onPointerUp={finishKeyerEdit}
                      onKeyDown={beginKeyerEdit}
                      onKeyUp={finishKeyerEdit}
                      onBlur={finishKeyerEdit}
                      onChange={(event) => updateSelectedClipKeyer({ spillSuppression: Number(event.target.value) })}
                    />
                    <output>{Math.round(selectedKeyer.spillSuppression * 100)}%</output>
                  </label>
                  </div>
                </>
              )}
            </section>
          )}
          {selectedTransition && (
            <div className="ff-editor-transition-controls" role="group" aria-label="Cross dissolve settings">
              <strong>Cross dissolve</strong>
              <span>{selectedTransition.duration.toFixed(1)} s · drag either edge to resize</span>
              <button
                type="button"
                className="ff-editor-sequence-action"
                onClick={() => removeTransition(selectedTransition.leftClipId)}
                disabled={isExporting}
              >
                Remove transition
              </button>
            </div>
          )}
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
                  {clips.map((clip, index) => {
                    const transition = transitions.find((item) => item.leftClipId === clip.id);
                    const waveform = clip.audioWaveform ?? [];
                    const waveformPath = waveform.length > 0
                      ? [
                        ...waveform.map((sample, sampleIndex) => {
                          const height = 1 + Math.max(0, Math.min(1, sample)) * 14;
                          return `${sampleIndex} ${16 - height}`;
                        }),
                        ...waveform.map((sample, sampleIndex) => {
                          const height = 1 + Math.max(0, Math.min(1, sample)) * 14;
                          return `${waveform.length - sampleIndex - 1} ${16 + height}`;
                        }),
                      ].join(" L ")
                      : "";
                    return (
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
                        style={{
                          flexBasis: `${((clip.trimEnd - clip.trimStart) / totalDuration) * 100}%`,
                          marginLeft: index > 0
                            ? `${-((transitions.find((item) => item.rightClipId === clip.id)?.duration ?? 0)
                              / totalDuration) * 100}%`
                            : undefined,
                        }}
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
                          : activeTool === "transition"
                            ? " ff-editor-clip-select-transition"
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
                          } else if (activeTool === "select") {
                            selectClip(clip.id);
                          }
                        }}
                      >
                        <span className="ff-editor-clip-number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="ff-editor-clip-name">{clip.name}</span>
                        <span className="ff-editor-clip-duration">{formatTime(clip.trimEnd - clip.trimStart)}</span>
                      </button>
                      {waveformPath && (
                        <div className="ff-editor-source-waveform" aria-label={`${clip.name} source audio waveform`}>
                          <span aria-hidden="true">♫</span>
                          <svg
                            viewBox={`${(clip.trimStart / clip.duration) * waveform.length} 0 ${((clip.trimEnd - clip.trimStart) / clip.duration) * waveform.length} 32`}
                            preserveAspectRatio="none"
                            aria-hidden="true"
                          >
                            <path d={`M ${waveformPath} Z`} />
                          </svg>
                        </div>
                      )}
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
                      {index < clips.length - 1
                        && (activeTool === "transition" || Boolean(transition))
                        && (
                          <div
                            className={`ff-editor-transition-block${selectedTransitionId === clip.id ? " ff-editor-transition-block-active" : ""}`}
                            style={{
                              width: `${((transition?.duration ?? 0.1)
                                / (clip.trimEnd - clip.trimStart)) * 100}%`,
                              right: "0",
                            }}
                            aria-label={transition
                              ? `Select cross dissolve between ${clip.name} and ${clips[index + 1].name}`
                              : `Add cross dissolve between ${clip.name} and ${clips[index + 1].name}`}
                            title={transition
                              ? `Cross dissolve · ${transition.duration.toFixed(1)} seconds`
                              : "Add cross dissolve"}
                            role="button"
                            aria-disabled={isExporting}
                            tabIndex={isExporting ? -1 : 0}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                changeTransitionBoundary(clip, clips[index + 1]);
                              }
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              changeTransitionBoundary(clip, clips[index + 1]);
                            }}
                          >
                              {transition ? (
                              <>
                                  <span className="ff-editor-transition-cross" aria-hidden="true" />
                                  <span className="ff-editor-transition-label">Cross Dissolve</span>
                                  <button
                                    type="button"
                                    className="ff-editor-transition-remove"
                                    aria-label={`Delete cross dissolve between ${clip.name} and ${clips[index + 1].name}`}
                                    title="Delete cross dissolve"
                                    disabled={isExporting}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      removeTransition(transition.leftClipId);
                                    }}
                                  >
                                    ×
                                  </button>
                                  <button
                                    type="button"
                                    className="ff-editor-transition-handle ff-editor-transition-handle-start"
                                    aria-label={`Resize start of cross dissolve between ${clip.name} and ${clips[index + 1].name}`}
                                    title="Drag left or right to resize the transition"
                                    disabled={isExporting}
                                    onPointerDown={(event) => startTransitionResize(event, transition, "start")}
                                    onPointerMove={moveTransitionResize}
                                    onPointerUp={finishTransitionResize}
                                    onPointerCancel={finishTransitionResize}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => {
                                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                                      event.preventDefault();
                                      recordHistory();
                                      updateTransitionDuration(
                                        transition.leftClipId,
                                        transition.duration + (event.key === "ArrowLeft" ? 0.1 : -0.1),
                                      );
                                    }}
                                  />
                                  <button
                                    type="button"
                                    className="ff-editor-transition-handle ff-editor-transition-handle-end"
                                    aria-label={`Resize end of cross dissolve between ${clip.name} and ${clips[index + 1].name}`}
                                    title="Drag left or right to resize the transition"
                                    disabled={isExporting}
                                    onPointerDown={(event) => startTransitionResize(event, transition, "end")}
                                    onPointerMove={moveTransitionResize}
                                    onPointerUp={finishTransitionResize}
                                    onPointerCancel={finishTransitionResize}
                                    onClick={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => {
                                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                                      event.preventDefault();
                                      recordHistory();
                                      updateTransitionDuration(
                                        transition.leftClipId,
                                        transition.duration + (event.key === "ArrowRight" ? 0.1 : -0.1),
                                      );
                                    }}
                                  />
                                </>
                              ) : <span aria-hidden="true">+</span>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <section className="ff-editor-audio-lane" aria-label="Audio track">
                  <div className="ff-editor-audio-heading">
                    <strong>Audio track</strong>
                    <span>Add audio from Footage; it starts at the playhead. Overlapping clips are mixed.</span>
                  </div>
                  <div className="ff-editor-audio-track" style={{ width: `${Math.max(totalDuration * 72, 1)}px` }}>
                    {audioClips.length === 0 && <span className="ff-editor-audio-empty">No audio clips</span>}
                    {audioClips.map((clip) => (
                      <div
                        key={clip.id}
                        className="ff-editor-audio-block"
                        title={`${clip.name} · ${formatTime(clip.start)} · ${Math.round(clip.volume * 100)}% volume`}
                        style={{
                          left: `${(clip.start / totalDuration) * 100}%`,
                          width: `${((clip.trimEnd - clip.trimStart) / totalDuration) * 100}%`,
                        }}
                      >
                        <span aria-hidden="true">♫</span>
                        <span>{clip.name}</span>
                      </div>
                    ))}
                    {audioClips.map((clip) => (
                      <audio
                        key={clip.id}
                        ref={(element) => {
                          if (element) audioElements.current.set(clip.id, element);
                          else audioElements.current.delete(clip.id);
                        }}
                        src={clip.src}
                        preload="auto"
                        aria-hidden="true"
                        onError={() => setError(`Could not load audio "${clip.name}".`)}
                      />
                    ))}
                  </div>
                  {audioClips.map((clip) => (
                    <div className="ff-editor-audio-controls" key={`${clip.id}-controls`}>
                      <strong title={clip.name}>{clip.name}</strong>
                      <label>
                        Start
                        <input
                          type="number"
                          aria-label={`Start ${clip.name} s`}
                          min="0"
                          max={totalDuration}
                          step="0.1"
                          value={clip.start.toFixed(1)}
                          disabled={isExporting}
                          onFocus={beginAudioEdit}
                          onBlur={finishAudioEdit}
                          onChange={(event) => updateAudioClip(clip.id, { start: Number(event.target.value) })}
                        />
                        s
                      </label>
                      <label>
                        In
                        <input
                          type="number"
                          aria-label={`In ${clip.name} s`}
                          min="0"
                          max={Math.max(0, clip.trimEnd - 0.1)}
                          step="0.1"
                          value={clip.trimStart.toFixed(1)}
                          disabled={isExporting}
                          onFocus={beginAudioEdit}
                          onBlur={finishAudioEdit}
                          onChange={(event) => updateAudioClip(clip.id, { trimStart: Number(event.target.value) })}
                        />
                        s
                      </label>
                      <label>
                        Out
                        <input
                          type="number"
                          aria-label={`Out ${clip.name} s`}
                          min={clip.trimStart + 0.1}
                          max={clip.duration}
                          step="0.1"
                          value={clip.trimEnd.toFixed(1)}
                          disabled={isExporting}
                          onFocus={beginAudioEdit}
                          onBlur={finishAudioEdit}
                          onChange={(event) => updateAudioClip(clip.id, { trimEnd: Number(event.target.value) })}
                        />
                        s
                      </label>
                      <label className="ff-editor-audio-volume">
                        Volume {Math.round(clip.volume * 100)}%
                        <input
                          type="range"
                          aria-label={`Volume ${clip.name}`}
                          min="0"
                          max="100"
                          step="1"
                          value={Math.round(clip.volume * 100)}
                          disabled={isExporting}
                          onFocus={beginAudioEdit}
                          onBlur={finishAudioEdit}
                          onChange={(event) => updateAudioClip(clip.id, { volume: Number(event.target.value) / 100 })}
                        />
                      </label>
                      <button
                        type="button"
                        aria-label={`Remove audio ${clip.name}`}
                        title="Remove audio clip"
                        disabled={isExporting}
                        onClick={() => removeAudioClip(clip.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </section>
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
