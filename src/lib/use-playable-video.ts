import { useEffect, useState } from "react";
import { loadProjectMediaFileForUrl } from "./project-media-storage";

// Atlas serves videos with "Content-Disposition: attachment" and no CORS headers,
// which stops <video> from playing them; load through the same-origin download route.
export function usePlayableVideo(url: string | undefined) {
  const [state, setState] = useState<{ source: string; blobUrl: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const loadVideo = async () => {
      const savedFile = await loadProjectMediaFileForUrl(url);
      if (controller.signal.aborted) return;
      const blob = savedFile ?? await (async () => {
        const response = await fetch("/api/media/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob.type.startsWith("video/") ? blob : new Blob([blob], { type: "video/mp4" }));
      setState({ source: url, blobUrl: objectUrl });
      setFailed(null);
    };
    void loadVideo().catch((error: unknown) => {
      if (!controller.signal.aborted) setFailed(error instanceof Error ? error.message : "Could not load video.");
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  const src = url && state?.source === url ? state.blobUrl : undefined;
  return { src, loading: Boolean(url) && !src && !failed, error: url ? failed : null };
}
