"use client";

import {
  normalizeProjectManifest,
  PROJECT_MANIFEST_FORMAT,
  PROJECT_MANIFEST_VERSION,
  normalizeProjectRelativePath,
  type ProjectManifest,
  type ProjectManifestAsset,
} from "./project-manifest";
import {
  createProjectVideoEditorDocument,
  createProjectVideoEditorState,
  normalizeProjectVideoEditorDocument,
  PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME,
} from "./project-video-editor";
import type { ProjectMediaAsset } from "./project-media";
import type { StoredVideoEditorState } from "./video-editor-storage";

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      startIn?: FileSystemHandle;
    }) => Promise<FileSystemFileHandle[]>;
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

export type ProjectFolderSession = {
  handle: FileSystemDirectoryHandle;
  projectId: string;
  sessionKey: string;
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

export async function saveProjectManifest(
  handle: FileSystemDirectoryHandle,
  manifestValue: ProjectManifest,
): Promise<ProjectManifest> {
  const manifest = normalizeProjectManifest(manifestValue);
  await writeManifest(handle, manifest);
  return manifest;
}

async function getFileHandleAtPath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  createParents: boolean,
): Promise<FileSystemFileHandle> {
  const segments = normalizeProjectRelativePath(relativePath).split("/");
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create: createParents });
  }
  return directory.getFileHandle(segments[segments.length - 1], { create: createParents });
}

function safeMediaFileName(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
  return sanitized || "media";
}

export async function addMediaToProjectFolder(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
  asset: ProjectMediaAsset,
  file: File,
): Promise<ProjectManifest> {
  if (manifest.assets.some((entry) => entry.id === asset.id)) {
    throw new Error(`"${asset.name}" is already in this project.`);
  }
  if (file.size <= 0) throw new Error(`"${asset.name}" is empty and cannot be added to the project.`);

  const relativePath = `Media/Originals/${crypto.randomUUID()}-${safeMediaFileName(file.name)}`;
  const fileHandle = await getFileHandleAtPath(handle, relativePath, true);
  const writable = await fileHandle.createWritable();
  await writable.write(file);
  await writable.close();

  const entry: ProjectManifestAsset = {
    id: asset.id,
    name: asset.name,
    mediaKind: asset.mediaKind,
    mimeType: file.type || asset.mimeType,
    relativePath,
    proxyPath: null,
    sizeBytes: file.size,
    sha256: null,
    metadata: asset.metadata,
  };
  const updatedManifest = normalizeProjectManifest({
    ...manifest,
    updatedAt: new Date().toISOString(),
    assets: [...manifest.assets, entry],
  });
  return saveProjectManifest(handle, updatedManifest);
}

export async function readProjectMediaFile(
  handle: FileSystemDirectoryHandle,
  asset: ProjectManifestAsset,
): Promise<File> {
  const fileHandle = await getFileHandleAtPath(handle, asset.relativePath, false).catch((error: unknown) => {
    if (isNamedError(error, "NotFoundError")) {
      throw new Error(`Project media "${asset.name}" is missing at "${asset.relativePath}".`, { cause: error });
    }
    throw error;
  });
  const storedFile = await fileHandle.getFile();
  if (asset.sizeBytes !== null && storedFile.size !== asset.sizeBytes) {
    throw new Error(
      `Project media "${asset.name}" has changed size (expected ${asset.sizeBytes} bytes, found ${storedFile.size}).`,
    );
  }
  return new File([storedFile], asset.name, {
    type: asset.mimeType || storedFile.type,
    lastModified: storedFile.lastModified,
  });
}

export async function readProjectMediaAssetFile(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
  assetId: string,
): Promise<File> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its media could be loaded.");
  }
  const asset = manifest.assets.find((entry) => entry.id === assetId);
  if (!asset) throw new Error(`Project media "${assetId}" is not listed in the project manifest.`);
  return readProjectMediaFile(handle, asset);
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

export async function loadProjectVideoEditorState(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
): Promise<StoredVideoEditorState> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its video-editor document could be loaded.");
  }

  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await handle.getFileHandle(PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME);
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    return createProjectVideoEditorState(manifest);
  }

  const text = await (await fileHandle.getFile()).text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `The project video-editor document "${PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME}" contains invalid JSON.`,
        { cause: error },
      );
    }
    throw error;
  }
  return normalizeProjectVideoEditorDocument(raw, manifest).state;
}

export async function saveProjectVideoEditorState(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
  state: StoredVideoEditorState,
): Promise<void> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its video-editor document could be saved.");
  }
  const document = createProjectVideoEditorDocument(state, manifest);
  const fileHandle = await handle.getFileHandle(PROJECT_VIDEO_EDITOR_DOCUMENT_FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(document, null, 2)}\n`);
  await writable.close();
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

export async function chooseProjectMediaFiles(
  projectFolder: FileSystemDirectoryHandle,
): Promise<File[] | null> {
  if (!window.showOpenFilePicker) return null;
  const handles = await window.showOpenFilePicker({
    multiple: true,
    startIn: projectFolder,
  });
  return Promise.all(handles.map((handle) => handle.getFile()));
}
