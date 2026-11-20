"use client";

import { unzipSync, zipSync } from "fflate";
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
import {
  createProjectCompositorDocument,
  normalizeProjectCompositorDocument,
  PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME,
  type ProjectCompositorState,
} from "./project-compositor";
import {
  createProjectWorkspaceDocument,
  normalizeProjectWorkspaceDocument,
  PROJECT_WORKSPACE_DOCUMENT_FILE_NAME,
  type ProjectWorkspaceState,
} from "./project-workspace";

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

  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
}

export const PROJECT_MANIFEST_FILE_NAME = "fal-flow.project.json";
export const PROJECT_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;
const PROJECT_PACKAGE_FILE_LIMIT = 10_000;

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

export type MissingProjectMedia = {
  asset: ProjectManifestAsset;
  candidates: string[];
};

export type ProjectMediaRepairResult = {
  manifest: ProjectManifest;
  relinkedAssetIds: string[];
  unresolved: MissingProjectMedia[];
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

type ProjectBackupEntry = {
  path: string;
  handle: FileSystemFileHandle;
};

type ProjectPackageEntry = {
  path: string;
  file: File;
};

async function collectProjectPackageEntries(
  directory: FileSystemDirectoryHandle,
  relativePath = "",
): Promise<ProjectPackageEntry[]> {
  const files: ProjectPackageEntry[] = [];
  for await (const entry of directory.values()) {
    const path = normalizeProjectRelativePath(relativePath ? `${relativePath}/${entry.name}` : entry.name);
    if (entry.kind === "directory") {
      files.push(...await collectProjectPackageEntries(entry as FileSystemDirectoryHandle, path));
    } else {
      files.push({ path, file: await (entry as FileSystemFileHandle).getFile() });
    }
    if (files.length > PROJECT_PACKAGE_FILE_LIMIT) {
      throw new Error(`A project package cannot contain more than ${PROJECT_PACKAGE_FILE_LIMIT.toLocaleString()} files.`);
    }
  }
  return files;
}

function packageFilesFromArchive(data: Uint8Array): Map<string, Uint8Array<ArrayBuffer>> {
  let totalBytes = 0;
  let fileCount = 0;
  const seenPaths = new Set<string>();
  const archive = unzipSync(data, {
    filter: ({ name, originalSize }) => {
      if (name.endsWith("/")) {
        normalizeProjectRelativePath(name.slice(0, -1), "Project package directory");
        return false;
      }
      const path = normalizeProjectRelativePath(name, "Project package path");
      const normalizedPath = path.toLowerCase();
      if (seenPaths.has(normalizedPath)) throw new Error(`Project package contains duplicate path "${path}".`);
      seenPaths.add(normalizedPath);
      fileCount += 1;
      totalBytes += originalSize;
      if (fileCount > PROJECT_PACKAGE_FILE_LIMIT) {
        throw new Error(`A project package cannot contain more than ${PROJECT_PACKAGE_FILE_LIMIT.toLocaleString()} files.`);
      }
      if (!Number.isSafeInteger(originalSize) || originalSize < 0 || totalBytes > PROJECT_PACKAGE_MAX_BYTES) {
        throw new Error("The uncompressed project package exceeds the 512 MB limit.");
      }
      return true;
    },
  });
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [archivePath, contents] of Object.entries(archive)) {
    if (archivePath.endsWith("/")) continue;
    files.set(normalizeProjectRelativePath(archivePath, "Project package path"), contents);
  }
  return files;
}

function validateProjectPackageFiles(files: Map<string, Uint8Array>): ProjectManifest {
  const manifestContents = files.get(PROJECT_MANIFEST_FILE_NAME);
  if (!manifestContents) {
    throw new Error(`The package must contain "${PROJECT_MANIFEST_FILE_NAME}" at its root.`);
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(new TextDecoder().decode(manifestContents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`The project package manifest "${PROJECT_MANIFEST_FILE_NAME}" contains invalid JSON.`, {
        cause: error,
      });
    }
    throw error;
  }
  const manifest = normalizeProjectManifest(manifestValue);
  for (const asset of manifest.assets) {
    const contents = files.get(asset.relativePath);
    if (contents && asset.sizeBytes !== null && contents.byteLength !== asset.sizeBytes) {
      throw new Error(
        `Project media "${asset.name}" has changed size (expected ${asset.sizeBytes} bytes, found ${contents.byteLength}).`,
      );
    }
  }
  const workspaceContents = files.get(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME);
  if (!workspaceContents) {
    throw new Error(`The package is missing "${PROJECT_WORKSPACE_DOCUMENT_FILE_NAME}" and cannot restore project state.`);
  }
  let workspaceValue: unknown;
  try {
    workspaceValue = JSON.parse(new TextDecoder().decode(workspaceContents));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`The project workspace document "${PROJECT_WORKSPACE_DOCUMENT_FILE_NAME}" contains invalid JSON.`, {
        cause: error,
      });
    }
    throw error;
  }
  normalizeProjectWorkspaceDocument(workspaceValue, manifest.id);
  return manifest;
}

async function collectProjectBackupEntries(
  directory: FileSystemDirectoryHandle,
  destination: FileSystemDirectoryHandle,
  relativePath = "",
): Promise<{ directories: string[]; files: ProjectBackupEntry[] }> {
  const directories: string[] = [];
  const files: ProjectBackupEntry[] = [];
  for await (const entry of directory.values()) {
    const path = normalizeProjectRelativePath(relativePath ? `${relativePath}/${entry.name}` : entry.name);
    if (entry.kind === "directory") {
      if (await entry.isSameEntry(destination)) {
        throw new Error("Choose a backup folder outside the project folder.");
      }
      directories.push(path);
      const nested = await collectProjectBackupEntries(
        entry as FileSystemDirectoryHandle,
        destination,
        path,
      );
      directories.push(...nested.directories);
      files.push(...nested.files);
    } else {
      files.push({ path, handle: entry as FileSystemFileHandle });
    }
  }
  return { directories, files };
}

export async function backupProjectFolder(
  source: FileSystemDirectoryHandle,
  expectedProjectId: string,
  destination: FileSystemDirectoryHandle,
  onProgress?: (completedFiles: number, totalFiles: number) => void,
): Promise<{ fileCount: number; totalBytes: number }> {
  const manifest = await readProjectManifest(source);
  if (!manifest) throw new Error(`Project manifest "${PROJECT_MANIFEST_FILE_NAME}" is missing; the project cannot be backed up.`);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its backup could be created.");
  }
  if (await source.isSameEntry(destination)) {
    throw new Error("Choose a different, empty folder for the backup.");
  }
  const destinationEntries = destination.values();
  if (!(await destinationEntries.next()).done) {
    throw new Error(`The backup folder "${destination.name}" is not empty. Choose an empty folder.`);
  }

  const { directories, files } = await collectProjectBackupEntries(source, destination);
  const projectFiles = new Map(files.map((entry) => [entry.path, entry]));
  const assetsByPath = new Map(manifest.assets.map((asset) => [asset.relativePath, asset]));
  for (const asset of manifest.assets) {
    if (!projectFiles.has(asset.relativePath)) {
      throw new Error(`Project media "${asset.name}" is missing at "${asset.relativePath}".`);
    }
    if (asset.proxyPath && !projectFiles.has(asset.proxyPath)) {
      throw new Error(`Project proxy for "${asset.name}" is missing at "${asset.proxyPath}".`);
    }
  }
  const filesToCopy: Array<{ path: string; file: File }> = [];
  let totalBytes = 0;
  for (const entry of files) {
    const file = await entry.handle.getFile();
    const asset = assetsByPath.get(entry.path);
    if (asset && asset.sizeBytes !== null && file.size !== asset.sizeBytes) {
      throw new Error(
        `Project media "${asset.name}" has changed size (expected ${asset.sizeBytes} bytes, found ${file.size}).`,
      );
    }
    filesToCopy.push({ path: entry.path, file });
    totalBytes += file.size;
  }
  let completedFiles = 0;
  try {
    for (const path of directories) {
      let target = destination;
      for (const segment of path.split("/")) {
        target = await target.getDirectoryHandle(segment, { create: true });
      }
    }

    for (const entry of filesToCopy) {
      const destinationFile = await getFileHandleAtPath(destination, entry.path, true);
      const writable = await destinationFile.createWritable();
      await writable.write(entry.file);
      await writable.close();
      completedFiles += 1;
      onProgress?.(completedFiles, files.length);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The backup may be incomplete; its destination may contain a partial copy. ${message}`, {
      cause: error,
    });
  }
  return { fileCount: files.length, totalBytes };
}

export async function exportProjectPackage(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
): Promise<Blob> {
  const manifest = await readProjectManifest(handle);
  if (!manifest) {
    throw new Error(`Project manifest "${PROJECT_MANIFEST_FILE_NAME}" is missing; the project cannot be exported.`);
  }
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its package could be exported.");
  }
  if (!await loadProjectWorkspaceState(handle, expectedProjectId)) {
    throw new Error(`Project workspace "${PROJECT_WORKSPACE_DOCUMENT_FILE_NAME}" is missing; save the project before exporting.`);
  }

  const files = await collectProjectPackageEntries(handle);
  if (files.length > PROJECT_PACKAGE_FILE_LIMIT) {
    throw new Error(`A project package cannot contain more than ${PROJECT_PACKAGE_FILE_LIMIT.toLocaleString()} files.`);
  }
  const filesByPath = new Map(files.map((entry) => [entry.path, entry.file]));
  for (const asset of manifest.assets) {
    const file = filesByPath.get(asset.relativePath);
    if (!file) throw new Error(`Project media "${asset.name}" is missing at "${asset.relativePath}".`);
    if (asset.sizeBytes !== null && file.size !== asset.sizeBytes) {
      throw new Error(
        `Project media "${asset.name}" has changed size (expected ${asset.sizeBytes} bytes, found ${file.size}).`,
      );
    }
    if (asset.proxyPath && !filesByPath.has(asset.proxyPath)) {
      throw new Error(`Project proxy for "${asset.name}" is missing at "${asset.proxyPath}".`);
    }
  }

  let totalBytes = 0;
  const archive: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const { path, file } of files) {
    totalBytes += file.size;
    if (totalBytes > PROJECT_PACKAGE_MAX_BYTES) {
      throw new Error("The uncompressed project package exceeds the 512 MB limit.");
    }
    archive[path] = new Uint8Array(await file.arrayBuffer());
  }
  const zipped = zipSync(archive, { level: 0 });
  if (zipped.byteLength > PROJECT_PACKAGE_MAX_BYTES) {
    throw new Error("The exported project package exceeds the 512 MB limit.");
  }
  return new Blob([zipped], { type: "application/zip" });
}

export async function importProjectPackageIntoFolder(
  packageFile: Blob,
  handle: FileSystemDirectoryHandle,
): Promise<ProjectManifest> {
  if (packageFile.size <= 0 || packageFile.size > PROJECT_PACKAGE_MAX_BYTES) {
    throw new Error("Project package files must be between 1 byte and 512 MB.");
  }
  const files = packageFilesFromArchive(new Uint8Array(await packageFile.arrayBuffer()));
  const manifest = validateProjectPackageFiles(files);
  const existing = await handle.values().next();
  if (!existing.done) throw new Error(`The destination "${handle.name}" is not empty.`);

  for (const [path, contents] of files) {
    const fileHandle = await getFileHandleAtPath(handle, path, true);
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  const result = await readProjectManifest(handle);
  if (!result || result.id !== manifest.id) throw new Error("The imported project manifest could not be verified.");
  await loadProjectWorkspaceState(handle, result.id);
  await loadProjectVideoEditorState(handle, result.id);
  await loadProjectCompositorState(handle, result.id);
  return result;
}

export async function importProjectPackage(packageFile: Blob): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("This browser cannot import project packages. Use Chrome or Edge with site storage enabled.");
  }
  const root = await navigator.storage.getDirectory();
  const packageRoot = await root.getDirectoryHandle("fal-flow-project-packages", { create: true });
  const handle = await packageRoot.getDirectoryHandle(`project-${crypto.randomUUID()}`, { create: true });
  try {
    await importProjectPackageIntoFolder(packageFile, handle);
    return handle;
  } catch (error) {
    try {
      await packageRoot.removeEntry(handle.name, { recursive: true });
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`Project package import failed, and its temporary files could not be removed: ${message}`, {
        cause: error,
      });
    }
    throw error;
  }
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

async function readProjectManifest(
  handle: FileSystemDirectoryHandle,
): Promise<ProjectManifest | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await handle.getFileHandle(PROJECT_MANIFEST_FILE_NAME);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return null;
    throw error;
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
  return normalizeProjectManifest(raw);
}

export async function readOrCreateProjectManifest(
  handle: FileSystemDirectoryHandle,
): Promise<{ manifest: ProjectManifest; created: boolean }> {
  const existing = await readProjectManifest(handle);
  if (existing) return { manifest: existing, created: false };
  const manifest = createManifest(handle.name);
  await writeManifest(handle, manifest);
  return { manifest, created: true };
}

export async function findProjectFolderRoot(
  selectedFolder: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  try {
    await selectedFolder.getFileHandle(PROJECT_MANIFEST_FILE_NAME);
    return selectedFolder;
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }

  const projectFolders: FileSystemDirectoryHandle[] = [];
  let scannedDirectories = 0;
  const findNestedProjects = async (directory: FileSystemDirectoryHandle, depth: number): Promise<void> => {
    if (depth > 10) return;
    scannedDirectories += 1;
    if (scannedDirectories > PROJECT_PACKAGE_FILE_LIMIT) {
      throw new Error("Too many nested folders to safely locate the project. Select its root folder directly.");
    }
    let hasManifest = false;
    const childDirectories: FileSystemDirectoryHandle[] = [];
    for await (const entry of directory.values()) {
      if (entry.kind === "file" && entry.name === PROJECT_MANIFEST_FILE_NAME) hasManifest = true;
      if (entry.kind === "directory") childDirectories.push(entry as FileSystemDirectoryHandle);
    }
    if (hasManifest) projectFolders.push(directory);
    for (const child of childDirectories) await findNestedProjects(child, depth + 1);
  };
  await findNestedProjects(selectedFolder, 0);
  if (projectFolders.length > 1) {
    throw new Error("More than one fal flow project was found inside that folder. Select the specific project folder.");
  }
  return projectFolders[0] ?? selectedFolder;
}

async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function updateProjectAssetPath(
  manifest: ProjectManifest,
  assetId: string,
  relativePath: string,
  fileSize?: number,
): ProjectManifest {
  if (!manifest.assets.some((asset) => asset.id === assetId)) {
    throw new Error(`Project media "${assetId}" is not listed in this project.`);
  }
  return normalizeProjectManifest({
    ...manifest,
    updatedAt: new Date().toISOString(),
    assets: manifest.assets.map((asset) => asset.id === assetId
      ? {
        ...asset,
        relativePath: normalizeProjectRelativePath(relativePath),
        sizeBytes: asset.sizeBytes ?? fileSize ?? null,
      }
      : asset),
  });
}

async function verifyRelinkedFile(asset: ProjectManifestAsset, file: File): Promise<void> {
  if (asset.sizeBytes !== null && file.size !== asset.sizeBytes) {
    throw new Error(`"${file.name}" does not match "${asset.name}" (expected ${asset.sizeBytes} bytes, found ${file.size}).`);
  }
  if (asset.sha256 && await sha256File(file) !== asset.sha256) {
    throw new Error(`"${file.name}" does not match the saved checksum for "${asset.name}".`);
  }
}

async function matchesProjectAssetFile(asset: ProjectManifestAsset, file: File): Promise<boolean> {
  if (asset.sizeBytes !== null && file.size !== asset.sizeBytes) return false;
  return !asset.sha256 || await sha256File(file) === asset.sha256;
}

export async function scanAndRelinkProjectMedia(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
): Promise<ProjectMediaRepairResult> {
  const files = await collectProjectPackageEntries(handle);
  let updatedManifest = manifest;
  const relinkedAssetIds: string[] = [];
  const unresolved: MissingProjectMedia[] = [];

  for (const asset of manifest.assets) {
    const currentFile = files.find((entry) => entry.path === asset.relativePath)?.file;
    if (currentFile && await matchesProjectAssetFile(asset, currentFile)) continue;

    const expectedNames = new Set([
      asset.relativePath.split("/").at(-1)?.toLowerCase(),
      asset.name.toLowerCase(),
    ]);
    const candidates: ProjectPackageEntry[] = [];
    for (const entry of files) {
      const fileName = entry.path.split("/").at(-1)?.toLowerCase();
      if (!expectedNames.has(fileName) || (asset.sizeBytes !== null && entry.file.size !== asset.sizeBytes)) continue;
      if (!await matchesProjectAssetFile(asset, entry.file)) continue;
      candidates.push(entry);
    }

    if (candidates.length === 1 && asset.sizeBytes !== null) {
      updatedManifest = updateProjectAssetPath(updatedManifest, asset.id, candidates[0].path);
      relinkedAssetIds.push(asset.id);
    } else {
      unresolved.push({ asset, candidates: candidates.map((candidate) => candidate.path) });
    }
  }

  if (relinkedAssetIds.length) updatedManifest = await saveProjectManifest(handle, updatedManifest);
  return { manifest: updatedManifest, relinkedAssetIds, unresolved };
}

export async function relinkProjectMediaAtPath(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
  assetId: string,
  relativePath: string,
): Promise<ProjectManifest> {
  const asset = manifest.assets.find((entry) => entry.id === assetId);
  if (!asset) throw new Error(`Project media "${assetId}" is not listed in this project.`);
  const safePath = normalizeProjectRelativePath(relativePath);
  const file = await (await getFileHandleAtPath(handle, safePath, false)).getFile();
  await verifyRelinkedFile(asset, file);
  return saveProjectManifest(handle, updateProjectAssetPath(manifest, assetId, safePath, file.size));
}

export async function relinkProjectMediaFromFile(
  handle: FileSystemDirectoryHandle,
  manifest: ProjectManifest,
  assetId: string,
  file: File,
): Promise<ProjectManifest> {
  const asset = manifest.assets.find((entry) => entry.id === assetId);
  if (!asset) throw new Error(`Project media "${assetId}" is not listed in this project.`);
  if (file.size <= 0) throw new Error(`"${file.name}" is empty and cannot be relinked.`);
  await verifyRelinkedFile(asset, file);
  const relativePath = `Media/Originals/${crypto.randomUUID()}-${safeMediaFileName(file.name)}`;
  const fileHandle = await getFileHandleAtPath(handle, relativePath, true);
  const writable = await fileHandle.createWritable();
  await writable.write(file);
  await writable.close();
  return saveProjectManifest(handle, updateProjectAssetPath(manifest, assetId, relativePath, file.size));
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

export async function loadProjectCompositorState(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
): Promise<ProjectCompositorState | null> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its compositor document could be loaded.");
  }
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await handle.getFileHandle(PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return null;
    throw error;
  }
  const text = await (await fileHandle.getFile()).text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `The project compositor document "${PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME}" contains invalid JSON.`,
        { cause: error },
      );
    }
    throw error;
  }
  return normalizeProjectCompositorDocument(raw, manifest).state;
}

export async function saveProjectCompositorState(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
  state: ProjectCompositorState,
): Promise<void> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its compositor document could be saved.");
  }
  const document = createProjectCompositorDocument(state, manifest);
  const fileHandle = await handle.getFileHandle(PROJECT_COMPOSITOR_DOCUMENT_FILE_NAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(document, null, 2)}\n`);
  await writable.close();
}

export async function loadProjectWorkspaceState(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
): Promise<ProjectWorkspaceState | null> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its workflow document could be loaded.");
  }
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await handle.getFileHandle(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return null;
    throw error;
  }
  const text = await (await fileHandle.getFile()).text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `The project workspace document "${PROJECT_WORKSPACE_DOCUMENT_FILE_NAME}" contains invalid JSON.`,
        { cause: error },
      );
    }
    throw error;
  }
  return normalizeProjectWorkspaceDocument(raw, expectedProjectId).state;
}

export async function saveProjectWorkspaceState(
  handle: FileSystemDirectoryHandle,
  expectedProjectId: string,
  state: ProjectWorkspaceState,
): Promise<void> {
  const { manifest } = await readOrCreateProjectManifest(handle);
  if (manifest.id !== expectedProjectId) {
    throw new Error("The project folder changed before its workflow document could be saved.");
  }
  const document = createProjectWorkspaceDocument(state, manifest.id);
  const fileHandle = await handle.getFileHandle(PROJECT_WORKSPACE_DOCUMENT_FILE_NAME, { create: true });
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
  multiple = true,
): Promise<File[] | null> {
  if (!window.showOpenFilePicker) return null;
  const handles = await window.showOpenFilePicker({
    multiple,
    startIn: projectFolder,
  });
  return Promise.all(handles.map((handle) => handle.getFile()));
}
