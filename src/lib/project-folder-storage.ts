"use client";

import {
  normalizeProjectManifest,
  PROJECT_MANIFEST_FORMAT,
  PROJECT_MANIFEST_VERSION,
  type ProjectManifest,
} from "./project-manifest";

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemHandle {
    queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  }
}

export const PROJECT_MANIFEST_FILE_NAME = "fal-flow.project.json";

const DATABASE_NAME = "fal-flow-project-folders";
const DATABASE_VERSION = 1;
const FOLDER_STORE = "folders";
const CURRENT_FOLDER_KEY = "current";

type StoredProjectFolder = {
  name: string;
  handle: FileSystemDirectoryHandle;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support saved project folders."));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FOLDER_STORE)) {
        request.result.createObjectStore(FOLDER_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project-folder storage."));
    request.onblocked = () => reject(new Error("Project-folder storage is blocked by another open tab."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Project-folder storage request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Project-folder storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Project-folder storage transaction failed."));
  });
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

function createManifest(folderName: string): ProjectManifest {
  const now = new Date().toISOString();
  return normalizeProjectManifest({
    format: PROJECT_MANIFEST_FORMAT,
    schemaVersion: PROJECT_MANIFEST_VERSION,
    id: crypto.randomUUID(),
    name: folderName,
    createdAt: now,
    updatedAt: now,
    assets: [],
  });
}

async function writeManifest(handle: FileSystemDirectoryHandle, manifest: ProjectManifest): Promise<void> {
  const fileHandle = await handle.getFileHandle(PROJECT_MANIFEST_FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(manifest, null, 2)}\n`);
  await writable.close();
}

export async function readOrCreateProjectManifest(
  handle: FileSystemDirectoryHandle,
): Promise<{ manifest: ProjectManifest; created: boolean }> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await handle.getFileHandle(PROJECT_MANIFEST_FILE_NAME);
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    const manifest = createManifest(handle.name);
    await writeManifest(handle, manifest);
    return { manifest, created: true };
  }

  const text = await (await fileHandle.getFile()).text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`The project manifest "${PROJECT_MANIFEST_FILE_NAME}" contains invalid JSON.`, { cause: error });
    }
    throw error;
  }
  return { manifest: normalizeProjectManifest(raw), created: false };
}

export async function saveCurrentProjectFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(FOLDER_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(FOLDER_STORE).put({ name: handle.name, handle } satisfies StoredProjectFolder, CURRENT_FOLDER_KEY);
    await done;
  } finally {
    database.close();
  }
}

export async function loadCurrentProjectFolder(): Promise<StoredProjectFolder | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(FOLDER_STORE, "readonly");
    const done = transactionDone(transaction);
    const [folder] = await Promise.all([
      requestResult(
        transaction.objectStore(FOLDER_STORE).get(CURRENT_FOLDER_KEY) as IDBRequest<StoredProjectFolder | undefined>,
      ),
      done,
    ]);
    return folder ?? null;
  } finally {
    database.close();
  }
}

export async function projectFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState | "unsupported"> {
  if (!handle.queryPermission) return "unsupported";
  return handle.queryPermission({ mode: "readwrite" });
}

export async function chooseProjectFolder(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error("Opening project folders requires a browser with the File System Access API, such as Chrome or Edge.");
  }
  return window.showDirectoryPicker({ mode: "readwrite" });
}
