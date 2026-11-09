"use client";

type AddEditorUpload = (file: File) => void;
type FocusEditorUploads = () => void;

let addEditorUpload: AddEditorUpload | null = null;
let focusEditorUploads: FocusEditorUploads | null = null;
let version = 0;
const sentSources = new Set<string>();
const inFlightSources = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify() {
  version++;
  listeners.forEach((listener) => listener());
}

export function registerEditorUploadBridge(
  addUpload: AddEditorUpload,
  focusUploads: FocusEditorUploads,
) {
  addEditorUpload = addUpload;
  focusEditorUploads = focusUploads;
  return () => {
    if (addEditorUpload === addUpload) addEditorUpload = null;
    if (focusEditorUploads === focusUploads) focusEditorUploads = null;
  };
}

export function addFileToEditorUploads(sourceUrl: string, file: File, resend = false): Promise<boolean> {
  if (!resend && sentSources.has(sourceUrl)) return Promise.resolve(false);
  const pending = inFlightSources.get(sourceUrl);
  if (pending) return pending.then(() => false);
  if (!addEditorUpload) return Promise.reject(new Error("The video editor is not ready yet."));

  const request = Promise.resolve().then(() => addEditorUpload?.(file)).then(() => {
    sentSources.add(sourceUrl);
    notify();
  });
  inFlightSources.set(sourceUrl, request);
  return request.then(() => true).finally(() => {
    if (inFlightSources.get(sourceUrl) === request) inFlightSources.delete(sourceUrl);
  });
}

export function openEditorUploads() {
  focusEditorUploads?.();
}

export function isEditorUploadSourceSent(sourceUrl: string) {
  return sentSources.has(sourceUrl);
}

export function subscribeToEditorUploadChanges(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorUploadVersion() {
  return version;
}
