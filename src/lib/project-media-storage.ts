"use client";

import { normalizeProjectMediaAsset, type ProjectMediaAsset } from "./project-media";

type StoredProjectMediaAsset = ProjectMediaAsset & {
  blob?: Blob;
  updatedAt: number;
};

const DATABASE_NAME = "fal-flow-project-media";
const DATABASE_VERSION = 1;
const ASSET_STORE = "assets";
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const pendingLoads = new Map<string, Promise<File>>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support shared media storage."));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ASSET_STORE)) {
        request.result.createObjectStore(ASSET_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open shared media storage."));
    request.onblocked = () => reject(new Error("Shared media storage is blocked by another open tab."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Shared media storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Shared media storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Shared media storage transaction failed."));
  });
}

async function getStoredAsset(id: string): Promise<StoredProjectMediaAsset | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const done = transactionDone(transaction);
    const [asset] = await Promise.all([
      requestResult(transaction.objectStore(ASSET_STORE).get(id) as IDBRequest<StoredProjectMediaAsset | undefined>),
      done,
    ]);
    return asset;
  } finally {
    database.close();
  }
}

async function cacheDownloadedBlob(id: string, expectedSource: ProjectMediaAsset["source"], blob: Blob): Promise<boolean> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    const store = transaction.objectStore(ASSET_STORE);
    const done = transactionDone(transaction);
    const request = store.get(id) as IDBRequest<StoredProjectMediaAsset | undefined>;
    let cached = false;
    request.onsuccess = () => {
      const current = request.result;
      if (!current || JSON.stringify(current.source) !== JSON.stringify(expectedSource)) return;
      const source = current.source.kind === "data-url"
        ? { kind: "storage" as const, storageKey: current.id }
        : current.source;
      store.put({ ...current, source, blob, updatedAt: Date.now() } satisfies StoredProjectMediaAsset);
      cached = true;
    };
    request.onerror = () => transaction.abort();
    await done;
    return cached;
  } finally {
    database.close();
  }
}

export async function registerProjectMediaAsset(assetValue: ProjectMediaAsset, blob?: Blob): Promise<ProjectMediaAsset> {
  const asset = normalizeProjectMediaAsset(assetValue);
  if (asset.source.kind === "data-url" && !blob) {
    throw new Error(`Inline media "${asset.name}" must be registered as a stored Blob.`);
  }
  if (blob && (blob.size <= 0 || blob.size > MAX_MEDIA_BYTES)) {
    throw new Error(`"${asset.name}" must be between 1 byte and 512 MB.`);
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readwrite");
    const store = transaction.objectStore(ASSET_STORE);
    const done = transactionDone(transaction);
    const request = store.get(asset.id) as IDBRequest<StoredProjectMediaAsset | undefined>;
    request.onsuccess = () => {
      const previous = request.result;
      const sameSource = previous && JSON.stringify(previous.source) === JSON.stringify(asset.source);
      store.put({
        ...asset,
        ...(blob ? { blob } : sameSource && previous.blob ? { blob: previous.blob } : {}),
        updatedAt: Date.now(),
      } satisfies StoredProjectMediaAsset);
    };
    request.onerror = () => transaction.abort();
    await done;
    return asset;
  } finally {
    database.close();
  }
}

export async function listProjectMediaAssets(): Promise<ProjectMediaAsset[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(ASSET_STORE, "readonly");
    const done = transactionDone(transaction);
    const [stored] = await Promise.all([
      requestResult(transaction.objectStore(ASSET_STORE).getAll() as IDBRequest<StoredProjectMediaAsset[]>),
      done,
    ]);
    return stored
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ id, name, mediaKind, mimeType, source, metadata }) =>
        normalizeProjectMediaAsset({ id, name, mediaKind, mimeType, source, metadata }));
  } finally {
    database.close();
  }
}

async function fetchAssetSource(asset: ProjectMediaAsset): Promise<Blob> {
  if (asset.source.kind === "data-url") {
    const response = await fetch(asset.source.dataUrl);
    return response.blob();
  }
  if (asset.source.kind !== "url") {
    throw new Error(`Shared media "${asset.name}" is missing from browser storage.`);
  }
  const response = await fetch("/api/media/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: asset.source.url }),
  });
  if (!response.ok) {
    let message = `Could not download "${asset.name}" (${response.status}).`;
    try {
      const payload: unknown = await response.json();
      if (typeof payload === "object" && payload !== null
        && "error" in payload && typeof payload.error === "string") message = payload.error;
    } catch {
      // Keep the status-based message if the response isn't JSON.
    }
    throw new Error(message);
  }
  return response.blob();
}

export async function loadProjectMediaFile(id: string): Promise<File> {
  const pending = pendingLoads.get(id);
  if (pending) return pending;
  const loading = (async () => {
    while (true) {
      const stored = await getStoredAsset(id);
      if (!stored) throw new Error(`Shared media "${id}" is not registered.`);
      const asset = normalizeProjectMediaAsset(stored);
      if (stored.blob) {
        const fallbackType = asset.mediaKind === "video" ? "video/mp4"
          : asset.mediaKind === "image" ? "image/png"
            : asset.mediaKind === "audio" ? "audio/mpeg" : "";
        return new File([stored.blob], asset.name, {
          type: stored.blob.type || asset.mimeType || fallbackType,
        });
      }
      const blob = await fetchAssetSource(asset);
      if (blob.size <= 0 || blob.size > MAX_MEDIA_BYTES) {
        throw new Error(`"${asset.name}" must be between 1 byte and 512 MB.`);
      }
      if (!await cacheDownloadedBlob(id, asset.source, blob)) continue;
      const fallbackType = asset.mediaKind === "video" ? "video/mp4"
        : asset.mediaKind === "image" ? "image/png"
          : asset.mediaKind === "audio" ? "audio/mpeg" : "";
      return new File([blob], asset.name, { type: blob.type || asset.mimeType || fallbackType });
    }
  })();
  pendingLoads.set(id, loading);
  try {
    return await loading;
  } finally {
    pendingLoads.delete(id);
  }
}
