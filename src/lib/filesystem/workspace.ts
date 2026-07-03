// TASK-15 — workspace adoption: the permission and on-disk-marker logic that
// sits between the picked/restored directory handle and a "ready" workspace.
//
// Three concerns live here, kept out of React so the provider only orchestrates
// state transitions:
//   1. queryWorkspacePermission / requestWorkspacePermission — the soft re-grant
//      flow after a browser restart (ARCHITECTURE §Error handling — folder
//      permission). requestPermission must be called inside a user gesture.
//   2. isWorkspaceReachable — detect a moved/renamed/deleted folder so we can
//      show "workspace unavailable" instead of crashing (ARCHITECTURE §Error
//      handling — workspace deleted/moved).
//   3. ensureWorkspaceMarker — write .vellum-workspace.json on first adoption
//      (ADR-008: never assume structure, mark it).

/** ADR-008 workspace marker, written to the workspace root on first adoption. */
export const WORKSPACE_MARKER_FILENAME = ".vellum-workspace.json";

const WORKSPACE_SCHEMA_VERSION = 1;

interface WorkspaceMarker {
  schemaVersion: number;
  createdAt: string; // ISO-8601
}

const READWRITE: FileSystemHandlePermissionDescriptor = { mode: "readwrite" };

export function queryWorkspacePermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return handle.queryPermission(READWRITE);
}

export function requestWorkspacePermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  return handle.requestPermission(READWRITE);
}

/**
 * Is the folder behind this handle still there? A valid handle — even for an
 * empty folder — lets us read its entries; a handle whose folder was moved or
 * deleted throws NotFoundError on any access. We iterate keys() rather than
 * probing for the marker file: getFileHandle(marker) also throws NotFoundError
 * when the folder exists but the marker is simply missing, which would
 * misreport a real, markerless folder as unavailable.
 */
export async function isWorkspaceReachable(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    for await (const _name of handle.keys()) {
      break; // one successful read is enough; we don't care what's inside
    }
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return false;
    }
    throw err; // anything else (e.g. a permission fault) is a real failure
  }
}

/**
 * Write .vellum-workspace.json to the workspace root, but only if it isn't
 * already there. Re-picking an existing Vellum workspace keeps its original
 * marker (and createdAt) untouched, so adoption is idempotent. Assumes the
 * handle is reachable and readwrite-granted — callers gate on that first.
 */
export async function ensureWorkspaceMarker(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    await handle.getFileHandle(WORKSPACE_MARKER_FILENAME); // present → leave it
    return;
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== "NotFoundError") {
      throw err;
    }
    // NotFoundError → no marker yet; fall through and write one.
  }

  const marker: WorkspaceMarker = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
  };
  const fileHandle = await handle.getFileHandle(WORKSPACE_MARKER_FILENAME, {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(`${JSON.stringify(marker, null, 2)}\n`);
  await writable.close();
}
