export type WanUploadKind = "image" | "video" | "audio" | "document";

type WanApiError = { error?: unknown };

async function wanResponseError(response: Response, fallback: string) {
  let payload: WanApiError = {};
  try {
    payload = await response.json() as WanApiError;
  } catch {
    return `Atlas request failed (${response.status}).`;
  }
  if (response.status === 401 || response.status === 403) return "Atlas rejected the API key.";
  return typeof payload.error === "string" && payload.error
    ? payload.error
    : `${fallback} (${response.status}).`;
}

export async function uploadWanMedia(file: File, kind: WanUploadKind, signal?: AbortSignal) {
  const form = new FormData();
  form.append("action", "upload");
  form.append("kind", kind);
  form.append("file", file, file.name);
  const response = await fetch("/api/atlas/wan", { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(await wanResponseError(response, "Atlas media upload failed"));
  const result = await response.json() as { url?: unknown };
  if (typeof result.url !== "string" || !result.url) {
    throw new Error("Atlas upload did not return a public media URL.");
  }
  return result.url;
}

export async function submitWanPrediction(body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch("/api/atlas/wan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "generate", body }),
    signal,
  });
  if (!response.ok) throw new Error(await wanResponseError(response, "Atlas could not start the generation"));
  const result = await response.json() as { predictionId?: unknown; status?: unknown };
  if (typeof result.predictionId !== "string" || !result.predictionId) {
    throw new Error("Atlas did not return a prediction ID.");
  }
  return {
    predictionId: result.predictionId,
    status: typeof result.status === "string" ? result.status : "created",
  };
}

export type WanPrediction = {
  status: string;
  outputs?: unknown;
  error?: unknown;
};

export async function getWanPrediction(predictionId: string, signal?: AbortSignal): Promise<WanPrediction> {
  const response = await fetch(`/api/atlas/wan?prediction_id=${encodeURIComponent(predictionId)}`, { signal });
  if (!response.ok) throw new Error(await wanResponseError(response, "Atlas status check failed"));
  const result = await response.json() as { data?: unknown };
  if (typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) {
    throw new Error("Atlas returned an invalid prediction status.");
  }
  const data = result.data as Record<string, unknown>;
  return {
    status: typeof data.status === "string" ? data.status : "",
    outputs: data.outputs,
    error: data.error,
  };
}

export async function uploadMiniMaxMedia(file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("action", "minimax_upload");
  form.append("file", file, file.name);
  const response = await fetch("/api/atlas/wan", { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(await wanResponseError(response, "Atlas media upload failed"));
  const result = await response.json() as { url?: unknown };
  if (typeof result.url !== "string" || !result.url) {
    throw new Error("Atlas upload did not return a public media URL.");
  }
  return result.url;
}

export async function submitMiniMaxPrediction(body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch("/api/atlas/wan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "minimax_generate", body }),
    signal,
  });
  if (!response.ok) throw new Error(await wanResponseError(response, "Atlas could not start the generation"));
  const result = await response.json() as { predictionId?: unknown; status?: unknown };
  if (typeof result.predictionId !== "string" || !result.predictionId) {
    throw new Error("Atlas did not return a prediction ID.");
  }
  return {
    predictionId: result.predictionId,
    status: typeof result.status === "string" ? result.status : "created",
  };
}

export async function getMiniMaxPrediction(predictionId: string, signal?: AbortSignal): Promise<WanPrediction> {
  const response = await fetch(`/api/atlas/wan?prediction_id=${encodeURIComponent(predictionId)}`, { signal });
  if (!response.ok) throw new Error(await wanResponseError(response, "Atlas status check failed"));
  const result = await response.json() as { data?: unknown };
  if (typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) {
    throw new Error("Atlas returned an invalid prediction status.");
  }
  const data = result.data as Record<string, unknown>;
  return {
    status: typeof data.status === "string" ? data.status : "",
    outputs: data.outputs,
    error: data.error,
  };
}

export function wanDataUrlToFile(value: string, filename: string, fallbackType: string): File {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/i.exec(value);
  if (!match) throw new Error("Local media data is invalid.");
  const mimeType = match[1] || fallbackType;
  const encoded = match[2];
  let bytes: Uint8Array;
  if (/^data:[^,]*;base64,/i.test(value)) {
    const binary = atob(encoded);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(encoded));
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  const name = !/\.[a-z0-9]{2,5}$/i.test(filename) && extension
    ? `${filename}.${extension}`
    : filename;
  return new File([buffer], name, { type: mimeType });
}
