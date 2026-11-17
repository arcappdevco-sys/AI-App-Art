"use client";

import { useEffect, useState } from "react";
import {
  chooseProjectFolder,
  loadCurrentProjectFolder,
  projectFolderPermission,
  readOrCreateProjectManifest,
  saveCurrentProjectFolder,
} from "@/lib/project-folder-storage";
import type { ProjectManifest } from "@/lib/project-manifest";

export default function ProjectFolderControl() {
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [status, setStatus] = useState("No project folder open");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = await loadCurrentProjectFolder();
        if (!active || !saved) return;
        const permission = await projectFolderPermission(saved.handle);
        if (!active) return;
        if (permission !== "granted") {
          setStatus(`Select "${saved.name}" again to reconnect`);
          return;
        }
        const result = await readOrCreateProjectManifest(saved.handle);
        if (!active) return;
        setManifest(result.manifest);
        setStatus(`Project: ${result.manifest.name} · ${result.manifest.assets.length} media`);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "Could not restore the project folder.");
      }
    })();
    return () => { active = false; };
  }, []);

  const openProjectFolder = async () => {
    setBusy(true);
    setError("");
    try {
      const handle = await chooseProjectFolder();
      const result = await readOrCreateProjectManifest(handle);
      await saveCurrentProjectFolder(handle);
      setManifest(result.manifest);
      setStatus(`${result.created ? "Created" : "Opened"}: ${result.manifest.name} · ${result.manifest.assets.length} media`);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : "Could not open the project folder.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ff-project-folder-control">
      <button
        type="button"
        className="ff-toolbar-button"
        onClick={() => void openProjectFolder()}
        disabled={busy}
        title="Open a folder-backed project or create its manifest in an empty folder."
      >
        {busy ? "Opening project…" : manifest ? "Change project folder" : "Open project folder"}
      </button>
      <span className="ff-project-folder-status" role={error ? "alert" : "status"} title={error || status}>
        {error || status}
      </span>
    </div>
  );
}
