const ROUTE = "/api/atlas/wan";
const REJECTED = "Atlas rejected the API key. Check the key, then restart the dev server after changing .env.local.";

async function flux3Error(response: Response, fallback: string) {
  if (response.status === 401 || response.status === 403) return REJECTED;
  try {
    const payload = await response.json() as { error?: unknown };
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    return `Atlas request failed (${response.status}).`;
  }
  return `${fallback} (${response.status}).`;
}

export async function uploadFlux3Media(file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("action", "flux3_upload");
  form.append("file", file, file.name);
  const response = await fetch(ROUTE, { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(await flux3Error(response, "Atlas media upload failed"));
  const result = await response.json() as { url?: unknown };
  if (typeof result.url !== "string" || !result.url) throw new Error("Atlas upload did not return a public media URL.");
  return result.url;
}

export async function submitFlux3Prediction(body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "flux3_generate", body }),
    signal,
  });
  if (!response.ok) throw new Error(await flux3Error(response, "Atlas could not start the generation"));
  const result = await response.json() as { predictionId?: unknown; status?: unknown };
  if (typeof result.predictionId !== "string" || !result.predictionId) {
    throw new Error("Atlas did not return a prediction ID.");
  }
  return {
    predictionId: result.predictionId,
    status: typeof result.status === "string" ? result.status : "created",
  };
}

export type Flux3Prediction = { status: string; outputs?: unknown; error?: unknown };

export async function uploadFlux3VideoMedia(file: File, signal?: AbortSignal) {
  const form = new FormData();
  form.append("action", "flux3_video_upload");
  form.append("file", file, file.name);
  const response = await fetch(ROUTE, { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(await flux3Error(response, "Atlas media upload failed"));
  const result = await response.json() as { url?: unknown };
  if (typeof result.url !== "string" || !result.url) throw new Error("Atlas upload did not return a public media URL.");
  return result.url;
}

export async function submitFlux3VideoPrediction(body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "flux3_video_generate", body }),
    signal,
  });
  if (!response.ok) throw new Error(await flux3Error(response, "Atlas could not start the generation"));
  const result = await response.json() as { predictionId?: unknown; status?: unknown };
  if (typeof result.predictionId !== "string" || !result.predictionId) {
    throw new Error("Atlas did not return a prediction ID.");
  }
  return {
    predictionId: result.predictionId,
    status: typeof result.status === "string" ? result.status : "created",
  };
}

export async function getFlux3Prediction(predictionId: string, signal?: AbortSignal): Promise<Flux3Prediction> {
  const response = await fetch(`${ROUTE}?prediction_id=${encodeURIComponent(predictionId)}`, { signal });
  if (!response.ok) throw new Error(await flux3Error(response, "Atlas status check failed"));
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

export async function checkFlux3Key() {
  const response = await fetch(ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "flux3_check_key" }),
  });
  if (response.status === 500) {
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error === "string") return payload.error;
    } catch {
      return "Could not check the Atlas key.";
    }
  }
  try {
    const payload = await response.json() as { result?: unknown; status?: unknown };
    if (payload.result === "accepted") return "Key accepted";
    if (payload.result === "rejected") return `Atlas rejected the key (status ${String(payload.status)})`;
    return `Could not verify the key (status ${String(payload.status ?? response.status)}).`;
  } catch {
    return "Could not check the Atlas key.";
  }
}
