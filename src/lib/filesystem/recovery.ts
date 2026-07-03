// TASK-24 — recover orphaned recording.webm.crswap files on workspace open.
//
// The File System Access API's createWritable() streams to a temporary swap
// file (Chromium names it recording.webm.crswap) and only renames it onto
// recording.webm on close() (TASK-12). A hard renderer crash mid-recording
// therefore leaves the partial bytes in the .crswap sibling while
// recording.webm stays 0-byte/absent — the WebM survives and plays back
// truncated, but recovery means renaming the swap file. A *graceful* tab close
// aborts the stream and discards the swap, so only a true crash leaves one.
//
// This is a SEPARATE signal from the TASK-14 session scan (sessions.ts). A
// crashed-mid-recording folder was never analyzed, so it has NO tasks.json
// marker — scanSessions skips it entirely. We scan the same first level of the
// workspace independently, looking for the .crswap orphan instead of the marker
// (ADR-008: never assume structure, key off the file that actually signals the
// state).

const RECORDING_FILE = "recording.webm";
const SWAP_FILE = "recording.webm.crswap";

export interface RecoverableSession {
  /** Folder name, shown as-is (a timestamp — the crash happened before Gemini could rename it). */
  name: string;
  /** Bytes sitting in the .crswap partial — surfaced so the user sees there's real data to recover. */
  swapBytes: number;
}

/**
 * Scan the workspace's first level for folders with an orphaned .crswap:
 * recording.webm.crswap present AND recording.webm missing or 0-byte. Returns
 * [] when nothing needs recovery. A folder that disappears or turns unreadable
 * mid-scan is simply skipped — a half-deleted folder must not crash the scan.
 *
 * Newest first (folder names are minute-grained timestamps, so a lexical
 * descending sort is chronological — matches the sidebar's recency ordering).
 */
export async function scanRecoverables(
  workspace: FileSystemDirectoryHandle,
): Promise<RecoverableSession[]> {
  const rows: RecoverableSession[] = [];

  for await (const entry of workspace.values()) {
    if (entry.kind !== "directory") continue; // files in the root are never sessions
    const row = await readRecoverable(entry);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return rows;
}

/**
 * Inspect one subfolder. Returns a RecoverableSession only if it holds an
 * orphaned swap; null for healthy sessions, graceful-close folders, and
 * anything that became unreadable mid-scan.
 */
async function readRecoverable(
  dir: FileSystemDirectoryHandle,
): Promise<RecoverableSession | null> {
  const swap = await getFileHandleOrNull(dir, SWAP_FILE);
  if (!swap) return null; // no swap → nothing to recover (healthy or graceful close)

  let swapBytes: number;
  try {
    swapBytes = (await swap.getFile()).size;
  } catch {
    return null; // swap vanished between handle and read — treat the folder as gone
  }
  if (swapBytes === 0) return null; // empty swap holds no recoverable bytes

  // A committed recording.webm (non-zero) means close() already ran and this
  // swap is stale, not an orphan — don't offer to overwrite real data. Only a
  // missing or 0-byte recording.webm is the true crash signature.
  const recordingBytes = await getFileSizeOrNull(dir, RECORDING_FILE);
  if (recordingBytes !== null && recordingBytes > 0) return null;

  return { name: dir.name, swapBytes };
}

/**
 * Recover one folder: rename recording.webm.crswap onto recording.webm. We
 * remove any existing (0-byte) recording.webm first so move() lands on a free
 * name — move()'s overwrite behaviour is unspecified across the FS drafts, so
 * we don't lean on it. Idempotent-ish: if the swap is already gone (recovered
 * in a prior click), NotFoundError surfaces to the caller to report.
 */
export async function recoverSession(
  workspace: FileSystemDirectoryHandle,
  sessionName: string,
): Promise<void> {
  const dir = await workspace.getDirectoryHandle(sessionName);
  const swap = await dir.getFileHandle(SWAP_FILE);

  // Drop the 0-byte placeholder if it's there, so the rename target is free.
  try {
    await dir.removeEntry(RECORDING_FILE);
  } catch (err) {
    if (!(err instanceof DOMException) || err.name !== "NotFoundError") throw err;
    // NotFoundError → no placeholder to remove; the target name is already free.
  }

  await swap.move(RECORDING_FILE);
}

/** Size of a file in bytes, or null if it doesn't exist. Other errors propagate. */
async function getFileSizeOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<number | null> {
  const handle = await getFileHandleOrNull(dir, name);
  if (!handle) return null;
  return (await handle.getFile()).size;
}

/**
 * getFileHandle, but NotFoundError → null instead of throwing. A missing file
 * is an expected, meaningful state here, not an error. Any other failure (e.g.
 * permission) still throws. (Mirrors the helper in sessions.ts by design — two
 * independent scans, deliberately not coupled through a shared module.)
 */
async function getFileHandleOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}
