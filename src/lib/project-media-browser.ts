"use client";

import { createUnknownMediaAssetMetadata, type MediaAssetMetadata } from "./project-media";

function loadMediaMetadata(element: HTMLMediaElement, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onError);
    };
    const onLoaded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("Could not read media metadata.")); };
    element.addEventListener("loadedmetadata", onLoaded, { once: true });
    element.addEventListener("error", onError, { once: true });
    element.src = source;
    element.load();
  });
}

export async function inspectMediaAssetMetadata(file: File): Promise<MediaAssetMetadata> {
  const metadata = createUnknownMediaAssetMetadata();
  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file);
    try {
      metadata.width = bitmap.width;
      metadata.height = bitmap.height;
      return metadata;
    } finally {
      bitmap.close();
    }
  }
  if (file.type.startsWith("video/") || file.type.startsWith("audio/")) {
    const source = URL.createObjectURL(file);
    const element = file.type.startsWith("video/")
      ? document.createElement("video")
      : document.createElement("audio");
    element.preload = "metadata";
    try {
      await loadMediaMetadata(element, source);
      if (!Number.isFinite(element.duration) || element.duration < 0) {
        throw new Error(`Could not read the duration of "${file.name}".`);
      }
      metadata.durationSeconds = element.duration;
      if (element instanceof HTMLVideoElement) {
        if (element.videoWidth <= 0 || element.videoHeight <= 0) {
          throw new Error(`Could not read the dimensions of "${file.name}".`);
        }
        metadata.width = element.videoWidth;
        metadata.height = element.videoHeight;
      }
      return metadata;
    } finally {
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(source);
    }
  }
  throw new Error(`Cannot inspect unsupported media type "${file.type || "unknown"}".`);
}

export async function inspectImageDataUrlMetadata(dataUrl: string): Promise<MediaAssetMetadata> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not read image dimensions."));
    image.src = dataUrl;
  });
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error("Could not read image dimensions.");
  }
  return {
    ...createUnknownMediaAssetMetadata(),
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}
