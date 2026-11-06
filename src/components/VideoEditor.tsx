"use client";

import { useRef, useState, type KeyboardEvent, type SetStateAction } from "react";

export type VideoAsset = {
  id: string;
  name: string;
  src: string;
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

export default function VideoEditor({ assets, hidden = false }: { assets: VideoAsset[]; hidden?: boolean }) {
  const [uploadedAssets, setUploadedAssets] = useState<VideoAsset[]>([]);
  const [sequences, setSequences] = useState<VideoSequence[]>([
    { id: "sequence-1", name: "Sequence 1", clips: [], selectedId: "", playheadTime: 0 },
  ]);
  const [activeSequenceId, setActiveSequenceId] = useState("sequence-1");
  const [clipContextMenu, setClipContextMenu] = useState<ClipContextMenu | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStage, setExportStage] = useState("");
  const [error, setError] = useState("");
  const previewRef = useRef<HTMLVideoElement>(null);
  const playbackWanted = useRef(false);
  const advancing = useRef(false);
  const pendingSeek = useRef<{ id: string; time: number } | null>(null);
  const clipButtonRefs = useRef(new Map<string, HTMLButtonElement>());

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
    const probe = document.createElement("video");
    probe.preload = "metadata";
    try {
      await loadMedia(probe, asset.src);
      const duration = probe.duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("This video does not have a supported duration.");
      }
      const clip: TimelineClip = {
        ...asset,
        id: `${asset.id}-${crypto.randomUUID()}`,
        duration,
        trimStart: 0,
        trimEnd: duration,
      };
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
      playbackWanted.current = false;
      setIsPlaying(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add this video.");
    } finally {
      probe.removeAttribute("src");
      probe.load();
    }
  };

  const updateClip = (id: string, changes: Partial<Pick<TimelineClip, "trimStart" | "trimEnd">>) => {
    setClips((current) => current.map((clip) => {
      if (clip.id !== id) return clip;
      const trimStart = changes.trimStart ?? clip.trimStart;
      const trimEnd = changes.trimEnd ?? clip.trimEnd;
      return {
        ...clip,
        trimStart: Math.min(Math.max(0, trimStart), Math.max(0, clip.duration - 0.1)),
        trimEnd: Math.min(clip.duration, Math.max(trimStart + 0.1, trimEnd)),
      };
    }));
    if (selectedClip?.id === id && previewRef.current) {
      previewRef.current.currentTime = changes.trimStart ?? previewRef.current.currentTime;
    }
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

  const addUploads = (files: FileList | null) => {
    if (!files) return;
    const accepted = Array.from(files).filter((file) => file.type.startsWith("video/"));
    if (accepted.length !== files.length) setError("Only video files can be added to the editor.");
    const nextAssets = accepted.map((file) => ({
      id: `upload-${crypto.randomUUID()}`,
      name: file.name,
      src: URL.createObjectURL(file),
    }));
    setUploadedAssets((current) => [...current, ...nextAssets]);
  };

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

  const exportVideo = async () => {
    if (clips.length === 0 || !activeSequence) return;
    setError("");
    playbackWanted.current = false;
    previewRef.current?.pause();
    setIsPlaying(false);
    setIsExporting(true);
    setExportStage("Preparing clips for upload…");

    try {
      const formData = new FormData();
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

      setExportStage("Uploading clips and rendering H.264 MOV on the server…");
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
      link.download = `${safeName}.mov`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "MOV export failed.");
    } finally {
      setIsExporting(false);
      setExportStage("");
    }
  };

  return (
    <section className="ff-editor-layout" hidden={hidden} onKeyDown={handleEditorKeyDown} onClick={() => clipContextMenu && setClipContextMenu(null)}>
      <aside className="ff-editor-sidebar">
        <div className="ff-editor-heading">
          <span className="ff-overline">VIDEO EDITOR</span>
          <h1>Make a cut</h1>
          <p>Arrange clips, trim the start and end, then export an H.264 MOV file.</p>
        </div>

        <section className="ff-editor-media">
          <div className="ff-editor-section-heading">
            <h2>Workflow videos</h2>
            <span>{assets.length}</span>
          </div>
          {assets.length === 0 && <p className="ff-editor-empty">Run a video node in your workflow to add generated clips here.</p>}
          {assets.map((asset) => (
            <button className="ff-editor-asset" key={asset.id} onClick={() => void addAsset(asset)} disabled={isExporting}>
              <span aria-hidden="true">▶</span>
              <span>{asset.name}</span>
              <strong>+</strong>
            </button>
          ))}
        </section>

        <section className="ff-editor-media">
          <div className="ff-editor-section-heading">
            <h2>Uploads</h2>
            <label className="ff-editor-upload">
              Add files
              <input
                type="file"
                accept="video/*"
                multiple
                onChange={(event) => {
                  addUploads(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          {uploadedAssets.map((asset) => (
            <button className="ff-editor-asset" key={asset.id} onClick={() => void addAsset(asset)} disabled={isExporting}>
              <span aria-hidden="true">▣</span>
              <span>{asset.name}</span>
              <strong>+</strong>
            </button>
          ))}
          {uploadedAssets.length === 0 && <p className="ff-editor-empty">Upload video clips from this device.</p>}
        </section>

        <p className="ff-editor-sidebar-note">Sequences, uploads, and timeline edits stay in this tab only. MOV export uses H.264 video and AAC audio.</p>
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
            </div>
            <button type="button" className="ff-run" onClick={() => void exportVideo()} disabled={clips.length === 0 || isExporting}>
              {isExporting ? "Rendering MOV…" : "Export MOV"}
            </button>
          </div>
          <p className="ff-editor-instructions">
            Create sequences with + New. Add videos with + to the active sequence; rename or switch sequences here. Drag clips to reorder; right-click or select a clip and press Delete to remove it. Exports are H.264 MOV at 1280 × 720 with AAC audio.
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
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const draggedId = event.dataTransfer.getData("text/plain");
                        if (draggedId) moveClipTo(draggedId, index);
                      }}
                    >
                      <button
                        type="button"
                        className="ff-editor-clip-select"
                        draggable={!isExporting}
                        ref={(element) => {
                          if (element) clipButtonRefs.current.set(clip.id, element);
                          else clipButtonRefs.current.delete(clip.id);
                        }}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/plain", clip.id);
                          event.dataTransfer.effectAllowed = "move";
                          selectClip(clip.id);
                          setClipContextMenu(null);
                        }}
                        onClick={() => {
                          selectClip(clip.id);
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
          <p className="ff-editor-footer">Server export requires FFmpeg with libx264 installed. Clips are uploaded for rendering and removed from the server afterward; keep this tab open until the download starts.</p>
        </div>
      </div>
    </section>
  );
}
