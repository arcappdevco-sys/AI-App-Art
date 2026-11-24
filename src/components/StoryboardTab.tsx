"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import {
  STORYBOARD_ASPECT_RATIOS,
  STORYBOARD_CAMERA_MOVES,
  STORYBOARD_SCRIPT_MAX_CHARACTERS,
  STORYBOARD_SHOT_TYPES,
  createStoryboardScene,
  createStoryboardShot,
  type StoryboardData,
  type StoryboardCharacter,
  type StoryboardCharacterDraft,
  type StoryboardGeneratedTake,
  type StoryboardScene,
  type StoryboardShot,
  type StoryboardStyleBible,
} from "@/lib/StoryboardData";
import {
  findStoryboardCharacterNameHints,
  normalizeStoryboardCharacterAnalysis,
} from "@/lib/storyboard-character-analysis";
import {
  STORYBOARD_FRAME_MODELS,
  buildStoryboardCharacterSheetPrompt,
  buildStoryboardFramePrompt,
  generateStoryboardFrame,
  storyboardFrameModelSupportsCharacterReferences,
  type StoryboardFrameModelId,
} from "@/lib/StoryboardFrameGeneration";
import { loadApprovedCharacterReferenceImage } from "@/lib/project-character-reference";
import { storyboardImageDataUrl } from "@/lib/StoryboardImages";
import { inspectImageDataUrlMetadata } from "@/lib/project-media-browser";
import {
  normalizeGeneratedStoryboard,
  parseStructuredStoryboardScript,
} from "@/lib/StoryboardScript";
import {
  STORYBOARD_SCRIPT_PROVIDERS,
  type StoryboardScriptProvider,
} from "@/lib/storyboard-script-generation";
import type {
  FirstLastFrameModelOption,
  ImageToVideoModelOption,
} from "@/lib/workflow-node-factory";
import { isAtlasVideoNode } from "@/lib/media-preview";
import { usePlayableVideo } from "@/lib/use-playable-video";
import type { StoryboardVideoCandidate } from "@/lib/storyboard-workflow";
import type { ProjectFolderSession } from "@/lib/project-folder-storage";
import { readProjectMediaAssetFile } from "@/lib/project-folder-storage";
import { loadProjectMediaFile } from "@/lib/project-media-storage";
import type { MediaAssetMetadata } from "@/lib/project-media";

type ShotLocation = { sceneId: string; shotId: string; sceneIndex: number; shotIndex: number };
type DraggedShot = { sceneId: string; shotId: string };
type PendingFirstLastFrame = { sceneId: string; shotId: string; videoType: string };
type StoryboardBoardTransform = { x: number; y: number; zoom: number };
type StoryboardPanGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: StoryboardBoardTransform;
};

const STORYBOARD_MIN_ZOOM = 0.25;
const STORYBOARD_MAX_ZOOM = 3;
const TOPVIEW_STORYBOARD_PENDING_KEY = "fal-flow-topview-storyboard-unresolved";

function shotHasContent(shot: StoryboardShot) {
  return Boolean(
    shot.title.trim()
    || shot.description.trim()
    || shot.prompt.trim()
    || shot.shotType
    || shot.cameraMove
    || shot.durationSeconds !== null
    || shot.notes.trim()
    || shot.frame
    || Boolean(shot.generatedTakes?.length),
  );
}

function StoryboardTakeVideo({
  take,
  projectSession,
}: {
  take: Pick<StoryboardGeneratedTake, "videoType" | "videoUrl" | "mediaAssetId">;
  projectSession: ProjectFolderSession | null;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [hasPreviewed, setHasPreviewed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [storedVideoPreview, setStoredVideoPreview] = useState<{
    mediaAssetId: string;
    projectSession: ProjectFolderSession | null;
    url?: string;
    error?: string;
  } | null>(null);
  const mediaAssetId = take.mediaAssetId;
  const isAtlasVideo = isAtlasVideoNode(take.videoType);
  const playable = usePlayableVideo(
    hasPreviewed && !mediaAssetId && isAtlasVideo && /^https?:\/\//i.test(take.videoUrl)
      ? take.videoUrl
      : undefined,
  );
  useEffect(() => {
    if (!hasPreviewed || !mediaAssetId) return;
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      let file: File;
      if (projectSession) {
        try {
          file = await readProjectMediaAssetFile(
            projectSession.handle,
            projectSession.projectId,
            mediaAssetId,
          );
        } catch (projectError) {
          try {
            file = await loadProjectMediaFile(mediaAssetId);
          } catch {
            throw projectError;
          }
        }
      } else {
        file = await loadProjectMediaFile(mediaAssetId);
      }
      if (!file.type.startsWith("video/")) throw new Error("The saved take is not a video file.");
      if (!active) return;
      objectUrl = URL.createObjectURL(file);
      setStoredVideoPreview({ mediaAssetId, projectSession, url: objectUrl });
    })().catch((error: unknown) => {
      if (active) setStoredVideoPreview({
        mediaAssetId,
        projectSession,
        error: error instanceof Error ? error.message : "Could not load the saved video.",
      });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasPreviewed, mediaAssetId, projectSession]);

  const currentStoredPreview = storedVideoPreview
    && storedVideoPreview.mediaAssetId === mediaAssetId
    && storedVideoPreview.projectSession === projectSession
    ? storedVideoPreview
    : null;
  const storedVideoUrl = currentStoredPreview?.url ?? null;
  const storedVideoError = currentStoredPreview?.error ?? "";
  const videoSource = mediaAssetId ? storedVideoUrl : (isAtlasVideo ? playable.src : take.videoUrl);
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <div className="storyboard-take-preview">
      <button type="button" className="storyboard-take-preview-toggle"
        aria-expanded={previewOpen}
        onClick={() => {
          if (previewOpen) {
            videoRef.current?.pause();
            setPreviewOpen(false);
          } else {
            setFailed(false);
            setHasPreviewed(true);
            setPreviewOpen(true);
          }
        }}>
        {previewOpen ? "Hide preview" : "Preview video"}
      </button>
      {previewOpen && mediaAssetId && storedVideoError ? (
        <p className="storyboard-take-error" role="status">
          Could not load the saved video: {storedVideoError}
          {take.videoUrl && <> <a href={take.videoUrl} target="_blank" rel="noreferrer">Try the source link</a></>}
        </p>
      ) : previewOpen && mediaAssetId && !storedVideoUrl ? (
        <p className="storyboard-take-loading" role="status">Loading saved video…</p>
      ) : previewOpen && !mediaAssetId && playable.error ? (
        <p className="storyboard-take-error" role="status">
          Could not load the video preview. <a href={take.videoUrl} target="_blank" rel="noreferrer">Open original</a>
        </p>
      ) : previewOpen && !mediaAssetId && isAtlasVideo && playable.loading ? (
        <p className="storyboard-take-loading" role="status">Loading video preview…</p>
      ) : previewOpen && failed ? (
        <p className="storyboard-take-error" role="status">
          The browser could not play this video. <a href={take.videoUrl} target="_blank" rel="noreferrer">Open original</a>
        </p>
      ) : hasPreviewed && videoSource ? (
        <video
          ref={videoRef}
          src={videoSource}
          controls
          preload="metadata"
          hidden={!previewOpen || failed}
          onError={() => setFailed(true)}
        />
      ) : null}
    </div>
  );
}

function CharacterReferencePreview({
  assetId,
  characterName,
  projectSession,
}: {
  assetId?: string;
  characterName: string;
  projectSession: ProjectFolderSession | null;
}) {
  const [preview, setPreview] = useState<{ assetId: string; url?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!assetId) return;
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      let file: File;
      if (projectSession) {
        try {
          file = await readProjectMediaAssetFile(projectSession.handle, projectSession.projectId, assetId);
        } catch (projectError) {
          try {
            file = await loadProjectMediaFile(assetId);
          } catch {
            throw projectError;
          }
        }
      } else {
        file = await loadProjectMediaFile(assetId);
      }
      if (!file.type.startsWith("image/")) throw new Error("The saved character reference is not an image.");
      if (!active) return;
      objectUrl = URL.createObjectURL(file);
      setPreview({ assetId, url: objectUrl });
    })().catch((error: unknown) => {
      if (active) setPreview({
        assetId,
        error: error instanceof Error ? error.message : "Could not load this character reference.",
      });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, projectSession]);

  const current = preview?.assetId === assetId ? preview : null;
  if (!assetId) return null;
  if (current?.url) {
    // Blob URLs are local project media and cannot benefit from Next image optimization.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="storyboard-character-reference-preview"
      src={current.url} alt={`${characterName} character reference`} />;
  }
  if (current?.error) {
    return <p className="storyboard-inline-error" role="alert">
      Could not load the saved reference: {current.error}
    </p>;
  }
  return <p className="storyboard-character-analysis-note" role="status">Loading character reference…</p>;
}

function CharacterReferenceEditor({
  character,
  styleBible,
  frameModel,
  projectSession,
  referenceKey,
  onSaveAsset,
  onBusyChange,
  onAddToWorkflow,
  onUpdate,
}: {
  character: StoryboardCharacterDraft;
  styleBible?: StoryboardStyleBible;
  frameModel: StoryboardFrameModelId;
  projectSession: ProjectFolderSession | null;
  referenceKey: string;
  onSaveAsset: (file: File, metadata: MediaAssetMetadata) => Promise<string>;
  onBusyChange: (key: string, busy: boolean) => void;
  onAddToWorkflow?: (characterId: string) => void;
  onUpdate: (patch: Partial<StoryboardCharacterDraft>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const model = STORYBOARD_FRAME_MODELS.find((item) => item.id === frameModel);
  const referenceModel = STORYBOARD_FRAME_MODELS.find((item) => item.id === character.referenceImageModel);
  const imageAssetId = character.referenceImageMediaAssetId;

  const uploadReference = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    onBusyChange(referenceKey, true);
    setError("");
    try {
      if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
        throw new Error("Choose an image file of 20 MB or smaller.");
      }
      const dataUrl = await storyboardImageDataUrl(file);
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error("Could not prepare the uploaded character reference.");
      const blob = await response.blob();
      const normalizedFile = new File([blob], file.name, { type: blob.type });
      const metadata = await inspectImageDataUrlMetadata(dataUrl);
      const assetId = await onSaveAsset(normalizedFile, metadata);
      onUpdate({
        referenceImageMediaAssetId: assetId,
        referenceImageApproved: false,
        referenceImageSource: "uploaded",
        referenceImageModel: undefined,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this character reference.");
    } finally {
      setBusy(false);
      onBusyChange(referenceKey, false);
    }
  };

  const generateReference = async () => {
    if (!character.name.trim() || !character.visualDescription.trim() || !model || busy) return;
    if (!window.confirm(
      `Generate a three-view character sheet for ${character.name.trim()} with ${model.label}? This image request may incur provider charges.`,
    )) return;
    setBusy(true);
    onBusyChange(referenceKey, true);
    setError("");
    try {
      const prompt = buildStoryboardCharacterSheetPrompt(character, styleBible);
      const dataUrl = await generateStoryboardFrame(frameModel, prompt, "16:9");
      const response = await fetch(dataUrl);
      if (!response.ok) throw new Error("Could not prepare the generated character sheet.");
      const blob = await response.blob();
      const extension = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
      const safeName = character.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "character";
      const file = new File([blob], `${safeName}-reference.${extension}`, { type: blob.type });
      const metadata = await inspectImageDataUrlMetadata(dataUrl);
      const assetId = await onSaveAsset(file, metadata);
      onUpdate({
        referenceImageMediaAssetId: assetId,
        referenceImageApproved: false,
        referenceImageSource: "generated",
        referenceImageModel: frameModel,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate this character sheet.");
    } finally {
      setBusy(false);
      onBusyChange(referenceKey, false);
    }
  };

  return (
    <div className="storyboard-character-reference">
      {imageAssetId && (
        <>
          <CharacterReferencePreview
            assetId={imageAssetId}
            characterName={character.name || "Character"}
            projectSession={projectSession}
          />
          <p className="storyboard-character-reference-status" role="status">
            {character.referenceImageApproved ? "Approved reference" : "Needs approval"}
            {character.referenceImageSource === "generated"
              ? ` · Generated with ${referenceModel?.label ?? "image model"}`
              : ""}
          </p>
        </>
      )}
      <div className="storyboard-character-reference-actions">
        <label className="storyboard-character-upload">
          {imageAssetId ? "Replace image" : "Upload reference"}
          <input type="file" accept="image/png,image/jpeg,image/webp"
            aria-label={`Upload reference image for ${character.name || "character"}`}
            disabled={busy || !character.name.trim()}
            onChange={(event) => {
              void uploadReference(event.target.files?.[0]);
              event.target.value = "";
            }} />
        </label>
        <button type="button" className="storyboard-secondary-action"
          disabled={busy || !character.name.trim() || !character.visualDescription.trim()}
          onClick={() => void generateReference()}>
          {busy ? "Working…" : imageAssetId ? "Generate replacement" : "Generate character sheet"}
        </button>
        {imageAssetId && (
          <>
            {character.referenceImageApproved && onAddToWorkflow && (
              <button type="button" className="storyboard-secondary-action"
                disabled={busy}
                onClick={() => onAddToWorkflow(referenceKey)}>
                Add reference to Workflow
              </button>
            )}
            <button type="button" className="storyboard-secondary-action"
              disabled={busy}
              onClick={() => onUpdate({ referenceImageApproved: !character.referenceImageApproved })}>
              {character.referenceImageApproved ? "Revoke approval" : "Approve reference"}
            </button>
            <button type="button" className="storyboard-secondary-action"
              disabled={busy}
              onClick={() => onUpdate({
                referenceImageMediaAssetId: undefined,
                referenceImageApproved: false,
                referenceImageSource: undefined,
                referenceImageModel: undefined,
              })}>
              Remove reference
            </button>
          </>
        )}
      </div>
      {error && <p className="storyboard-inline-error" role="alert">{error}</p>}
      {character.visualDescription.trim() ? null : (
        <p className="storyboard-character-analysis-note">Add visual traits before generating a sheet; you can still upload an existing reference.</p>
      )}
    </div>
  );
}

function ShotCharacterReferencePicker({
  shot,
  characters,
  frameModel,
  disabled,
  onChange,
}: {
  shot: StoryboardShot;
  characters: StoryboardCharacter[];
  frameModel: StoryboardFrameModelId;
  disabled: boolean;
  onChange: (characterIds: string[]) => void;
}) {
  const selectedIds = shot.characterIds ?? [];
  const supportsReferences = storyboardFrameModelSupportsCharacterReferences(frameModel);
  return (
    <fieldset className="storyboard-shot-character-references">
      <legend>Character references <small>Up to 3 approved images</small></legend>
      {characters.length ? characters.map((character) => {
        const selected = selectedIds.includes(character.id);
        const approved = character.referenceImageApproved && Boolean(character.referenceImageMediaAssetId);
        return (
          <label key={character.id}>
            <input type="checkbox" checked={selected}
              disabled={disabled || (!approved && !selected) || (!selected && selectedIds.length >= 3)}
              onChange={() => onChange(selected
                ? selectedIds.filter((id) => id !== character.id)
                : [...selectedIds, character.id])} />
            <span>{character.name}{approved ? "" : " (approve a reference first)"}</span>
          </label>
        );
      }) : (
        <p>Save a project cast to assign character references to shots.</p>
      )}
      <small>Only selected references are sent with this shot. Choose a Nano Banana image model to use them.</small>
      {selectedIds.length > 0 && !supportsReferences && (
        <small className="storyboard-inline-error" role="status">
          The selected image model cannot use character references.
        </small>
      )}
    </fieldset>
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
  characters,
  onChange,
  onCharactersChange,
  onSaveCharacterReference,
  onAddCharacterReferenceToWorkflow,
  onSendFrame,
  onOpenWorkflow,
  onSaveTake,
  onSaveTakeCopy,
  videoCandidates,
  projectSession,
  videoModelOptions,
  firstLastFrameModelOptions,
  hidden,
  saveError,
  autoSaveError,
}: {
  storyboard: StoryboardData;
  characters: StoryboardCharacter[];
  onChange: (value: SetStateAction<StoryboardData>) => void;
  onCharactersChange: (value: StoryboardCharacter[]) => void;
  onSaveCharacterReference: (file: File, metadata: MediaAssetMetadata) => Promise<string>;
  onAddCharacterReferenceToWorkflow: (characterId: string) => void;
  onSendFrame: (
    sceneId: string,
    shotId: string,
    videoType: string,
    lastFrame?: { sceneId: string; shotId: string },
  ) => void;
  onOpenWorkflow: (workflowId: string) => void;
  onSaveTake: (sceneId: string, shotId: string, candidate: StoryboardVideoCandidate) => Promise<void>;
  onSaveTakeCopy: (sceneId: string, shotId: string, take: StoryboardGeneratedTake) => Promise<void>;
  videoCandidates: StoryboardVideoCandidate[];
  projectSession: ProjectFolderSession | null;
  videoModelOptions: ImageToVideoModelOption[];
  firstLastFrameModelOptions: FirstLastFrameModelOption[];
  hidden: boolean;
  saveError: string;
  autoSaveError: string;
}) {
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(() => new Set());
  const [imageErrors, setImageErrors] = useState<Record<string, string>>({});
  const [scriptText, setScriptText] = useState("");
  const [scriptFileName, setScriptFileName] = useState("");
  const [scriptError, setScriptError] = useState("");
  const [scriptProvider, setScriptProvider] = useState<StoryboardScriptProvider>("gemini");
  const [characterAnalysisModels, setCharacterAnalysisModels] = useState<string[]>([]);
  const [characterAnalysisModel, setCharacterAnalysisModel] = useState("");
  const [loadingCharacterAnalysisModels, setLoadingCharacterAnalysisModels] = useState(false);
  const [characterAnalysisModelError, setCharacterAnalysisModelError] = useState("");
  const [characterAnalysisError, setCharacterAnalysisError] = useState("");
  const [characterAnalysisCandidates, setCharacterAnalysisCandidates] = useState<StoryboardCharacter[]>([]);
  const [savingCharacterReferenceIds, setSavingCharacterReferenceIds] = useState<Set<string>>(() => new Set());
  const [characterAnalysisRun, setCharacterAnalysisRun] = useState(false);
  const [characterAnalysisSourceScript, setCharacterAnalysisSourceScript] = useState("");
  const [analyzingCharacters, setAnalyzingCharacters] = useState(false);
  const [characterAnalysisSaved, setCharacterAnalysisSaved] = useState(false);
  const topviewStoryboardRequest = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const [topviewReconciliationRequired, setTopviewReconciliationRequired] = useState(false);
  const [topviewGuardLoaded, setTopviewGuardLoaded] = useState(false);
  const [topviewStorageAvailable, setTopviewStorageAvailable] = useState(true);
  const [generatingStoryboard, setGeneratingStoryboard] = useState(false);
  const [frameModel, setFrameModel] = useState<StoryboardFrameModelId>(STORYBOARD_FRAME_MODELS[0].id);
  const [generatingShotIds, setGeneratingShotIds] = useState<Set<string>>(() => new Set());
  const [frameErrors, setFrameErrors] = useState<Record<string, string>>({});
  const [savingTakeKeys, setSavingTakeKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      setTopviewReconciliationRequired(
        window.localStorage.getItem(TOPVIEW_STORYBOARD_PENDING_KEY) === "pending",
      );
    } catch {
      setTopviewStorageAvailable(false);
    } finally {
      setTopviewGuardLoaded(true);
    }
  }, []);
  const [takeSaveErrors, setTakeSaveErrors] = useState<Record<string, string>>({});
  const [savingTakeCopyIds, setSavingTakeCopyIds] = useState<Set<string>>(() => new Set());
  const [takeCopyErrors, setTakeCopyErrors] = useState<Record<string, string>>({});
  const [frameBatchProgress, setFrameBatchProgress] = useState("");
  const [generatingMissingFrames, setGeneratingMissingFrames] = useState(false);
  const [workflowPickerShotId, setWorkflowPickerShotId] = useState<string | null>(null);
  const [pendingFirstLastFrame, setPendingFirstLastFrame] = useState<PendingFirstLastFrame | null>(null);
  const draggedShot = useRef<DraggedShot | null>(null);
  const boardViewportRef = useRef<HTMLDivElement>(null);
  const boardWorldRef = useRef<HTMLDivElement>(null);
  const boardTransform = useRef<StoryboardBoardTransform>({ x: 0, y: 0, zoom: 1 });
  const boardPanGesture = useRef<StoryboardPanGesture | null>(null);
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
  const selectedScriptProvider = STORYBOARD_SCRIPT_PROVIDERS.find((provider) => provider.id === scriptProvider);
  const structuredShotList = useMemo(
    () => parseStructuredStoryboardScript(scriptText),
    [scriptText],
  );
  const possibleCharacterNameHints = useMemo(
    () => findStoryboardCharacterNameHints(scriptText),
    [scriptText],
  );
  const unreviewedCharacterNameHints = possibleCharacterNameHints.filter((hint) => {
    const currentCast = characterAnalysisRun || characterAnalysisCandidates.length > 0
      ? characterAnalysisCandidates : characters;
    return !currentCast.some((character) =>
      character.name.trim().toLocaleLowerCase() === hint.name.toLocaleLowerCase()
      || character.aliases.some((alias) => alias.trim().toLocaleLowerCase() === hint.name.toLocaleLowerCase()));
  });

  const loadCharacterAnalysisModels = useCallback(async (signal?: AbortSignal) => {
    setLoadingCharacterAnalysisModels(true);
    setCharacterAnalysisModelError("");
    try {
      const response = await fetch("/api/ollama-chat", { signal, cache: "no-store" });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error : `Could not load local models (${response.status}).`;
        throw new Error(message);
      }
      if (typeof result !== "object" || result === null || !("models" in result)
        || !Array.isArray(result.models)
        || result.models.some((model) => typeof model !== "string")) {
        throw new Error("Ollama returned an invalid model list.");
      }
      const models = result.models as string[];
      setCharacterAnalysisModels(models);
      setCharacterAnalysisModel((current) => models.includes(current) ? current : models[0] ?? "");
    } catch (error) {
      if (signal?.aborted) return;
      setCharacterAnalysisModelError(error instanceof Error
        ? error.message
        : "Could not load local Ollama models.");
    } finally {
      if (!signal?.aborted) setLoadingCharacterAnalysisModels(false);
    }
  }, []);

  useEffect(() => {
    if (hidden) return;
    const controller = new AbortController();
    void loadCharacterAnalysisModels(controller.signal);
    return () => controller.abort();
  }, [hidden, loadCharacterAnalysisModels]);

  const analyzeCharacters = async () => {
    if (!scriptText.trim() || !characterAnalysisModel || analyzingCharacters
      || savingCharacterReferenceIds.size > 0) return;
    if (characterAnalysisCandidates.length
      && !window.confirm("Replace the current unsaved character review with a new analysis?")) return;
    setAnalyzingCharacters(true);
    setCharacterAnalysisError("");
    setCharacterAnalysisSaved(false);
    try {
      const response = await fetch("/api/storyboard/analyze-characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: scriptText, model: characterAnalysisModel }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error : `Character analysis failed (${response.status}).`;
        throw new Error(message);
      }
      setCharacterAnalysisCandidates(normalizeStoryboardCharacterAnalysis(result, scriptText).characters
        .map((character) => ({ ...character, id: crypto.randomUUID() })));
      setCharacterAnalysisRun(true);
      setCharacterAnalysisSourceScript(scriptText);
    } catch (error) {
      setCharacterAnalysisError(error instanceof Error
        ? error.message
        : "Could not analyze characters with local Ollama.");
    } finally {
      setAnalyzingCharacters(false);
    }
  };

  const saveCharacterCast = () => {
    if (characterAnalysisRun && characterAnalysisSourceScript !== scriptText) {
      setCharacterAnalysisError("The script changed after this character list was created. Analyze the updated script before saving.");
      return;
    }
    const names = characterAnalysisCandidates.map((candidate) => candidate.name.trim());
    if (!names.length && characters.length
      && !window.confirm("Save an empty cast and remove all currently saved project characters?")) return;
    if (names.some((name) => !name)) {
      setCharacterAnalysisError("Every character needs a name before the cast can be saved.");
      return;
    }
    if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
      setCharacterAnalysisError("Character names must be unique. Merge or rename duplicate entries before saving.");
      return;
    }
    onCharactersChange(characterAnalysisCandidates.map((candidate): StoryboardCharacter => {
      const existing = characters.find((character) => character.id === candidate.id)
        ?? characters.find((character) =>
          character.name.toLocaleLowerCase() === candidate.name.trim().toLocaleLowerCase());
      const sameDescription = existing?.visualDescription === candidate.visualDescription.trim();
      const candidateHasReferenceEdit = Object.hasOwn(candidate, "referenceImageMediaAssetId");
      const reference = candidateHasReferenceEdit
        ? {
          referenceImageMediaAssetId: candidate.referenceImageMediaAssetId,
          referenceImageApproved: candidate.referenceImageApproved,
          referenceImageSource: candidate.referenceImageSource,
          referenceImageModel: candidate.referenceImageModel,
        }
        : sameDescription && existing?.referenceImageMediaAssetId
          ? {
            referenceImageMediaAssetId: existing.referenceImageMediaAssetId,
            referenceImageApproved: existing.referenceImageApproved,
            referenceImageSource: existing.referenceImageSource,
            referenceImageModel: existing.referenceImageModel,
          }
          : {};
      return {
        ...candidate,
        ...reference,
        name: candidate.name.trim(),
        aliases: candidate.aliases.map((alias) => alias.trim()).filter(Boolean),
        visualDescription: candidate.visualDescription.trim(),
        id: existing?.id ?? candidate.id,
      };
    }));
    setCharacterAnalysisError("");
    setCharacterAnalysisSaved(true);
  };

  const updateCharacterCandidate = (index: number, patch: Partial<StoryboardCharacterDraft>) => {
    setCharacterAnalysisCandidates((current) => current.map((candidate, candidateIndex) => {
      if (candidateIndex !== index) return candidate;
      const descriptionChanged = patch.visualDescription !== undefined
        && patch.visualDescription !== candidate.visualDescription;
      return {
        ...candidate,
        ...patch,
        ...(descriptionChanged ? { referenceImageApproved: false } : {}),
      };
    }));
    setCharacterAnalysisRun(true);
    setCharacterAnalysisSaved(false);
    setCharacterAnalysisError("");
  };

  const updateCharacterCandidateById = (id: string, patch: Partial<StoryboardCharacterDraft>) => {
    setCharacterAnalysisCandidates((current) => current.map((candidate) => {
      if (candidate.id !== id) return candidate;
      const descriptionChanged = patch.visualDescription !== undefined
        && patch.visualDescription !== candidate.visualDescription;
      return {
        ...candidate,
        ...patch,
        ...(descriptionChanged ? { referenceImageApproved: false } : {}),
      };
    }));
    setCharacterAnalysisSaved(false);
    setCharacterAnalysisError("");
  };

  const setCharacterReferenceBusy = (id: string, busy: boolean) => {
    setSavingCharacterReferenceIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const editSavedCharacterCast = () => {
    setCharacterAnalysisCandidates(characters.map((character) => ({ ...character })));
    setCharacterAnalysisRun(true);
    setCharacterAnalysisSourceScript(scriptText);
    setCharacterAnalysisSaved(false);
    setCharacterAnalysisError("");
  };

  const addCharacterCandidate = () => {
    setCharacterAnalysisCandidates((current) => {
      const source = current.length || characterAnalysisRun
        ? current
        : characters.map((character) => ({ ...character }));
      return [...source, {
        id: crypto.randomUUID(),
        name: "",
        aliases: [],
        visualDescription: "",
        evidence: [],
        appearances: [],
      }];
    });
    setCharacterAnalysisRun(true);
    if (!characterAnalysisRun) setCharacterAnalysisSourceScript(scriptText);
    setCharacterAnalysisSaved(false);
    setCharacterAnalysisError("");
  };

  const addCharacterNameHint = (hint: { name: string; evidence: string[] }) => {
    const source = characterAnalysisCandidates.length > 0
      ? characterAnalysisCandidates
      : characters.map((character) => ({ ...character }));
    if (source.some((candidate) =>
      candidate.name.trim().toLocaleLowerCase() === hint.name.toLocaleLowerCase()
      || candidate.aliases.some((alias) => alias.trim().toLocaleLowerCase() === hint.name.toLocaleLowerCase()))) {
      return;
    }
    setCharacterAnalysisCandidates([...source, {
      id: crypto.randomUUID(),
      name: hint.name,
      aliases: [],
      visualDescription: "",
      evidence: hint.evidence,
      appearances: [],
    }]);
    setCharacterAnalysisRun(true);
    if (!characterAnalysisRun) setCharacterAnalysisSourceScript(scriptText);
    setCharacterAnalysisSaved(false);
    setCharacterAnalysisError("");
  };

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

  const clearTopviewPendingMarker = () => {
    try {
      window.localStorage.removeItem(TOPVIEW_STORYBOARD_PENDING_KEY);
      setTopviewStorageAvailable(true);
      setTopviewReconciliationRequired(false);
      return true;
    } catch {
      setTopviewStorageAvailable(false);
      setTopviewReconciliationRequired(true);
      return false;
    }
  };

  const acknowledgeTopviewReconciliation = () => {
    if (clearTopviewPendingMarker()) {
      topviewStoryboardRequest.current = null;
      setScriptError("");
    } else {
      setScriptError("Could not clear the Topview safety marker. Use another provider until browser storage is available.");
    }
  };

  const importStructuredShotList = () => {
    if (!structuredShotList) return;
    if (storyboard.scenes.length > 0
      && !window.confirm("Replace all current scenes and shots with the locally imported shot list?")) return;
    onChange((current) => ({
      ...current,
      scenes: structuredShotList.scenes,
      styleBible: structuredShotList.styleBible,
    }));
    setSelectedSceneId(structuredShotList.scenes[0]?.id ?? "");
    setScriptError("");
  };

  const buildStoryboardFromScript = async () => {
    if (!scriptText.trim() || generatingStoryboard) return;
    if (storyboard.scenes.length > 0
      && !window.confirm("Replace all current scenes and shots with the generated storyboard?")) return;
    const isTopview = scriptProvider === "topview-gpt" || scriptProvider === "topview-claude";
    if (isTopview && (!topviewGuardLoaded || !topviewStorageAvailable || topviewReconciliationRequired)) {
      setScriptError(topviewReconciliationRequired
        ? "Topview has an unresolved request. Check Topview Usage before authorizing another request."
        : "Topview generation is unavailable until browser storage can track pending requests safely.");
      return;
    }
    const fingerprint = `${scriptProvider}\u0000${scriptText}`;
    if (isTopview && (!topviewStoryboardRequest.current
      || topviewStoryboardRequest.current.fingerprint !== fingerprint)) {
      topviewStoryboardRequest.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
    }
    let topviewOutcomeUncertain = false;
    setGeneratingStoryboard(true);
    setScriptError("");
    try {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (isTopview && topviewStoryboardRequest.current) {
        headers.set("Idempotency-Key", topviewStoryboardRequest.current.idempotencyKey);
        try {
          window.localStorage.setItem(TOPVIEW_STORYBOARD_PENDING_KEY, "pending");
        } catch {
          setTopviewStorageAvailable(false);
          throw new Error("Topview generation was not submitted because browser storage could not track its billable request safely.");
        }
        topviewOutcomeUncertain = true;
      }
      const response = await fetch("/api/storyboard/generate", {
        method: "POST",
        headers,
        body: JSON.stringify({ script: scriptText, provider: scriptProvider }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error
          : `Storyboard generation failed (${response.status}).`;
        const requestId = typeof result === "object" && result !== null
          && "requestId" in result && typeof result.requestId === "string"
          ? result.requestId
          : response.headers.get("X-Platform-Request-Id");
        const uncertain = isTopview && (
          response.status === 409
          || response.status >= 500
          || /reconcil/i.test(message)
        );
        if (isTopview && !uncertain) {
          topviewOutcomeUncertain = false;
          topviewStoryboardRequest.current = null;
          if (!clearTopviewPendingMarker()) {
            throw new Error("The provider rejected the request, but the Topview safety marker could not be cleared.");
          }
        } else if (uncertain) {
          setTopviewReconciliationRequired(true);
        }
        const requestDetail = requestId ? ` Topview request ID: ${requestId}.` : "";
        const hasUsageGuidance = /check topview usage|reconcil/i.test(message);
        const billingGuidance = uncertain && !hasUsageGuidance
          ? " Check Topview Usage before retrying; the request may have been billed."
          : "";
        throw new Error(`${message}${requestDetail}${billingGuidance}`);
      }
      const generated = normalizeGeneratedStoryboard(result);
      if (isTopview) {
        topviewOutcomeUncertain = false;
        topviewStoryboardRequest.current = null;
        if (!clearTopviewPendingMarker()) {
          setScriptError("Storyboard generated, but browser storage could not clear the Topview safety marker. Check Topview Usage before generating again.");
        }
      }
      onChange((current) => ({
        ...current,
        scenes: generated.scenes,
        styleBible: generated.styleBible,
      }));
      setSelectedSceneId(generated.scenes[0]?.id ?? "");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate the storyboard.";
      if (isTopview && topviewOutcomeUncertain) setTopviewReconciliationRequired(true);
      const hasUsageGuidance = /check topview usage|reconcil/i.test(message);
      setScriptError(isTopview && topviewOutcomeUncertain && !hasUsageGuidance
        ? `${message} Check Topview Usage before retrying; the request may have been billed.`
        : message);
    } finally {
      setGeneratingStoryboard(false);
    }
  };

  const generateFrameForShot = async (scene: StoryboardScene, shot: StoryboardShot) => {
    setGeneratingShotIds((current) => new Set(current).add(shot.id));
    setFrameErrors((current) => ({ ...current, [shot.id]: "" }));
    try {
      const selectedCharacters = (shot.characterIds ?? []).flatMap((characterId) => {
        const character = characters.find((candidate) => candidate.id === characterId);
        return character ? [character] : [];
      });
      if (selectedCharacters.some((character) =>
        !character.referenceImageApproved || !character.referenceImageMediaAssetId,
      )) {
        throw new Error("A selected character reference is no longer approved. Review the shot's character references.");
      }
      if (selectedCharacters.length > 3) {
        throw new Error("Select no more than three character references for a shot.");
      }
      if (selectedCharacters.length && !storyboardFrameModelSupportsCharacterReferences(frameModel)) {
        throw new Error("Character references in Storyboard require a Nano Banana image model.");
      }
      const referenceImages = await Promise.all(selectedCharacters.map((character) =>
        loadApprovedCharacterReferenceImage(character, projectSession),
      ));
      const prompt = buildStoryboardFramePrompt(
        scene,
        shot,
        storyboard.aspectRatio,
        storyboard.styleBible,
        selectedCharacters.map((character) => character.name),
      );
      const frame = await generateStoryboardFrame(frameModel, prompt, storyboard.aspectRatio, referenceImages);
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
      .filter((shot) => !shot.frame && Boolean(
        shot.title.trim() || shot.description.trim() || shot.prompt.trim(),
      ))
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
  const saveGeneratedTake = async (
    sceneId: string,
    shotId: string,
    candidate: StoryboardVideoCandidate,
  ) => {
    const key = `${candidate.sourceId}:${candidate.videoUrl}`;
    setSavingTakeKeys((current) => new Set(current).add(key));
    setTakeSaveErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      await onSaveTake(sceneId, shotId, candidate);
    } catch (error) {
      setTakeSaveErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : "Could not save this take.",
      }));
    } finally {
      setSavingTakeKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const saveExistingTakeCopy = async (
    sceneId: string,
    shotId: string,
    take: StoryboardGeneratedTake,
  ) => {
    setSavingTakeCopyIds((current) => new Set(current).add(take.id));
    setTakeCopyErrors((current) => {
      const next = { ...current };
      delete next[take.id];
      return next;
    });
    try {
      await onSaveTakeCopy(sceneId, shotId, take);
    } catch (error) {
      setTakeCopyErrors((current) => ({
        ...current,
        [take.id]: error instanceof Error ? error.message : "Could not save this take locally.",
      }));
    } finally {
      setSavingTakeCopyIds((current) => {
        const next = new Set(current);
        next.delete(take.id);
        return next;
      });
    }
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

  const applyBoardTransform = useCallback((transform: StoryboardBoardTransform) => {
    boardTransform.current = transform;
    if (boardWorldRef.current) {
      boardWorldRef.current.style.transform =
        `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`;
    }
  }, []);

  const zoomBoard = useCallback((factor: number, point?: { x: number; y: number }) => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    const current = boardTransform.current;
    const bounds = viewport.getBoundingClientRect();
    const x = point?.x ?? bounds.width / 2;
    const y = point?.y ?? bounds.height / 2;
    const zoom = Math.max(STORYBOARD_MIN_ZOOM, Math.min(STORYBOARD_MAX_ZOOM, current.zoom * factor));
    const worldX = (x - current.x) / current.zoom;
    const worldY = (y - current.y) / current.zoom;
    applyBoardTransform({
      x: x - worldX * zoom,
      y: y - worldY * zoom,
      zoom,
    });
  }, [applyBoardTransform]);

  const handleBoardWheel = useCallback((event: WheelEvent) => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    if (event.target instanceof HTMLElement
      && event.target.closest("input, textarea, select, button, [contenteditable='true'], .storyboard-take-prompt")) {
      return;
    }
    event.preventDefault();
    const current = boardTransform.current;
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const deltaX = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      applyBoardTransform({
        ...current,
        x: current.x - deltaX,
        y: current.y - event.deltaY,
      });
      return;
    }
    const bounds = viewport.getBoundingClientRect();
    zoomBoard(Math.pow(1.1, -event.deltaY / 100), {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  }, [applyBoardTransform, zoomBoard]);

  useEffect(() => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    viewport.addEventListener("wheel", handleBoardWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleBoardWheel);
  }, [handleBoardWheel]);

  const handleBoardPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 1
      || (event.target instanceof HTMLElement && event.target.closest(".storyboard-navigation-controls"))) return;
    event.preventDefault();
    boardPanGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...boardTransform.current },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-panning");
  };

  const handleBoardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = boardPanGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    applyBoardTransform({
      ...gesture.origin,
      x: gesture.origin.x + event.clientX - gesture.startX,
      y: gesture.origin.y + event.clientY - gesture.startY,
    });
  };

  const finishBoardPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (boardPanGesture.current?.pointerId !== event.pointerId) return;
    boardPanGesture.current = null;
    event.currentTarget.classList.remove("is-panning");
  };

  const updateStyleBible = (
    key: "visualStyle" | "recurringCharacter" | "recurringLocation",
    value: string,
  ) => {
    onChange((current) => ({
      ...current,
      styleBible: {
        visualStyle: "",
        recurringCharacter: "",
        recurringLocation: "",
        ...current.styleBible,
        [key]: value,
      },
    }));
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
          <label className="storyboard-script-provider">
            <span>Script API</span>
            <select aria-label="Storyboard script API" value={scriptProvider} disabled={generatingStoryboard}
              onChange={(event) => setScriptProvider(event.target.value as StoryboardScriptProvider)}>
              {STORYBOARD_SCRIPT_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={addScene}>Add scene</button>
          <button type="button" className="storyboard-primary-action" onClick={addShot}>Add shot</button>
        </div>
      </header>

      <details className="storyboard-style-bible">
        <summary>Global style bible</summary>
        <p>Keep shared visual style and continuity notes here instead of repeating them in every shot Description.</p>
        <label>
          <span>Visual style</span>
          <textarea value={storyboard.styleBible?.visualStyle ?? ""}
            onChange={(event) => updateStyleBible("visualStyle", event.target.value)} />
        </label>
        <label>
          <span>Recurring character</span>
          <textarea value={storyboard.styleBible?.recurringCharacter ?? ""}
            onChange={(event) => updateStyleBible("recurringCharacter", event.target.value)} />
        </label>
        <label>
          <span>Recurring location</span>
          <textarea value={storyboard.styleBible?.recurringLocation ?? ""}
            onChange={(event) => updateStyleBible("recurringLocation", event.target.value)} />
        </label>
      </details>

      <section className="storyboard-script-panel" aria-labelledby="storyboard-script-heading">
        <div className="storyboard-script-heading-row">
          <div>
            <h2 id="storyboard-script-heading">Build from a script</h2>
            <p>Import numbered shot lists locally, or use the selected text API to turn a screenplay into scenes and shots.</p>
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
          <div className="storyboard-script-actions">
            {structuredShotList && (
              <button type="button" className="storyboard-secondary-action"
                disabled={generatingStoryboard}
                onClick={importStructuredShotList}>
                Import shot list locally (no API)
              </button>
            )}
            <button type="button" className="storyboard-primary-action"
              disabled={!scriptText.trim() || generatingStoryboard
                || (selectedScriptProvider?.id.startsWith("topview-") === true
                  && (!topviewGuardLoaded || !topviewStorageAvailable || topviewReconciliationRequired))}
              onClick={() => void buildStoryboardFromScript()}>
              {generatingStoryboard ? "Building storyboard…" : "Build with selected API"}
            </button>
          </div>
        </div>
        <section className="storyboard-character-analysis" aria-labelledby="storyboard-character-analysis-heading">
          <div className="storyboard-character-analysis-heading">
            <div>
              <h3 id="storyboard-character-analysis-heading">Analyze and review characters</h3>
              <p>Identify script-supported characters, then manage one shared reference for each character in this project.</p>
            </div>
            <div className="storyboard-character-analysis-controls">
              <label>
                <span>Local Ollama model</span>
                <select aria-label="Local character analysis model"
                  value={characterAnalysisModel}
                  disabled={loadingCharacterAnalysisModels || characterAnalysisModels.length === 0}
                  onChange={(event) => setCharacterAnalysisModel(event.target.value)}>
                  {characterAnalysisModels.length === 0 && <option value="">No local models available</option>}
                  {characterAnalysisModels.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              <button type="button" className="storyboard-secondary-action"
                disabled={loadingCharacterAnalysisModels}
                onClick={() => void loadCharacterAnalysisModels()}>
                {loadingCharacterAnalysisModels ? "Loading…" : "Refresh models"}
              </button>
              <button type="button" className="storyboard-primary-action"
                disabled={!scriptText.trim() || !characterAnalysisModel || analyzingCharacters
                  || savingCharacterReferenceIds.size > 0}
                onClick={() => void analyzeCharacters()}>
                {analyzingCharacters ? "Analyzing locally…" : "Analyze characters locally"}
              </button>
            </div>
          </div>
          <p className="storyboard-character-analysis-note">
            Script analysis uses Ollama on this computer. Uploading a reference stays local; generating a sheet uses the selected storyboard image model and may cost money.
          </p>
          {unreviewedCharacterNameHints.length > 0 && (
            <div className="storyboard-character-hints">
              <div>
                <h4>Possible names and IDs found in the script</h4>
                <p className="storyboard-character-analysis-note">
                  These local text-pattern matches are suggestions, not confirmed characters. Add any relevant ones to the review before saving the cast.
                </p>
              </div>
              {unreviewedCharacterNameHints.map((hint) => (
                <article className="storyboard-character-hint" key={hint.name}>
                  <strong>{hint.name}</strong>
                  {hint.evidence.map((excerpt, evidenceIndex) => (
                    <blockquote key={`${hint.name}-${evidenceIndex}`}>{excerpt}</blockquote>
                  ))}
                  <button type="button" className="storyboard-secondary-action"
                    onClick={() => addCharacterNameHint(hint)}>
                    Add to character review
                  </button>
                </article>
              ))}
            </div>
          )}
          {characterAnalysisRun && characterAnalysisSourceScript !== scriptText && (
            <p className="storyboard-inline-error" role="alert">
              The script changed. Your current review is preserved, but analyze the updated script before saving it.
            </p>
          )}
          {characterAnalysisModelError && (
            <p className="storyboard-inline-error" role="alert">{characterAnalysisModelError}</p>
          )}
          {!characterAnalysisRun && Boolean(characters.length) && (
            <div className="storyboard-character-saved-list">
              <h4>Project characters</h4>
              {characters.map((character) => (
                <article className="storyboard-character-card" key={character.id}>
                  <h5>{character.name}{character.aliases.length ? ` · ${character.aliases.join(", ")}` : ""}</h5>
                  <p>{character.visualDescription || "No visual traits described in the script."}</p>
                  <span>{character.appearances.map((appearance) =>
                    appearance.shotNumber === null
                      ? appearance.sceneHeading
                      : `Shot ${String(appearance.shotNumber).padStart(2, "0")}`,
                  ).filter(Boolean).join(" · ") || "No appearance references"}</span>
                  <CharacterReferenceEditor
                    character={character}
                    styleBible={storyboard.styleBible}
                    frameModel={frameModel}
                    projectSession={projectSession}
                    referenceKey={character.id}
                    onSaveAsset={onSaveCharacterReference}
                    onBusyChange={setCharacterReferenceBusy}
                    onAddToWorkflow={onAddCharacterReferenceToWorkflow}
                    onUpdate={(patch) => onCharactersChange(characters.map((current) =>
                      current.id === character.id ? { ...current, ...patch } : current))}
                  />
                </article>
              ))}
              <button type="button" className="storyboard-secondary-action"
                onClick={editSavedCharacterCast}>Edit saved cast</button>
            </div>
          )}
          {characterAnalysisRun && (
            <div className="storyboard-character-review">
              <div className="storyboard-character-review-heading">
                <h4>Review candidates</h4>
                <button type="button" className="storyboard-secondary-action"
                  onClick={addCharacterCandidate}>Add character manually</button>
              </div>
              {characterAnalysisCandidates.length === 0 ? (
                <p className="storyboard-character-analysis-note">
                  No supported characters were found. You can add a character manually.
                </p>
              ) : characterAnalysisCandidates.map((candidate, index) => (
                <article className="storyboard-character-card" key={`${index}-${candidate.name}`}>
                  <div className="storyboard-character-card-actions">
                    <strong>Character {index + 1}</strong>
                    <button type="button" className="storyboard-secondary-action"
                      aria-label={`Remove ${candidate.name || `character ${index + 1}`}`}
                      onClick={() => {
                        setCharacterAnalysisCandidates((current) => current.filter((_, itemIndex) => itemIndex !== index));
                        setCharacterAnalysisSaved(false);
                      }}>Remove</button>
                  </div>
                  <label>
                    <span>Name</span>
                    <input aria-label={`Character ${index + 1} name`} value={candidate.name}
                      onChange={(event) => updateCharacterCandidate(index, { name: event.target.value })} />
                  </label>
                  <label>
                    <span>Aliases (one per line)</span>
                    <textarea aria-label={`Character ${index + 1} aliases`}
                      value={candidate.aliases.join("\n")}
                      onChange={(event) => updateCharacterCandidate(index, {
                        aliases: event.target.value.split(/\r?\n/).map((alias) => alias.trim()).filter(Boolean),
                      })} />
                  </label>
                  <label>
                    <span>Visual traits explicitly stated in the script</span>
                    <textarea aria-label={`Character ${index + 1} visual description`}
                      value={candidate.visualDescription}
                      onChange={(event) => updateCharacterCandidate(index, { visualDescription: event.target.value })} />
                  </label>
                  {candidate.evidence.length > 0 && (
                    <div className="storyboard-character-evidence">
                      <strong>Script evidence</strong>
                      {candidate.evidence.map((excerpt, evidenceIndex) => (
                        <blockquote key={`${evidenceIndex}-${excerpt}`}>{excerpt}</blockquote>
                      ))}
                    </div>
                  )}
                  {candidate.appearances.length > 0 && (
                    <div className="storyboard-character-evidence">
                      <strong>Suggested appearances</strong>
                      {candidate.appearances.map((appearance, appearanceIndex) => (
                        <p key={`${appearanceIndex}-${appearance.evidence}`}>
                          <span>{appearance.shotNumber === null
                            ? appearance.sceneHeading
                            : `Shot ${String(appearance.shotNumber).padStart(2, "0")}`}</span>
                          {" — "}{appearance.evidence}
                        </p>
                      ))}
                    </div>
                  )}
                  <CharacterReferenceEditor
                    character={candidate}
                    styleBible={storyboard.styleBible}
                    frameModel={frameModel}
                    projectSession={projectSession}
                    referenceKey={candidate.id}
                    onSaveAsset={onSaveCharacterReference}
                    onBusyChange={setCharacterReferenceBusy}
                    onUpdate={(patch) => updateCharacterCandidateById(candidate.id, patch)}
                  />
                </article>
              ))}
              <button type="button" className="storyboard-primary-action"
                disabled={characterAnalysisSourceScript !== scriptText || savingCharacterReferenceIds.size > 0}
                onClick={saveCharacterCast}>Save cast to project</button>
            </div>
          )}
          {characterAnalysisError && <p className="storyboard-inline-error" role="alert">{characterAnalysisError}</p>}
          {characterAnalysisSaved && <p className="storyboard-character-analysis-saved" role="status">Reviewed cast saved to the project.</p>}
          {!characterAnalysisRun && (
            <button type="button" className="storyboard-secondary-action storyboard-character-add"
              onClick={addCharacterCandidate}>Add character manually</button>
          )}
        </section>
        <p className="storyboard-script-disclosure">
          Your script is sent to {selectedScriptProvider?.label} using {selectedScriptProvider?.apiKeyName} only when you choose Build with selected API. API usage may be billed. Shot type, camera movement, and duration are filled for every shot; missing details default to Wide, Static, and 6 seconds. {selectedScriptProvider?.id.startsWith("topview-") ? "A retry after an uncertain error reuses the same request key; check Topview Usage before starting another request." : ""} Generated shots have no frame images.
        </p>
        {structuredShotList && (
          <p className="storyboard-script-local-import-note">
            Detected {structuredShotList.scenes.reduce((count, scene) => count + scene.shots.length, 0)} numbered shots. Local import does not send the script to a provider; frame generation remains a separate step.
          </p>
        )}
        {topviewReconciliationRequired && (
          <div className="storyboard-inline-error" role="alert">
            <p>Topview reports an unresolved request. Check Topview Usage before allowing another Topview request; it may already have been billed.</p>
            <button type="button" onClick={acknowledgeTopviewReconciliation}>
              I checked Topview Usage — allow another request
            </button>
          </div>
        )}
        {!topviewStorageAvailable && (
          <p className="storyboard-inline-error" role="alert">
            Topview generation is blocked because this browser could not safely track pending billable requests.
          </p>
        )}
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
                !shot.frame && Boolean(shot.title.trim() || shot.description.trim() || shot.prompt.trim())))}
            onClick={() => void generateMissingFrames()}>
            {generatingMissingFrames ? "Generating frames…" : "Generate missing frames"}
          </button>
          {frameBatchProgress && <span className="storyboard-image-progress" role="status">{frameBatchProgress}</span>}
        </div>
        <p className="storyboard-image-disclosure">
          Generation sends scene and shot details to the selected provider. Selected approved character references are sent only for that shot, up to three; use a Nano Banana image model to apply them. Gemini image models use GEMINI_API_KEY and are billed through the Gemini API, separately from free image generation in the Gemini app. Other provider usage may also be billed. Generated images are stored with this project and resized to fit the storyboard’s local image limit.
        </p>
      </section>

      {saveError && <p className="storyboard-storage-error" role="alert">Could not save this storyboard: {saveError}</p>}
      {autoSaveError && <p className="storyboard-storage-error" role="alert">
        Could not save a generated video locally: {autoSaveError}
      </p>}

      <div className="storyboard-navigation-viewport"
        ref={boardViewportRef}
        onPointerDown={handleBoardPointerDown}
        onPointerMove={handleBoardPointerMove}
        onPointerUp={finishBoardPan}
        onPointerCancel={finishBoardPan}
        onLostPointerCapture={finishBoardPan}
        onAuxClick={(event) => {
          if (event.button === 1) event.preventDefault();
        }}>
        <div className="storyboard-navigation-world" ref={boardWorldRef}>
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
                            || !(shot.title.trim() || shot.description.trim() || shot.prompt.trim())}
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
                                <StoryboardTakeVideo take={take} projectSession={projectSession} />
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
                                  {take.mediaAssetId ? (
                                    <span className="storyboard-take-local-status" role="status">Local copy saved</span>
                                  ) : (
                                    <button type="button" className="storyboard-take-save"
                                      disabled={savingTakeCopyIds.has(take.id)}
                                      onClick={() => void saveExistingTakeCopy(scene.id, shot.id, take)}>
                                      {savingTakeCopyIds.has(take.id) ? "Saving local copy…" : "Save local copy"}
                                    </button>
                                  )}
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
                                {takeCopyErrors[take.id] && <p className="storyboard-take-error" role="alert">
                                  Could not save local copy: {takeCopyErrors[take.id]}
                                </p>}
                              </article>
                            ))}
                            {availableVideoCandidates.map((candidate) => (
                              <article className="storyboard-take storyboard-take-available"
                                key={`${candidate.sourceId}:${candidate.videoUrl}`}>
                                <StoryboardTakeVideo take={candidate} projectSession={projectSession} />
                                <div className="storyboard-take-meta">
                                  <strong>{candidate.model}</strong>
                                  <span>From current workflow</span>
                                </div>
                                {candidate.prompt && <details className="storyboard-take-prompt">
                                  <summary>Prompt used</summary>
                                  <p>{candidate.prompt}</p>
                                </details>}
                                <button type="button" className="storyboard-take-save"
                                  disabled={savingTakeKeys.has(`${candidate.sourceId}:${candidate.videoUrl}`)}
                                  onClick={() => void saveGeneratedTake(scene.id, shot.id, candidate)}>
                                  {savingTakeKeys.has(`${candidate.sourceId}:${candidate.videoUrl}`)
                                    ? "Saving local copy…" : "Save as take"}
                                </button>
                                {takeSaveErrors[`${candidate.sourceId}:${candidate.videoUrl}`]
                                  && <p className="storyboard-take-error" role="alert">
                                    Could not save take: {takeSaveErrors[`${candidate.sourceId}:${candidate.videoUrl}`]}
                                  </p>}
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
                        <label className="storyboard-field">
                          <span>Prompt <small>For image and video generation</small></span>
                          <textarea value={shot.prompt} aria-label={`Shot ${number} prompt`}
                            placeholder="Write a visual prompt based on the description…"
                            rows={4}
                            onChange={(event) => updateShot(scene.id, shot.id, { prompt: event.target.value })} />
                          <small className="storyboard-prompt-help">
                            If blank, generation uses the Description. Editing the Prompt never changes the Description.
                          </small>
                        </label>
                        {(characters.length > 0 || Boolean(shot.characterIds?.length)) && <ShotCharacterReferencePicker
                          shot={shot}
                          characters={characters}
                          frameModel={frameModel}
                          disabled={generatingShotIds.has(shot.id)}
                          onChange={(characterIds) => updateShot(scene.id, shot.id, {
                            characterIds: characterIds.length ? characterIds : undefined,
                          })}
                        />}
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
        </div>
        <div className="storyboard-navigation-controls" role="group" aria-label="Storyboard navigation">
          <button type="button" aria-label="Zoom in storyboard" title="Zoom in"
            onClick={() => zoomBoard(1.2)}>+</button>
          <button type="button" aria-label="Zoom out storyboard" title="Zoom out"
            onClick={() => zoomBoard(1 / 1.2)}>−</button>
          <button type="button" aria-label="Reset storyboard view" title="Reset view"
            onClick={() => applyBoardTransform({ x: 0, y: 0, zoom: 1 })}>⌂</button>
        </div>
        <span className="storyboard-navigation-hint">Middle-drag to pan · Wheel to zoom</span>
      </div>
    </main>
  );
}
