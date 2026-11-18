"use client";

import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import {
  STORYBOARD_ASPECT_RATIOS,
  STORYBOARD_CAMERA_MOVES,
  STORYBOARD_SCRIPT_MAX_CHARACTERS,
  STORYBOARD_SHOT_TYPES,
  createStoryboardScene,
  createStoryboardShot,
  type StoryboardData,
  type StoryboardGeneratedTake,
  type StoryboardScene,
  type StoryboardShot,
} from "@/lib/StoryboardData";
import { STORYBOARD_FRAME_MODELS, buildStoryboardFramePrompt, generateStoryboardFrame, type StoryboardFrameModelId } from "@/lib/StoryboardFrameGeneration";
import { storyboardImageDataUrl } from "@/lib/StoryboardImages";
import { inspectImageDataUrlMetadata } from "@/lib/project-media-browser";
import { normalizeGeneratedStoryboard } from "@/lib/StoryboardScript";
import type {
  FirstLastFrameModelOption,
  ImageToVideoModelOption,
} from "@/lib/workflow-node-factory";
import { isAtlasVideoNode } from "@/lib/media-preview";
import { usePlayableVideo } from "@/lib/use-playable-video";
import type { StoryboardVideoCandidate } from "@/lib/storyboard-workflow";

type ShotLocation = { sceneId: string; shotId: string; sceneIndex: number; shotIndex: number };
type DraggedShot = { sceneId: string; shotId: string };
type PendingFirstLastFrame = { sceneId: string; shotId: string; videoType: string };

function shotHasContent(shot: StoryboardShot) {
  return Boolean(
    shot.title.trim()
    || shot.description.trim()
    || shot.shotType
    || shot.cameraMove
    || shot.durationSeconds !== null
    || shot.notes.trim()
    || shot.frame
    || Boolean(shot.generatedTakes?.length),
  );
}

function StoryboardTakeVideo({ take }: { take: Pick<StoryboardGeneratedTake, "videoType" | "videoUrl"> }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const isAtlasVideo = isAtlasVideoNode(take.videoType);
  const playable = usePlayableVideo(
    previewOpen && isAtlasVideo && /^https?:\/\//i.test(take.videoUrl) ? take.videoUrl : undefined,
  );
  return (
    <div className="storyboard-take-preview">
      <button type="button" className="storyboard-take-preview-toggle"
        aria-expanded={previewOpen}
        onClick={() => {
          setPreviewOpen((current) => !current);
          setFailed(false);
        }}>
        {previewOpen ? "Hide preview" : "Preview video"}
      </button>
      {previewOpen && (playable.error ? (
        <p className="storyboard-take-error" role="status">
          Could not load the video preview. <a href={take.videoUrl} target="_blank" rel="noreferrer">Open original</a>
        </p>
      ) : isAtlasVideo && playable.loading ? (
        <p className="storyboard-take-loading" role="status">Loading video preview…</p>
      ) : failed ? (
        <p className="storyboard-take-error" role="status">
          The browser could not play this video. <a href={take.videoUrl} target="_blank" rel="noreferrer">Open original</a>
        </p>
      ) : (
        <video
          src={isAtlasVideo ? playable.src : take.videoUrl}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
        />
      ))}
    </div>
  );
}

function cloneShot(shot: StoryboardShot): StoryboardShot {
  return { ...shot, id: crypto.randomUUID() };
}

function shotLocations(scenes: StoryboardScene[]): ShotLocation[] {
  return scenes.flatMap((scene, sceneIndex) => scene.shots.map((shot, shotIndex) => ({
    sceneId: scene.id,
    shotId: shot.id,
    sceneIndex,
    shotIndex,
  })));
}

function nextSceneNumber(scenes: StoryboardScene[]) {
  const numbers = scenes.flatMap((scene) => {
    const match = /^Scene (\d+)$/.exec(scene.title);
    return match ? [Number(match[1])] : [];
  });
  return Math.max(0, ...numbers) + 1;
}

export default function StoryboardTab({
  storyboard,
  onChange,
  onSendFrame,
  onOpenWorkflow,
  videoCandidates,
  videoModelOptions,
  firstLastFrameModelOptions,
  hidden,
  saveError,
}: {
  storyboard: StoryboardData;
  onChange: (value: SetStateAction<StoryboardData>) => void;
  onSendFrame: (
    sceneId: string,
    shotId: string,
    videoType: string,
    lastFrame?: { sceneId: string; shotId: string },
  ) => void;
  onOpenWorkflow: (workflowId: string) => void;
  videoCandidates: StoryboardVideoCandidate[];
  videoModelOptions: ImageToVideoModelOption[];
  firstLastFrameModelOptions: FirstLastFrameModelOption[];
  hidden: boolean;
  saveError: string;
}) {
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(() => new Set());
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const [scriptText, setScriptText] = useState("");
  const [scriptFileName, setScriptFileName] = useState("");
  const [scriptError, setScriptError] = useState("");
  const [generatingStoryboard, setGeneratingStoryboard] = useState(false);
  const [frameModel, setFrameModel] = useState<StoryboardFrameModelId>(STORYBOARD_FRAME_MODELS[0].id);
  const [generatingShotIds, setGeneratingShotIds] = useState<Set<string>>(() => new Set());
  const [frameErrors, setFrameErrors] = useState<Record<string, string>>({});
  const [frameBatchProgress, setFrameBatchProgress] = useState("");
  const [generatingMissingFrames, setGeneratingMissingFrames] = useState(false);
  const [workflowPickerShotId, setWorkflowPickerShotId] = useState<string | null>(null);
  const [pendingFirstLastFrame, setPendingFirstLastFrame] = useState<PendingFirstLastFrame | null>(null);
  const draggedShot = useRef<DraggedShot | null>(null);
  const locations = useMemo(() => shotLocations(storyboard.scenes), [storyboard.scenes]);
  const shotNumbers = useMemo(() => new Map(locations.map((location, index) => [location.shotId, index + 1])), [locations]);
  const frameChoices = useMemo(() => locations.flatMap((location) => {
    const scene = storyboard.scenes[location.sceneIndex];
    const shot = scene.shots[location.shotIndex];
    if (!shot.frame) return [];
    return [{
      sceneId: scene.id,
      shotId: shot.id,
      label: `${scene.title} · ${shot.title.trim() || `Shot ${location.shotIndex + 1}`}`,
    }];
  }), [locations, storyboard.scenes]);
  const ratio = storyboard.aspectRatio.replace(":", " / ");

  const handleScriptFile = async (file?: File) => {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!["txt", "md", "fountain"].includes(extension ?? "")
      && !["text/plain", "text/markdown", "application/octet-stream"].includes(file.type)) {
      setScriptError("Choose a .txt, .md, or .fountain script file.");
      return;
    }
    if (file.size > STORYBOARD_SCRIPT_MAX_CHARACTERS * 4) {
      setScriptError(`Scripts must be ${STORYBOARD_SCRIPT_MAX_CHARACTERS.toLocaleString()} characters or fewer.`);
      return;
    }
    try {
      const text = await file.text();
      if (text.length > STORYBOARD_SCRIPT_MAX_CHARACTERS) {
        setScriptError(`Scripts must be ${STORYBOARD_SCRIPT_MAX_CHARACTERS.toLocaleString()} characters or fewer.`);
        return;
      }
      setScriptText(text);
      setScriptFileName(file.name);
      setScriptError("");
    } catch {
      setScriptError("Could not read that script file.");
    }
  };

  const buildStoryboardFromScript = async () => {
    if (!scriptText.trim() || generatingStoryboard) return;
    if (storyboard.scenes.length > 0
      && !window.confirm("Replace all current scenes and shots with the generated storyboard?")) return;
    setGeneratingStoryboard(true);
    setScriptError("");
    try {
      const response = await fetch("/api/storyboard/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: scriptText }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error
          : `Storyboard generation failed (${response.status}).`;
        throw new Error(message);
      }
      const generated = normalizeGeneratedStoryboard(result);
      onChange((current) => ({ ...current, scenes: generated.scenes }));
      setSelectedSceneId(generated.scenes[0]?.id ?? "");
    } catch (error) {
      setScriptError(error instanceof Error ? error.message : "Could not generate the storyboard.");
    } finally {
      setGeneratingStoryboard(false);
    }
  };

  const generateFrameForShot = async (scene: StoryboardScene, shot: StoryboardShot) => {
    setGeneratingShotIds((current) => new Set(current).add(shot.id));
    setFrameErrors((current) => ({ ...current, [shot.id]: "" }));
    try {
      const prompt = buildStoryboardFramePrompt(scene, shot, storyboard.aspectRatio);
      const frame = await generateStoryboardFrame(frameModel, prompt, storyboard.aspectRatio);
      const frameMetadata = await inspectImageDataUrlMetadata(frame);
      onChange((current) => ({
        ...current,
        scenes: current.scenes.map((item) => ({
          ...item,
          shots: item.shots.map((candidate) => candidate.id === shot.id
            ? { ...candidate, frame, frameMetadata }
            : candidate),
        })),
      }));
    } catch (error) {
      setFrameErrors((current) => ({
        ...current,
        [shot.id]: error instanceof Error ? error.message : "Could not generate this frame.",
      }));
      throw error;
    } finally {
      setGeneratingShotIds((current) => {
        const next = new Set(current);
        next.delete(shot.id);
        return next;
      });
    }
  };

  const generateMissingFrames = async () => {
    const missingShots = storyboard.scenes.flatMap((scene) => scene.shots
      .filter((shot) => !shot.frame && Boolean(shot.title.trim() || shot.description.trim()))
      .map((shot) => ({ scene, shot })));
    if (!missingShots.length || generatingMissingFrames) return;
    const model = STORYBOARD_FRAME_MODELS.find((item) => item.id === frameModel);
    if (!window.confirm(`Generate ${missingShots.length} image${missingShots.length === 1 ? "" : "s"} with ${model?.label ?? frameModel}? Each image may incur API charges. Continue?`)) return;
    setGeneratingMissingFrames(true);
    setFrameBatchProgress(`Generating 0 of ${missingShots.length} frames…`);
    let completed = 0;
    for (const { scene, shot } of missingShots) {
      try {
        await generateFrameForShot(scene, shot);
      } catch {
        // Keep processing the remaining shots and report each failure on its card.
      } finally {
        completed += 1;
        setFrameBatchProgress(`Generating ${completed} of ${missingShots.length} frames…`);
      }
    }
    setGeneratingMissingFrames(false);
    setFrameBatchProgress(`Finished: ${completed} frame${completed === 1 ? "" : "s"} processed. Review any shot-level errors.`);
  };

  const addScene = () => {
    const scene = createStoryboardScene(nextSceneNumber(storyboard.scenes));
    setSelectedSceneId(scene.id);
    onChange((current) => ({ ...current, scenes: [...current.scenes, scene] }));
  };

  const addShot = () => {
    const currentScene = storyboard.scenes.find((scene) => scene.id === selectedSceneId)
      ?? storyboard.scenes.at(-1);
    const shot = createStoryboardShot();
    if (currentScene) {
      setSelectedSceneId(currentScene.id);
      onChange((current) => ({
        ...current,
        scenes: current.scenes.map((scene) => scene.id === currentScene.id
          ? { ...scene, shots: [...scene.shots, shot] }
          : scene),
      }));
      return;
    }
    const scene = createStoryboardScene(1);
    setSelectedSceneId(scene.id);
    onChange((current) => ({ ...current, scenes: [...current.scenes, { ...scene, shots: [shot] }] }));
  };

  const updateShot = (sceneId: string, shotId: string, patch: Partial<StoryboardShot>) => {
    onChange((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => scene.id !== sceneId ? scene : {
        ...scene,
        shots: scene.shots.map((shot) => shot.id === shotId ? { ...shot, ...patch } : shot),
      }),
    }));
  };
  const addGeneratedTake = (
    sceneId: string,
    shotId: string,
    candidate: StoryboardVideoCandidate,
  ) => {
    const take: StoryboardGeneratedTake = {
      id: crypto.randomUUID(),
      sourceId: candidate.sourceId,
      workflowId: candidate.workflowId,
      nodeId: candidate.nodeId,
      outputPort: candidate.outputPort,
      videoType: candidate.videoType,
      videoUrl: candidate.videoUrl,
      model: candidate.model,
      prompt: candidate.prompt,
      createdAt: Date.now(),
    };
    onChange((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => scene.id !== sceneId ? scene : {
        ...scene,
        shots: scene.shots.map((shot) => {
          if (shot.id !== shotId) return shot;
          const currentTakes = shot.generatedTakes ?? [];
          if (currentTakes.some((saved) =>
            saved.sourceId === take.sourceId && saved.videoUrl === take.videoUrl)) return shot;
          return { ...shot, generatedTakes: [...currentTakes, take] };
        }),
      }),
    }));
  };

  const updateScene = (sceneId: string, patch: Partial<StoryboardScene>) => {
    onChange((current) => ({
      ...current,
      scenes: current.scenes.map((scene) => scene.id === sceneId ? { ...scene, ...patch } : scene),
    }));
  };

  const removeScene = (scene: StoryboardScene) => {
    if (scene.shots.length > 0
      && !window.confirm(`Delete "${scene.title}" and its ${scene.shots.length} shots? This cannot be undone.`)) return;
    onChange((current) => ({ ...current, scenes: current.scenes.filter((item) => item.id !== scene.id) }));
    if (selectedSceneId === scene.id) setSelectedSceneId("");
  };

  const moveScene = (sceneIndex: number, direction: -1 | 1) => {
    const destination = sceneIndex + direction;
    if (destination < 0 || destination >= storyboard.scenes.length) return;
    onChange((current) => {
      const scenes = [...current.scenes];
      [scenes[sceneIndex], scenes[destination]] = [scenes[destination], scenes[sceneIndex]];
      return { ...current, scenes };
    });
  };

  const moveShotTo = (
    sourceSceneId: string,
    sourceShotId: string,
    destinationSceneId: string,
    targetShotId?: string,
    afterTarget = false,
  ) => {
    onChange((current) => {
      const sourceScene = current.scenes.find((scene) => scene.id === sourceSceneId);
      const sourceShot = sourceScene?.shots.find((shot) => shot.id === sourceShotId);
      if (!sourceScene || !sourceShot) return current;
      const scenes = current.scenes.map((scene) => scene.id === sourceSceneId
        ? { ...scene, shots: scene.shots.filter((shot) => shot.id !== sourceShotId) }
        : scene);
      const destination = scenes.find((scene) => scene.id === destinationSceneId);
      if (!destination) return current;
      const shots = [...destination.shots];
      const targetIndex = targetShotId ? shots.findIndex((shot) => shot.id === targetShotId) : -1;
      const insertAt = targetIndex < 0 ? shots.length : targetIndex + (afterTarget ? 1 : 0);
      shots.splice(insertAt, 0, sourceShot);
      return {
        ...current,
        scenes: scenes.map((scene) => scene.id === destinationSceneId ? { ...scene, shots } : scene),
      };
    });
    setSelectedSceneId(destinationSceneId);
  };

  const moveShotBy = (location: ShotLocation, direction: -1 | 1) => {
    const currentIndex = locations.findIndex((item) => item.shotId === location.shotId);
    const target = locations[currentIndex + direction];
    if (!target) return;
    moveShotTo(location.sceneId, location.shotId, target.sceneId, target.shotId, direction > 0);
  };

  const handleShotDrop = (event: DragEvent<HTMLElement>, sceneId: string, targetShotId?: string) => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedShot.current;
    draggedShot.current = null;
    if (source && source.shotId !== targetShotId) {
      moveShotTo(source.sceneId, source.shotId, sceneId, targetShotId);
    }
  };

  const handleImageFile = async (sceneId: string, shotId: string, file?: File) => {
    if (!file) return;
    try {
      const frame = await storyboardImageDataUrl(file);
      const frameMetadata = await inspectImageDataUrlMetadata(frame);
      updateShot(sceneId, shotId, { frame, frameMetadata });
      setImageErrors((current) => ({ ...current, [shotId]: "" }));
    } catch (error) {
      setImageErrors((current) => ({
        ...current,
        [shotId]: error instanceof Error ? error.message : "Could not load this image.",
      }));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>, sceneId: string, shotId: string) => {
    const file = Array.from(event.clipboardData.items)
      .find((item) => item.kind === "file")?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void handleImageFile(sceneId, shotId, file);
  };

  const isolateWorkflowKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Delete" || event.key === "Backspace"
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g")) {
      event.stopPropagation();
    }
  };

  return (
    <main className="storyboard-workspace" hidden={hidden} aria-label="Storyboard workspace"
      onKeyDownCapture={isolateWorkflowKeys}>
      <header className="storyboard-toolbar">
        <label className="storyboard-title-label">
          <span>Storyboard</span>
          <input aria-label="Storyboard title" value={storyboard.title}
            onChange={(event) => onChange((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label className="storyboard-ratio-label">
          <span>Aspect ratio</span>
          <select aria-label="Storyboard aspect ratio" value={storyboard.aspectRatio}
            onChange={(event) => onChange((current) => ({
              ...current,
              aspectRatio: event.target.value as StoryboardData["aspectRatio"],
            }))}>
            {STORYBOARD_ASPECT_RATIOS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <div className="storyboard-toolbar-actions">
          <button type="button" onClick={addScene}>Add scene</button>
          <button type="button" className="storyboard-primary-action" onClick={addShot}>Add shot</button>
        </div>
      </header>

      <section className="storyboard-script-panel" aria-labelledby="storyboard-script-heading">
        <div className="storyboard-script-heading-row">
          <div>
            <h2 id="storyboard-script-heading">Build from a script</h2>
            <p>Upload or paste a script, then explicitly send it to OpenAI to create scenes and shots.</p>
          </div>
          <label className="storyboard-script-upload">
            Upload script
            <input type="file" accept=".txt,.md,.fountain,text/plain,text/markdown"
              aria-label="Upload a .txt, .md, or .fountain script"
              onChange={(event) => {
                void handleScriptFile(event.target.files?.[0]);
                event.target.value = "";
              }} />
          </label>
        </div>
        <textarea className="storyboard-script-input" aria-label="Script text"
          placeholder="Paste your script here…"
          maxLength={STORYBOARD_SCRIPT_MAX_CHARACTERS}
          value={scriptText}
          onChange={(event) => {
            setScriptText(event.target.value);
            setScriptError("");
          }} />
        <div className="storyboard-script-footer">
          <span>{scriptFileName ? `${scriptFileName} · ` : ""}{scriptText.length.toLocaleString()} / {STORYBOARD_SCRIPT_MAX_CHARACTERS.toLocaleString()} characters</span>
          <button type="button" className="storyboard-primary-action"
            disabled={!scriptText.trim() || generatingStoryboard}
            onClick={() => void buildStoryboardFromScript()}>
            {generatingStoryboard ? "Building storyboard…" : "Build storyboard"}
          </button>
        </div>
        <p className="storyboard-script-disclosure">
          Your script is sent to OpenAI only when you choose Build storyboard. Your configured OpenAI API key is used; API usage may be billed. Generated shots have no frame images.
        </p>
        {scriptError && <p className="storyboard-inline-error" role="alert">{scriptError}</p>}
      </section>

      <section className="storyboard-image-panel" aria-labelledby="storyboard-image-heading">
        <div className="storyboard-image-heading">
          <div>
            <h2 id="storyboard-image-heading">Generate shot frames</h2>
            <p>Choose an image model, then generate missing frames from their scene and shot details.</p>
          </div>
        </div>
        <div className="storyboard-image-controls">
          <label>
            <span>Image model</span>
            <select aria-label="Storyboard image model" value={frameModel}
            disabled={generatingShotIds.size > 0 || generatingMissingFrames}
              onChange={(event) => setFrameModel(event.target.value as StoryboardFrameModelId)}>
              {STORYBOARD_FRAME_MODELS.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          </label>
          <button type="button" className="storyboard-primary-action"
            disabled={generatingMissingFrames || generatingShotIds.size > 0
              || !storyboard.scenes.some((scene) => scene.shots.some((shot) =>
                !shot.frame && Boolean(shot.title.trim() || shot.description.trim())))}
            onClick={() => void generateMissingFrames()}>
            {generatingMissingFrames ? "Generating frames…" : "Generate missing frames"}
          </button>
          {frameBatchProgress && <span className="storyboard-image-progress" role="status">{frameBatchProgress}</span>}
        </div>
        <p className="storyboard-image-disclosure">
          Generation sends scene and shot details to the selected provider. API usage may be billed. Generated images are stored with this project; they are resized to fit the storyboard’s local image limit.
        </p>
      </section>

      {saveError && <p className="storyboard-storage-error" role="alert">Could not save this storyboard: {saveError}</p>}

      <div className="storyboard-board">
        {storyboard.scenes.length === 0 ? (
          <section className="storyboard-empty">
            <span aria-hidden="true">▧</span>
            <strong>No shots yet</strong>
            <button type="button" className="storyboard-primary-action" onClick={addScene}>Add your first scene</button>
          </section>
        ) : storyboard.scenes.map((scene, sceneIndex) => (
          <section className="storyboard-scene" key={scene.id}
            onFocusCapture={() => setSelectedSceneId(scene.id)}
            onDragOver={(event) => {
              if (draggedShot.current) event.preventDefault();
            }}
            onDrop={(event) => handleShotDrop(event, scene.id)}>
            <header className="storyboard-scene-header">
              <button type="button" className="storyboard-collapse"
                aria-label={`${scene.collapsed ? "Expand" : "Collapse"} ${scene.title}`}
                aria-expanded={!scene.collapsed}
                onClick={() => updateScene(scene.id, { collapsed: !scene.collapsed })}>
                {scene.collapsed ? "▸" : "▾"}
              </button>
              <input className="storyboard-scene-title" aria-label={`Scene ${sceneIndex + 1} title`}
                value={scene.title} onChange={(event) => updateScene(scene.id, { title: event.target.value })} />
              <span className="storyboard-shot-count">{scene.shots.length} {scene.shots.length === 1 ? "shot" : "shots"}</span>
              <div className="storyboard-scene-actions">
                <button type="button" aria-label={`Move ${scene.title} up`} title="Move up"
                  disabled={sceneIndex === 0} onClick={() => moveScene(sceneIndex, -1)}>↑</button>
                <button type="button" aria-label={`Move ${scene.title} down`} title="Move down"
                  disabled={sceneIndex === storyboard.scenes.length - 1}
                  onClick={() => moveScene(sceneIndex, 1)}>↓</button>
                <button type="button" className="storyboard-delete-action" aria-label={`Delete ${scene.title}`}
                  onClick={() => removeScene(scene)}>Delete scene</button>
              </div>
            </header>
            {!scene.collapsed && (
              <>
                <div className="storyboard-shot-grid">
                  {scene.shots.map((shot, shotIndex) => {
                    const location = locations.find((item) => item.shotId === shot.id)!;
                    const number = shotNumbers.get(shot.id)!;
                    const notesOpen = expandedNotes.has(shot.id);
                    const relatedVideoCandidates = videoCandidates.filter((candidate) =>
                      candidate.sourceShotRefs.some((reference) =>
                        reference.sceneId === scene.id && reference.shotId === shot.id,
                      ),
                    );
                    const savedTakes = shot.generatedTakes ?? [];
                    const availableVideoCandidates = relatedVideoCandidates.filter((candidate) =>
                      !savedTakes.some((take) =>
                        take.sourceId === candidate.sourceId && take.videoUrl === candidate.videoUrl,
                      ),
                    );
                    const frameStyle = { aspectRatio: ratio };
                    const updateNotesOpen = () => setExpandedNotes((current) => {
                      const next = new Set(current);
                      if (next.has(shot.id)) next.delete(shot.id);
                      else next.add(shot.id);
                      return next;
                    });
                    return (
                      <article className="storyboard-shot-card" key={shot.id} role="group"
                        aria-label={`Shot ${number} card`} tabIndex={0}
                        onPaste={(event) => handlePaste(event, scene.id, shot.id)}
                        onDragOver={(event) => {
                          if (draggedShot.current) event.preventDefault();
                        }}
                        onDrop={(event) => handleShotDrop(event, scene.id, shot.id)}>
                        <div className="storyboard-shot-card-header">
                          <span className="storyboard-shot-number">Shot {number}</span>
                          <button type="button" className="storyboard-drag-handle" draggable
                            aria-label={`Drag Shot ${number}`}
                            onDragStart={(event) => {
                              draggedShot.current = { sceneId: scene.id, shotId: shot.id };
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", shot.id);
                            }}
                            onDragEnd={() => { draggedShot.current = null; }}>⠿</button>
                          <div className="storyboard-shot-actions">
                            <button type="button" aria-label={`Move Shot ${number} earlier`} title="Move earlier"
                              disabled={locations.indexOf(location) === 0}
                              onClick={() => moveShotBy(location, -1)}>←</button>
                            <button type="button" aria-label={`Move Shot ${number} later`} title="Move later"
                              disabled={locations.indexOf(location) === locations.length - 1}
                              onClick={() => moveShotBy(location, 1)}>→</button>
                            <button type="button" aria-label={`Duplicate Shot ${number}`} title="Duplicate shot"
                              onClick={() => {
                                const duplicate = cloneShot(shot);
                                onChange((current) => ({
                                  ...current,
                                  scenes: current.scenes.map((item) => item.id !== scene.id ? item : {
                                    ...item,
                                    shots: [
                                      ...item.shots.slice(0, shotIndex + 1),
                                      duplicate,
                                      ...item.shots.slice(shotIndex + 1),
                                    ],
                                  }),
                                }));
                              }}>Duplicate</button>
                            {shot.frame && <div className="storyboard-workflow-picker">
                              <button type="button" title="Choose a video AI for this shot"
                                aria-label={`Choose a video AI for Shot ${number}`}
                                aria-haspopup="menu"
                                aria-expanded={workflowPickerShotId === shot.id}
                                aria-controls={`storyboard-video-models-${number}`}
                                onClick={() => {
                                  const closing = workflowPickerShotId === shot.id;
                                  setWorkflowPickerShotId(closing ? null : shot.id);
                                  setPendingFirstLastFrame(null);
                                }}>To workflow ▾</button>
                              {workflowPickerShotId === shot.id && <div
                                id={`storyboard-video-models-${number}`}
                                className="storyboard-workflow-picker-menu"
                                role="group"
                                aria-label={`Choose a video AI and frame mode for Shot ${number}`}
                                onKeyDown={(event) => {
                                  if (event.key !== "Escape") return;
                                  if (pendingFirstLastFrame?.shotId === shot.id) setPendingFirstLastFrame(null);
                                  else setWorkflowPickerShotId(null);
                                }}>
                                {pendingFirstLastFrame?.sceneId === scene.id
                                  && pendingFirstLastFrame.shotId === shot.id ? (
                                  <>
                                    <div className="storyboard-workflow-picker-heading">
                                      <span>Choose the last frame</span>
                                      <button type="button" onClick={() => setPendingFirstLastFrame(null)}>Back</button>
                                    </div>
                                    {frameChoices.filter((choice) =>
                                      choice.sceneId !== scene.id || choice.shotId !== shot.id,
                                    ).map((choice) => <button key={`${choice.sceneId}-${choice.shotId}`} type="button"
                                      onClick={() => {
                                        setWorkflowPickerShotId(null);
                                        setPendingFirstLastFrame(null);
                                        onSendFrame(scene.id, shot.id, pendingFirstLastFrame.videoType, choice);
                                      }}>{choice.label}</button>)}
                                    {frameChoices.every((choice) =>
                                      choice.sceneId === scene.id && choice.shotId === shot.id,
                                    ) && <p className="storyboard-workflow-picker-empty">
                                      Add a frame to another shot before choosing a last frame.
                                    </p>}
                                  </>
                                ) : (
                                  <>
                                    <div className="storyboard-workflow-picker-section">
                                      <span>Image to video</span>
                                      {videoModelOptions.map((option) => <button key={option.type} type="button"
                                        onClick={() => {
                                          setWorkflowPickerShotId(null);
                                          onSendFrame(scene.id, shot.id, option.type);
                                        }}>{option.label}</button>)}
                                    </div>
                                    {firstLastFrameModelOptions.length > 0 && <div
                                      className="storyboard-workflow-picker-section">
                                      <span>First + last frame</span>
                                      {firstLastFrameModelOptions.map((option) => <button
                                        key={option.type}
                                        type="button"
                                        onClick={() => setPendingFirstLastFrame({
                                          sceneId: scene.id,
                                          shotId: shot.id,
                                          videoType: option.type,
                                        })}>{option.label}</button>)}
                                    </div>}
                                  </>
                                )}
                              </div>}
                            </div>}
                            <button type="button" className="storyboard-delete-action"
                              aria-label={`Delete Shot ${number}`} title="Delete shot" onClick={() => {
                                if (shotHasContent(shot)
                                  && !window.confirm(`Delete Shot ${number}? This cannot be undone.`)) return;
                                onChange((current) => ({
                                  ...current,
                                  scenes: current.scenes.map((item) => item.id !== scene.id ? item : {
                                    ...item,
                                    shots: item.shots.filter((candidate) => candidate.id !== shot.id),
                                  }),
                                }));
                              }}>Delete</button>
                          </div>
                        </div>
                        <input className="storyboard-file-input" type="file"
                          accept="image/png,image/jpeg,image/webp" aria-label={`Choose image for Shot ${number}`}
                          onChange={(event) => {
                            void handleImageFile(scene.id, shot.id, event.target.files?.[0]);
                            event.target.value = "";
                          }} />
                        <div className="storyboard-frame" style={frameStyle}
                          role="button" tabIndex={0} aria-label={`Choose or paste a frame image for Shot ${number}`}
                          onClick={(event) => {
                            if ((event.target as HTMLElement).closest("button")) return;
                            event.currentTarget.parentElement?.querySelector<HTMLInputElement>(".storyboard-file-input")?.click();
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.currentTarget.parentElement?.querySelector<HTMLInputElement>(".storyboard-file-input")?.click();
                            }
                          }}
                          onDragOver={(event) => {
                            if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
                          }}
                          onDrop={(event) => {
                            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                            event.preventDefault();
                            event.stopPropagation();
                            void handleImageFile(scene.id, shot.id, event.dataTransfer.files[0]);
                          }}>
                          {shot.frame ? (
                            <>
                              {/* The frame uses object-fit for display only; the saved data URL remains unchanged. */}
                              <img src={shot.frame} alt={`Frame for Shot ${number}`} />
                              <button type="button" className="storyboard-remove-image"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  updateShot(scene.id, shot.id, { frame: null, frameMetadata: undefined });
                                  setImageErrors((current) => ({ ...current, [shot.id]: "" }));
                                }}>Remove image</button>
                            </>
                          ) : (
                            <span><strong>＋</strong> Add frame image <small>PNG, JPEG, or WebP · or paste</small></span>
                          )}
                        </div>
                        <button type="button" className="storyboard-generate-frame"
                          disabled={generatingShotIds.size > 0 || generatingMissingFrames
                            || !(shot.title.trim() || shot.description.trim())}
                          onClick={() => void generateFrameForShot(scene, shot).catch(() => undefined)}>
                          {generatingShotIds.has(shot.id) ? "Generating frame…" : shot.frame ? "Regenerate frame" : "Generate frame"}
                        </button>
                        {frameErrors[shot.id] && <p className="storyboard-inline-error" role="alert">{frameErrors[shot.id]}</p>}
                        {imageErrors[shot.id] && <p className="storyboard-inline-error" role="status">{imageErrors[shot.id]}</p>}
                        {(savedTakes.length > 0 || availableVideoCandidates.length > 0) && (
                          <section className="storyboard-generated-takes"
                            aria-label={`Generated video takes for Shot ${number}`}>
                            <div className="storyboard-generated-takes-heading">
                              <strong>Generated takes</strong>
                              <span>{savedTakes.length} saved</span>
                            </div>
                            {savedTakes.map((take) => (
                              <article className="storyboard-take" key={take.id}>
                                <StoryboardTakeVideo take={take} />
                                <div className="storyboard-take-meta">
                                  <strong>{take.model}</strong>
                                  <time dateTime={new Date(take.createdAt).toISOString()}>
                                    {new Date(take.createdAt).toLocaleString()}
                                  </time>
                                </div>
                                {take.prompt && <details className="storyboard-take-prompt">
                                  <summary>Prompt used</summary>
                                  <p>{take.prompt}</p>
                                </details>}
                                <div className="storyboard-take-actions">
                                  <button type="button" className="storyboard-take-open"
                                    onClick={() => onOpenWorkflow(take.workflowId)}>
                                    Open source workflow
                                  </button>
                                  <button type="button" className="storyboard-take-remove"
                                    aria-label={`Remove generated take from Shot ${number}`}
                                    onClick={() => updateShot(scene.id, shot.id, {
                                      generatedTakes: savedTakes.filter((saved) => saved.id !== take.id),
                                    })}>Remove take</button>
                                </div>
                              </article>
                            ))}
                            {availableVideoCandidates.map((candidate) => (
                              <article className="storyboard-take storyboard-take-available"
                                key={`${candidate.sourceId}:${candidate.videoUrl}`}>
                                <StoryboardTakeVideo take={candidate} />
                                <div className="storyboard-take-meta">
                                  <strong>{candidate.model}</strong>
                                  <span>From current workflow</span>
                                </div>
                                {candidate.prompt && <details className="storyboard-take-prompt">
                                  <summary>Prompt used</summary>
                                  <p>{candidate.prompt}</p>
                                </details>}
                                <button type="button" className="storyboard-take-save"
                                  onClick={() => addGeneratedTake(scene.id, shot.id, candidate)}>
                                  Save as take
                                </button>
                              </article>
                            ))}
                          </section>
                        )}
                        <label className="storyboard-field">
                          <span>Shot title <small>Optional</small></span>
                          <input value={shot.title} aria-label={`Shot ${number} title`}
                            placeholder="Give this shot a title"
                            onChange={(event) => updateShot(scene.id, shot.id, { title: event.target.value })} />
                        </label>
                        <label className="storyboard-field">
                          <span>Description</span>
                          <textarea value={shot.description} aria-label={`Shot ${number} description`}
                            placeholder="Describe what happens in this shot…" rows={4}
                            onChange={(event) => updateShot(scene.id, shot.id, { description: event.target.value })} />
                        </label>
                        <div className="storyboard-shot-fields">
                          <label className="storyboard-field">
                            <span>Shot type</span>
                            <select value={shot.shotType} aria-label={`Shot ${number} type`}
                              onChange={(event) => updateShot(scene.id, shot.id, {
                                shotType: event.target.value as StoryboardShot["shotType"],
                              })}>
                              <option value="">None</option>
                              {STORYBOARD_SHOT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                            </select>
                          </label>
                          <label className="storyboard-field">
                            <span>Camera movement</span>
                            <select value={shot.cameraMove} aria-label={`Shot ${number} camera movement`}
                              onChange={(event) => updateShot(scene.id, shot.id, {
                                cameraMove: event.target.value as StoryboardShot["cameraMove"],
                              })}>
                              <option value="">None</option>
                              {STORYBOARD_CAMERA_MOVES.map((move) => <option key={move} value={move}>{move}</option>)}
                            </select>
                          </label>
                          <label className="storyboard-field storyboard-duration-field">
                            <span>Duration <small>Seconds · optional</small></span>
                            <input type="number" min={0.5} max={60} step={0.5}
                              aria-label={`Shot ${number} duration in seconds`}
                              value={shot.durationSeconds ?? ""}
                              onChange={(event) => {
                                const value = event.target.value === "" ? null : Number(event.target.value);
                                if (value === null || (Number.isFinite(value) && value >= 0.5
                                  && value <= 60 && Number.isInteger(value * 2))) {
                                  updateShot(scene.id, shot.id, { durationSeconds: value });
                                }
                              }} />
                          </label>
                        </div>
                        <div className="storyboard-notes">
                          <button type="button" aria-expanded={notesOpen} onClick={updateNotesOpen}>
                            {notesOpen ? "▾" : "▸"} Notes {shot.notes && !notesOpen ? "· added" : ""}
                          </button>
                          {notesOpen && <label className="storyboard-field">
                            <span className="storyboard-visually-hidden">Shot {number} notes</span>
                            <textarea value={shot.notes} aria-label={`Shot ${number} notes`}
                              placeholder="Add optional notes…" rows={3}
                              onChange={(event) => updateShot(scene.id, shot.id, { notes: event.target.value })} />
                          </label>}
                        </div>
                      </article>
                    );
                  })}
                </div>
                <button type="button" className="storyboard-add-scene-shot" onClick={() => {
                  setSelectedSceneId(scene.id);
                  const shot = createStoryboardShot();
                  onChange((current) => ({
                    ...current,
                    scenes: current.scenes.map((item) => item.id === scene.id
                      ? { ...item, shots: [...item.shots, shot] }
                      : item),
                  }));
                }}>＋ Add shot to {scene.title}</button>
              </>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
