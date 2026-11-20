"use client";

import { useEffect, useRef, useState } from "react";
import {
  addMediaToProjectFolder,
  backupProjectFolder,
  chooseProjectFolder,
  exportProjectPackage,
  findProjectFolderRoot,
  importProjectPackage as importProjectPackageToStorage,
  loadCurrentProjectFolder,
  projectFolderPermission,
  readProjectMediaFile,
  readOrCreateProjectManifest,
  relinkProjectMediaAtPath,
  relinkProjectMediaFromFile,
  scanAndRelinkProjectMedia,
  saveCurrentProjectFolder,
  type MissingProjectMedia,
  type ProjectFolderSession,
} from "@/lib/project-folder-storage";
import type { ProjectManifest } from "@/lib/project-manifest";
import type { ProjectMediaAsset } from "@/lib/project-media";
import {
  deleteProjectMediaAsset,
  getProjectMediaStorageUsage,
  loadProjectMediaFile,
  registerProjectMediaAsset,
  type ProjectMediaStorageUsage,
} from "@/lib/project-media-storage";

function formatMediaBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

type ProjectFolderControlProps = {
  assets: ProjectMediaAsset[];
  onProjectMediaChange: () => Promise<void>;
  onProjectSessionChange: (session: ProjectFolderSession | null) => void;
  onBeforePackageExport: () => Promise<void>;
  projectSessionEpoch: number;
};

async function restoreProjectMedia(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
  skippedAssetIds: Set<string> = new Set(),
): Promise<{ restored: number; errors: string[] }> {
  let restored = 0;
  const errors: string[] = [];
  for (const asset of manifest.assets) {
    if (skippedAssetIds.has(asset.id)) continue;
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

async function repairAndRestoreProjectMedia(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
): Promise<{
  manifest: ProjectManifest;
  missing: MissingProjectMedia[];
  restoredErrors: string[];
  relinkedCount: number;
}> {
  const repair = await scanAndRelinkProjectMedia(handle, manifest);
  const missingIds = new Set(repair.unresolved.map(({ asset }) => asset.id));
  const restored = await restoreProjectMedia(handle, repair.manifest, missingIds);
  return {
    manifest: repair.manifest,
    missing: repair.unresolved,
    restoredErrors: restored.errors,
    relinkedCount: repair.relinkedAssetIds.length,
  };
}

export default function ProjectFolderControl({
  assets,
  onProjectMediaChange,
  onProjectSessionChange,
  onBeforePackageExport,
  projectSessionEpoch,
}: ProjectFolderControlProps) {
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [status, setStatus] = useState("No project folder open");
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<
    "opening" | "importing-package" | "exporting-package" | "copying" | "backing-up" | "deleting" | "relinking" | null
  >(null);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [selectedCleanupAssetId, setSelectedCleanupAssetId] = useState("");
  const [missingMedia, setMissingMedia] = useState<MissingProjectMedia[]>([]);
  const [selectedRelinkPaths, setSelectedRelinkPaths] = useState<Record<string, string>>({});
  const [relinkAssetId, setRelinkAssetId] = useState("");
  const [activeSession, setActiveSession] = useState<ProjectFolderSession | null>(null);
  const [storageUsage, setStorageUsage] = useState<ProjectMediaStorageUsage | null>(null);
  const [storageUsageError, setStorageUsageError] = useState("");
  const packageInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const busy = busyAction !== null;

  const availableAssets = assets.filter((asset) => asset.source.kind === "storage"
    && !manifest?.assets.some((projectAsset) => projectAsset.id === asset.id));
  const cleanupAssets = assets.filter((asset) => (storageUsage?.bytesByAssetId[asset.id] ?? 0) > 0
    && !manifest?.assets.some((projectAsset) => projectAsset.id === asset.id));
  const selectedCleanupAsset = cleanupAssets.find((asset) => asset.id === selectedCleanupAssetId);
  const projectMediaBytes = manifest?.assets.reduce((total, asset) => total + (asset.sizeBytes ?? 0), 0) ?? 0;

  useEffect(() => {
    let active = true;
    void getProjectMediaStorageUsage().then((usage) => {
      if (!active) return;
      setStorageUsage(usage);
      setStorageUsageError("");
    }).catch((caught: unknown) => {
      if (!active) return;
      setStorageUsageError(caught instanceof Error ? caught.message : "Could not read local media storage.");
    });
    return () => { active = false; };
  }, [assets, projectSessionEpoch]);

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
          setManifest(null);
          setMissingMedia([]);
          reportSession(null);
          return;
        }
        const result = await readOrCreateProjectManifest(saved.handle);
        if (!active) return;
        const inspection = await repairAndRestoreProjectMedia(saved.handle, result.manifest);
        if (!active) return;
        setManifest(inspection.manifest);
        setMissingMedia(inspection.missing);
        setSelectedRelinkPaths({});
        reportSession({
          handle: saved.handle,
          projectId: inspection.manifest.id,
          sessionKey: crypto.randomUUID(),
        });
        await onProjectMediaChange();
        if (!active) return;
        setStatus(`Project: ${inspection.manifest.name} · ${inspection.manifest.assets.length} media${
          inspection.missing.length ? ` · ${inspection.missing.length} missing` : ""
        }`);
        setError(inspection.restoredErrors.join(" "));
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
      setStatus(`Project: ${refreshedManifest.name} · ${refreshedManifest.assets.length} media${
        missingMedia.length ? ` · ${missingMedia.length} missing` : ""
      }`);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : "Could not refresh the project manifest.");
    });
    return () => { active = false; };
  }, [activeSession, missingMedia.length, projectSessionEpoch]);

  const openProjectFolder = async () => {
    setBusyAction("opening");
    setError("");
    try {
      const selectedFolder = await chooseProjectFolder();
      const handle = await findProjectFolderRoot(selectedFolder);
      const result = await readOrCreateProjectManifest(handle);
      const inspection = await repairAndRestoreProjectMedia(handle, result.manifest);
      await saveCurrentProjectFolder(handle);
      setManifest(inspection.manifest);
      setMissingMedia(inspection.missing);
      setSelectedRelinkPaths({});
      const session = {
        handle,
        projectId: inspection.manifest.id,
        sessionKey: crypto.randomUUID(),
      };
      setActiveSession(session);
      onProjectSessionChange(session);
      await onProjectMediaChange();
      setStatus(`${result.created ? "Created" : "Opened"}: ${inspection.manifest.name} · ${
        inspection.manifest.assets.length
      } media${inspection.missing.length ? ` · ${inspection.missing.length} missing` : ""}`);
      setError(inspection.restoredErrors.join(" "));
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setStatus("Folder selection was cancelled. If you selected a folder in VS Code, import a project package instead.");
      } else {
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

  const deleteSelectedMedia = async () => {
    const asset = selectedCleanupAsset;
    if (!asset) return;
    if (manifest?.assets.some((projectAsset) => projectAsset.id === asset.id)) {
      setError("This media is saved in the open project folder and cannot be removed through browser cleanup.");
      return;
    }
    const confirmed = window.confirm(
      `Remove "${asset.name}" (${formatMediaBytes(storageUsage?.bytesByAssetId[asset.id] ?? 0)}) from fal flow's browser storage? Project-folder files and workspace references will not be changed; references may no longer load locally. ${
        manifest
          ? "No copy exists in the open project folder, so this may be the only durable local copy."
          : "No project folder is open, so this may be the only durable local copy."
      } This cannot be undone.`,
    );
    if (!confirmed) return;

    setBusyAction("deleting");
    setError("");
    try {
      await deleteProjectMediaAsset(asset.id);
      await onProjectMediaChange();
      setSelectedCleanupAssetId("");
      setStorageUsage(await getProjectMediaStorageUsage());
      setStatus(`Removed "${asset.name}" from browser storage`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove local media.");
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
        setStatus("Backup folder selection was cancelled.");
      } else {
        setError(caught instanceof Error ? caught.message : "Could not back up the project.");
      }
    } finally {
      setBusyAction(null);
    }
  };

  const importProjectPackage = async (packageFile: File) => {
    setBusyAction("importing-package");
    setError("");
    setStatus("Importing project package…");
    try {
      const handle = await importProjectPackageToStorage(packageFile);
      const { manifest: importedManifest } = await readOrCreateProjectManifest(handle);
      const inspection = await repairAndRestoreProjectMedia(handle, importedManifest);
      await saveCurrentProjectFolder(handle);
      const session = {
        handle,
        projectId: inspection.manifest.id,
        sessionKey: crypto.randomUUID(),
      };
      setManifest(inspection.manifest);
      setMissingMedia(inspection.missing);
      setSelectedRelinkPaths({});
      setActiveSession(session);
      onProjectSessionChange(session);
      await onProjectMediaChange();
      setStatus(`Imported ${inspection.manifest.name} · ${inspection.manifest.assets.length} media${
        inspection.missing.length ? ` · ${inspection.missing.length} missing` : ""
      }`);
      setError(inspection.restoredErrors.join(" "));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import the project package.");
    } finally {
      setBusyAction(null);
    }
  };

  const exportProject = async () => {
    if (!activeSession || !manifest) return;
    setBusyAction("exporting-package");
    setError("");
    setStatus("Preparing project package…");
    try {
      await onBeforePackageExport();
      const packageBlob = await exportProjectPackage(activeSession.handle, manifest.id);
      const downloadUrl = URL.createObjectURL(packageBlob);
      const link = document.createElement("a");
      const safeName = manifest.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/g, "")
        .trim() || "fal-flow-project";
      link.href = downloadUrl;
      link.download = `${safeName}.falflow.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      setStatus(`Exported ${manifest.name} · ${formatMediaBytes(packageBlob.size)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export the project package.");
    } finally {
      setBusyAction(null);
    }
  };

  const finishMediaRepair = async (
    handle: FileSystemDirectoryHandle,
    nextManifest: ProjectManifest,
    statusLabel: string,
    forceReconnect = false,
  ) => {
    const inspection = await repairAndRestoreProjectMedia(handle, nextManifest);
    setManifest(inspection.manifest);
    setMissingMedia(inspection.missing);
    setSelectedRelinkPaths({});
    if (forceReconnect || inspection.relinkedCount > 0) {
      const session = {
        handle,
        projectId: inspection.manifest.id,
        sessionKey: crypto.randomUUID(),
      };
      setActiveSession(session);
      onProjectSessionChange(session);
    }
    await onProjectMediaChange();
    setError(inspection.restoredErrors.join(" "));
    setStatus(`${statusLabel}${inspection.missing.length ? ` · ${inspection.missing.length} still missing` : ""}`);
  };

  const searchProjectMedia = async () => {
    if (!activeSession || !manifest) return;
    setBusyAction("relinking");
    setError("");
    try {
      await finishMediaRepair(activeSession.handle, manifest, "Project media search complete");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not search project media.");
    } finally {
      setBusyAction(null);
    }
  };

  const relinkToCandidate = async (assetId: string) => {
    if (!activeSession || !manifest) return;
    const relativePath = selectedRelinkPaths[assetId];
    if (!relativePath) return;
    setBusyAction("relinking");
    setError("");
    try {
      const updatedManifest = await relinkProjectMediaAtPath(
        activeSession.handle,
        manifest,
        assetId,
        relativePath,
      );
      await finishMediaRepair(activeSession.handle, updatedManifest, "Project media relinked", true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not relink project media.");
    } finally {
      setBusyAction(null);
    }
  };

  const relinkToReplacementFile = async (file: File) => {
    const assetId = relinkAssetId;
    if (!activeSession || !manifest || !assetId) return;
    setBusyAction("relinking");
    setError("");
    try {
      const updatedManifest = await relinkProjectMediaFromFile(
        activeSession.handle,
        manifest,
        assetId,
        file,
      );
      await finishMediaRepair(activeSession.handle, updatedManifest, `Replaced "${file.name}"`, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not use the selected media file.");
    } finally {
      setBusyAction(null);
      setRelinkAssetId("");
    }
  };

  return (
    <details className="ff-project-folder-menu">
      <summary
        className="ff-project-folder-trigger"
        title={manifest
          ? `Current project: ${manifest.name}\nThe browser hides the full folder path.`
          : "Project folder options"}
        aria-label={manifest ? `Project menu, current project ${manifest.name}` : "Project folder menu"}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M2.5 5.5h5l1.8 2h8.2v8.8H2.5z" />
          <path d="M2.5 7.5h15" />
        </svg>
        <span className="ff-project-folder-trigger-name">{manifest?.name ?? "Project"}</span>
        <span className="ff-project-folder-trigger-arrow" aria-hidden="true">⌄</span>
      </summary>
      <div className="ff-project-folder-popover">
        <div className="ff-project-folder-control">
          <div className="ff-project-folder-storage" aria-label="Local media storage">
            <span>
              <strong>Browser media:</strong>{" "}
              {storageUsage
                ? `${formatMediaBytes(storageUsage.bytes)} across ${storageUsage.cachedAssets} files`
                : "Calculating…"}
            </span>
            {manifest && (
              <span>
                <strong>Project files:</strong>{" "}
                {formatMediaBytes(projectMediaBytes)} across {manifest.assets.length} files
              </span>
            )}
            {storageUsageError && <span role="alert">{storageUsageError}</span>}
          </div>
          <button
            type="button"
            className="ff-toolbar-button"
            onClick={() => void openProjectFolder()}
            disabled={busy}
            title={manifest
              ? `Current project: ${manifest.name}\nThe browser hides the full folder path.`
              : "Open a project folder or select a backup folder to restore it."}
          >
            {busyAction === "opening" ? "Opening project…" : manifest ? "Change project folder" : "Open project folder"}
          </button>
          <input
            ref={packageInputRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const packageFile = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (packageFile) void importProjectPackage(packageFile);
            }}
          />
          <input
            ref={relinkInputRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void relinkToReplacementFile(file);
            }}
          />
          <button
            type="button"
            className="ff-toolbar-button"
            onClick={() => packageInputRef.current?.click()}
            disabled={busy}
            title="Open a portable project package. Its workflow, storyboard, editor/compositor state, and media are restored on this browser."
          >
            {busyAction === "importing-package" ? "Importing package…" : "Open project package (.zip)"}
          </button>
          <span className="ff-project-folder-status" role={error ? "alert" : "status"} title={error || status}>
            {error || status}
          </span>
          {manifest && (
            <>
              {missingMedia.length > 0 && (
                <section className="ff-project-media-missing" aria-label="Missing project media" role="alert">
                  <div className="ff-project-media-missing-heading">
                    <div>
                      <strong>{missingMedia.length} missing project {missingMedia.length === 1 ? "file" : "files"}</strong>
                      <p>
                        Fal flow searched this project folder for exact filename and size matches. Only unique matches
                        are linked automatically; ambiguous files need your choice.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ff-toolbar-button"
                      onClick={() => void searchProjectMedia()}
                      disabled={busy || !activeSession}
                    >
                      {busyAction === "relinking" ? "Searching…" : "Search selected folder"}
                    </button>
                  </div>
                  {missingMedia.map(({ asset, candidates }) => (
                    <div className="ff-project-media-missing-item" key={asset.id}>
                      <div>
                        <strong>{asset.name}</strong>
                        <span>
                          Expected: {asset.relativePath}
                          {asset.sizeBytes !== null
                            ? ` · ${formatMediaBytes(asset.sizeBytes)}`
                            : " · no saved file size; choose a candidate manually"}
                        </span>
                      </div>
                      {candidates.length > 0 ? (
                        <div className="ff-project-media-relink-choice">
                          <select
                            className="ff-project-folder-select"
                            aria-label={`Candidate files for ${asset.name}`}
                            value={selectedRelinkPaths[asset.id] ?? ""}
                            onChange={(event) => setSelectedRelinkPaths((current) => ({
                              ...current,
                              [asset.id]: event.target.value,
                            }))}
                            disabled={busy}
                          >
                            <option value="">
                              {asset.sizeBytes === null ? "Choose a candidate…" : "Choose a matching file…"}
                            </option>
                            {candidates.map((path) => <option key={path} value={path}>{path}</option>)}
                          </select>
                          <button
                            type="button"
                            className="ff-toolbar-button"
                            onClick={() => void relinkToCandidate(asset.id)}
                            disabled={busy || !selectedRelinkPaths[asset.id]}
                          >
                            Link selected file
                          </button>
                        </div>
                      ) : (
                        <span className="ff-project-media-no-match">
                          {asset.sizeBytes === null ? "No matching filename was found." : "No exact filename and size match found."}
                        </span>
                      )}
                      <button
                        type="button"
                        className="ff-toolbar-button"
                        onClick={() => {
                          setRelinkAssetId(asset.id);
                          relinkInputRef.current?.click();
                        }}
                        disabled={busy}
                      >
                        Choose replacement file…
                      </button>
                    </div>
                  ))}
                  <p className="ff-project-media-relink-note">
                    Replacing media copies it into this project. The project media ID is preserved, reconnecting its
                    references across tabs.
                  </p>
                </section>
              )}
              <button
                type="button"
                className="ff-toolbar-button"
                onClick={() => void exportProject()}
                disabled={busy || !activeSession}
                title="Download a portable package with this project's workspace and media. Wait for other workspace saves to finish. API keys are not included."
              >
                {busyAction === "exporting-package" ? "Exporting package…" : "Export project package (.zip)"}
              </button>
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
          <select
            className="ff-project-folder-select"
            aria-label="Media to delete from browser storage"
            value={selectedCleanupAsset ? selectedCleanupAssetId : ""}
            onChange={(event) => setSelectedCleanupAssetId(event.target.value)}
            disabled={busy || cleanupAssets.length === 0}
          >
            <option value="">
              {cleanupAssets.length ? "Select local media to remove…" : "No removable browser media"}
            </option>
            {cleanupAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name} ({formatMediaBytes(storageUsage?.bytesByAssetId[asset.id] ?? 0)})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ff-toolbar-button ff-delete-media-button"
            onClick={() => void deleteSelectedMedia()}
            disabled={busy || !selectedCleanupAsset}
            title="Remove the selected browser-stored media. Project-folder files and workflow references are not changed."
          >
            {busyAction === "deleting" ? "Removing…" : "Delete local copy"}
          </button>
        </div>
      </div>
    </details>
  );
}
