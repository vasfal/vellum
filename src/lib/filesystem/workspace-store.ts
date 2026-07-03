// TASK-15 — persist the workspace directory handle in IndexedDB.
//
// A FileSystemDirectoryHandle is structured-cloneable, so we store the handle
// object itself. On the next visit we read it back and re-check permission
// (see lib/filesystem/workspace.ts) instead of re-opening the picker — the user
// chose a folder once and shouldn't have to choose it again every reload.
//
// Raw IndexedDB, no `idb` dependency: this is a single object store with one
// key. Pulling in a library for that is the kind of framework-over-shipping
// weight this project guards against. The verbose request/transaction dance is
// the cost of staying dependency-free here.

const DB_NAME = "vellum";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const WORKSPACE_KEY = "workspace";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Run one request inside a transaction and resolve with its result. Opens a
// fresh connection per call and closes it after — there's no hot path here
// (a handful of calls across the whole session), so simplicity wins.
async function runRequest<T>(
  mode: IDBTransactionMode,
  makeRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
      const request = makeRequest(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** The persisted handle, or null if nothing has been saved yet (first run). */
export function loadWorkspaceHandle(): Promise<FileSystemDirectoryHandle | null> {
  return runRequest<FileSystemDirectoryHandle | undefined>("readonly", (store) =>
    store.get(WORKSPACE_KEY),
  ).then((value) => value ?? null);
}

export async function saveWorkspaceHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await runRequest("readwrite", (store) => store.put(handle, WORKSPACE_KEY));
}

export async function clearWorkspaceHandle(): Promise<void> {
  await runRequest("readwrite", (store) => store.delete(WORKSPACE_KEY));
}
