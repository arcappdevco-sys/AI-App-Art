"use client";

import { useEffect, useState } from "react";
import {
  addMediaToProjectFolder,
  backupProjectFolder,
  chooseProjectFolder,
  loadCurrentProjectFolder,
  projectFolderPermission,
  readProjectMediaFile,
  readOrCreateProjectManifest,
  saveCurrentProjectFolder,
  type ProjectFolderSession,
} from "@/lib/project-folder-storage";
import type { ProjectManifest } from "@/lib/project-manifest";
import type { ProjectMediaAsset } from "@/lib/project-media";
import { loadProjectMediaFile, registerProjectMediaAsset } from "@/lib/project-media-storage";

type ProjectFolderControlProps = {
  assets: ProjectMediaAsset[];
  onProjectMediaChange: () => Promise<void>;
  onProjectSessionChange: (session: ProjectFolderSession | null) => void;
  projectSessionEpoch: number;
};

async function restoreProjectMedia(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
): Promise<{ restored: number; errors: string[] }> {
  let restored = 0;
  const errors: string[] = [];
  for (const asset of manifest.assets) {
    try {
      const file = await readProjectMediaFile(handle, asset);
      await registerProjectMediaAsset({
        ...asset,
        source: { kind: "storage", storageKey: asset.id },
      }, file);
      restored += 1;
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : `Could not restore "${asset.name}".`);
    }
  }
  return { restored, errors };
}

export default function ProjectFolderControl({
  assets,
  onProjectMediaChange,
  onProjectSessionChange,
  projectSessionEpoch,
}: ProjectFolderControlProps) {
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [status, setStatus] = useState("No project folder open");
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<"opening" | "copying" | "backing-up" | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [activeSession, setActiveSession] = useState<ProjectFolderSession | null>(null);
  const busy = busyAction !== null;

  const availableAssets = assets.filter((asset) => asset.source.kind === "storage"
    && !manifest?.assets.some((projectAsset) => projectAsset.id === asset.id));

  useEffect(() => {
    let active = true;
    let sessionReported = false;
    const reportSession = (session: ProjectFolderSession | null) => {
      sessionReported = true;
      setActiveSession(session);
      onProjectSessionChange(session);
    };
    void (async () => {
      try {
        const saved = await loadCurrentProjectFolder();
        if (!active) return;
        if (!saved) {
          reportSession(null);
          return;
        }
        const permission = await projectFolderPermission(saved.handle);
        if (!active) return;
        if (permission !== "granted") {
          setStatus(`Select "${saved.name}" again to reconnect`);
          reportSession(null);
          return;
        }
        const result = await readOrCreateProjectManifest(saved.handle);
        if (!active) return;
        setManifest(result.manifest);
        const restored = await restoreProjectMedia(saved.handle, result.manifest);
        if (!active) return;
        reportSession({
          handle: saved.handle,
          projectId: result.manifest.id,
          sessionKey: crypto.randomUUID(),
        });
        await onProjectMediaChange();
        if (!active) return;
        setStatus(`Project: ${result.manifest.name} · ${result.manifest.assets.length} media`);
        setError(restored.errors.join(" "));
      } catch (caught) {
        if (!active) return;
        if (!sessionReported) reportSession(null);
        setError(caught instanceof Error ? caught.message : "Could not restore the project folder.");
      }
    })();
    return () => { active = false; };
  }, [onProjectMediaChange, onProjectSessionChange]);

  useEffect(() => {
    if (!activeSession) return;
    let active = true;
    void readOrCreateProjectManifest(activeSession.handle).then(({ manifest: refreshedManifest }) => {
      if (!active) return;
      if (refreshedManifest.id !== activeSession.projectId) {
        throw new Error("The selected project folder changed.");
      }
      setManifest(refreshedManifest);
      setStatus(`Project: ${refreshedManifest.name} · ${refreshedManifest.assets.length} media`);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : "Could not refresh the project manifest.");
    });
    return () => { active = false; };
  }, [activeSession, projectSessionEpoch]);

  const openProjectFolder = async () => {
    setBusyAction("opening");
    setError("");
    try {
      const handle = await chooseProjectFolder();
      const result = await readOrCreateProjectManifest(handle);
      await saveCurrentProjectFolder(handle);
      setManifest(result.manifest);
      const restored = await restoreProjectMedia(handle, result.manifest);
      const session = {
        handle,
        projectId: result.manifest.id,
        sessionKey: crypto.randomUUID(),
      };
      setActiveSession(session);
      onProjectSessionChange(session);
      await onProjectMediaChange();
      setStatus(`${result.created ? "Created" : "Opened"}: ${result.manifest.name} · ${result.manifest.assets.length} media`);
      setError(restored.errors.join(" "));
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "Could not open the project folder.");
      }
    } finally {
      setBusyAction(null);
    }
  };

  const addSelectedMedia = async () => {
    const asset = assets.find((candidate) => candidate.id === selectedAssetId);
    if (!manifest || !asset) return;
    setBusyAction("copying");
    setError("");
    try {
      const saved = await loadCurrentProjectFolder();
      if (!saved) throw new Error("Open a project folder before adding media.");
      const file = await loadProjectMediaFile(asset.id, asset.revision);
      const updatedManifest = await addMediaToProjectFolder(saved.handle, manifest, asset, file);
      setManifest(updatedManifest);
      const session = activeSession?.handle === saved.handle && activeSession.projectId === updatedManifest.id
        ? activeSession
        : {
          handle: saved.handle,
          projectId: updatedManifest.id,
          sessionKey: crypto.randomUUID(),
        };
      setActiveSession(session);
      onProjectSessionChange(session);
      await registerProjectMediaAsset({
        ...asset,
        source: { kind: "storage", storageKey: asset.id },
      }, file);
      await onProjectMediaChange();
      setSelectedAssetId("");
      setStatus(`Added "${asset.name}" to ${updatedManifest.name}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add media to the project.");
    } finally {
      setBusyAction(null);
    }
  };

  const backupProject = async () => {
    if (!activeSession || !manifest) return;
    setBusyAction("backing-up");
    setError("");
    setStatus("Choose an empty folder for the backup…");
    try {
      const destination = await chooseProjectFolder();
      const result = await backupProjectFolder(
        activeSession.handle,
        manifest.id,
        destination,
        (completed, total) => setStatus(`Backing up project · ${completed}/${total} files`),
      );
      setStatus(`Backup complete · ${result.fileCount} files · ${result.totalBytes.toLocaleString()} bytes`);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setStatus(`Project: ${manifest.name} · ${manifest.assets.length} media`);
      } else {
        setError(caught instanceof Error ? caught.message : "Could not back up the project.");
      }
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="ff-project-folder-control">
      <button
        type="button"
        className="ff-toolbar-button"
        onClick={() => void openProjectFolder()}
        disabled={busy}
        title="Open a project folder or select a backup folder to restore it."
      >
        {busyAction === "opening" ? "Opening project…" : manifest ? "Change project folder" : "Open project folder"}
      </button>
      <span className="ff-project-folder-status" role={error ? "alert" : "status"} title={error || status}>
        {error || status}
      </span>
      {manifest && (
        <>
          <button
            type="button"
            className="ff-toolbar-button"
            onClick={() => void backupProject()}
            disabled={busy || !activeSession}
            title="Copy the full project into an empty folder. Wait for workspace saves to finish; open the copy later to restore it."
          >
            {busyAction === "backing-up" ? "Backing up…" : "Backup"}
          </button>
          <select
            className="ff-project-folder-select"
            aria-label="Media to copy into project"
            value={selectedAssetId}
            onChange={(event) => setSelectedAssetId(event.target.value)}
            disabled={busy || availableAssets.length === 0}
          >
            <option value="">
              {availableAssets.length ? "Select media…" : assets.length ? "No local media available" : "No media available"}
            </option>
            {availableAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>{asset.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="ff-toolbar-button"
            onClick={() => void addSelectedMedia()}
            disabled={busy || !selectedAssetId}
            title="Copy the selected shared-media file into this project's Media/Originals folder."
          >
            {busyAction === "copying" ? "Copying…" : "Copy into project"}
          </button>
        </>
      )}
    </div>
  );
}
