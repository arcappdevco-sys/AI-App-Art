export function findAtlasUploadUrl(value: unknown, depth = 0, searchAllFields = false): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return /^https?:\/\/\S+$/i.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findAtlasUploadUrl(item, depth + 1, searchAllFields);
      if (url) return url;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["url", "download_url", "downloadUrl", "file_url", "fileUrl", "media_url", "mediaUrl", "image_url", "imageUrl",
    "data", "result", "file", "media", "output"]) {
    const url = findAtlasUploadUrl(record[key], depth + 1, searchAllFields);
    if (url) return url;
  }
  if (searchAllFields) {
    for (const item of Object.values(record)) {
      const url = findAtlasUploadUrl(item, depth + 1, true);
      if (url) return url;
    }
  }
  return "";
}
