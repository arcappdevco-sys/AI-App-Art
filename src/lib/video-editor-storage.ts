"use client";

export type StoredEditorClip = {
  id: string;
  name: string;
  mediaId: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
};

export type StoredEditorSequence = {
  id: string;
  name: string;
  clips: StoredEditorClip[];
  selectedId: string;
  playheadTime: number;
};

export type StoredEditorAsset = {
  id: string;
  name: string;
  mediaId: string;
};

export type StoredVideoEditorState = {
  version: 1;
  sequences: StoredEditorSequence[];
  uploadedAssets: StoredEditorAsset[];
  activeSequenceId: string;
  activeTool: "select" | "razor";
};

type StoredMedia = {
  id: string;
  name: string;
  type: string;
  blob: Blob;
};

const DATABASE_NAME = "fal-flow-video-editor";
const DATABASE_VERSION = 1;
const STATE_STORE = "editor-state";
const MEDIA_STORE = "media";
const STATE_KEY = "current";

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const openingDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support persistent video-editor storage."));
      return;
    }

    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(MEDIA_STORE)) database.createObjectStore(MEDIA_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open video-editor storage."));
    request.onblocked = () => reject(new Error("Video-editor storage is blocked by another open tab."));
  }).catch((error: unknown): IDBDatabase => {
    databasePromise = null;
    throw error;
  });
  databasePromise = openingDatabase;
  return openingDatabase;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Video-editor storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Video-editor storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Video-editor storage transaction failed."));
  });
}

export async function saveEditorMedia(id: string, file: File) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(MEDIA_STORE).put({
    id,
    name: file.name,
    type: file.type,
    blob: file,
  } satisfies StoredMedia);
  await done;
}

export async function loadEditorMedia(id: string) {
  const database = await openDatabase();
  const transaction = database.transaction(MEDIA_STORE, "readonly");
  const done = transactionDone(transaction);
  const [result] = await Promise.all([
    requestResult(transaction.objectStore(MEDIA_STORE).get(id) as IDBRequest<StoredMedia | undefined>),
    done,
  ]);
  if (!result) throw new Error(`Saved video-editor media "${id}" is missing from browser storage.`);
  return new File([result.blob], result.name, { type: result.type });
}

export async function saveVideoEditorState(state: StoredVideoEditorState) {
  const database = await openDatabase();
  const transaction = database.transaction(STATE_STORE, "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore(STATE_STORE).put({ ...state, id: STATE_KEY });
  await done;
}

export async function loadVideoEditorState() {
  const database = await openDatabase();
  const transaction = database.transaction(STATE_STORE, "readonly");
  const done = transactionDone(transaction);
  const [result] = await Promise.all([
    requestResult(
      transaction.objectStore(STATE_STORE).get(STATE_KEY) as IDBRequest<StoredVideoEditorState | undefined>,
    ),
    done,
  ]);
  return result ?? null;
}
