const WAN_DOCUMENT_DATABASE = "fal-flow-wan-documents";
const WAN_DOCUMENT_VERSION = 1;
const WAN_DOCUMENT_STORE = "documents";

type StoredWanDocument = {
  id: string;
  name: string;
  type: string;
  blob: Blob;
};

let wanDocumentDatabase: Promise<IDBDatabase> | null = null;

function openWanDocumentDatabase() {
  if (wanDocumentDatabase) return wanDocumentDatabase;
  wanDocumentDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support persistent Wan document storage."));
      return;
    }
    const request = window.indexedDB.open(WAN_DOCUMENT_DATABASE, WAN_DOCUMENT_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(WAN_DOCUMENT_STORE)) {
        request.result.createObjectStore(WAN_DOCUMENT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open Wan document storage."));
    request.onblocked = () => reject(new Error("Wan document storage is blocked by another tab."));
  }).catch((error: unknown) => {
    wanDocumentDatabase = null;
    throw error;
  });
  return wanDocumentDatabase;
}

function wanRequestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Wan document storage request failed."));
  });
}

function wanTransactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Wan document storage transaction was aborted."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Wan document storage transaction failed."));
  });
}

export async function saveWanDocument(id: string, file: File) {
  const database = await openWanDocumentDatabase();
  const transaction = database.transaction(WAN_DOCUMENT_STORE, "readwrite");
  const done = wanTransactionDone(transaction);
  transaction.objectStore(WAN_DOCUMENT_STORE).put({
    id,
    name: file.name,
    type: file.type,
    blob: file,
  } satisfies StoredWanDocument);
  await done;
}

export async function loadWanDocument(id: string) {
  const database = await openWanDocumentDatabase();
  const transaction = database.transaction(WAN_DOCUMENT_STORE, "readonly");
  const done = wanTransactionDone(transaction);
  const [stored] = await Promise.all([
    wanRequestResult(transaction.objectStore(WAN_DOCUMENT_STORE).get(id) as IDBRequest<StoredWanDocument | undefined>),
    done,
  ]);
  if (!stored) throw new Error("The saved Wan document is missing from this browser.");
  return new File([stored.blob], stored.name, { type: stored.type });
}

export async function deleteWanDocument(id: string) {
  const database = await openWanDocumentDatabase();
  const transaction = database.transaction(WAN_DOCUMENT_STORE, "readwrite");
  const done = wanTransactionDone(transaction);
  transaction.objectStore(WAN_DOCUMENT_STORE).delete(id);
  await done;
}
