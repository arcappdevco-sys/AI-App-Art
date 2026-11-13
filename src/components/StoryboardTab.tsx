"use client";

import { useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import {
  STORYBOARD_ASPECT_RATIOS,
  STORYBOARD_CAMERA_MOVES,
  STORYBOARD_SHOT_TYPES,
  createStoryboardScene,
  createStoryboardShot,
  type StoryboardData,
  type StoryboardScene,
  type StoryboardShot,
} from "@/lib/StoryboardData";

type ShotLocation = { sceneId: string; shotId: string; sceneIndex: number; shotIndex: number };
type DraggedShot = { sceneId: string; shotId: string };

function readDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Could not read the image file."));
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.readAsDataURL(file);
  });
}

async function storyboardImageDataUrl(file: File) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  const image = await createImageBitmap(file);
  try {
    if (Math.max(image.width, image.height) <= 2048) return await readDataUrl(file);
    const scale = 2048 / Math.max(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image resizing is not available in this browser.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const resized = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob
        ? resolve(blob)
        : reject(new Error("Could not resize the image.")), file.type, file.type === "image/png" ? undefined : 0.9);
    });
    if (resized.type !== file.type) {
      throw new Error(`This browser cannot preserve ${file.type.slice(6).toUpperCase()} while resizing the image.`);
    }
    return await readDataUrl(resized);
  } finally {
    image.close();
  }
}

function shotHasContent(shot: StoryboardShot) {
  return Boolean(
    shot.title.trim()
    || shot.description.trim()
    || shot.shotType
    || shot.cameraMove
    || shot.durationSeconds !== null
    || shot.notes.trim()
    || shot.frame,
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
  hidden,
  saveError,
}: {
  storyboard: StoryboardData;
  onChange: (value: SetStateAction<StoryboardData>) => void;
  hidden: boolean;
  saveError: string;
}) {
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(() => new Set());
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const draggedShot = useRef<DraggedShot | null>(null);
  const locations = useMemo(() => shotLocations(storyboard.scenes), [storyboard.scenes]);
  const shotNumbers = useMemo(() => new Map(locations.map((location, index) => [location.shotId, index + 1])), [locations]);
  const ratio = storyboard.aspectRatio.replace(":", " / ");

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
      updateShot(sceneId, shotId, { frame });
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
                                  updateShot(scene.id, shot.id, { frame: null });
                                  setImageErrors((current) => ({ ...current, [shot.id]: "" }));
                                }}>Remove image</button>
                            </>
                          ) : (
                            <span><strong>＋</strong> Add frame image <small>PNG, JPEG, or WebP · or paste</small></span>
                          )}
                        </div>
                        {imageErrors[shot.id] && <p className="storyboard-inline-error" role="status">{imageErrors[shot.id]}</p>}
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
