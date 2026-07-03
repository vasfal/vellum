// TASK-12 — stream a recording to disk via the File System Access API.
//
// Consumes the per-chunk `onChunk` seam from the MediaRecorder wrapper
// (lib/recording/recorder.ts, TASK-11): every timeslice chunk is written to a
// `createWritable()` stream the moment it arrives, so the full recording is
// never held in one buffer. That gives OOM-safety on long recordings and means
// a tab crash loses at most one chunk (ARCHITECTURE §Error handling: "recording
// tab crash").
//
// Layout (ARCHITECTURE §Local storage layout): the recording lands at
// <workspace>/<timestamp>/recording.webm, where <timestamp> is a minute-grained
// session folder (e.g. 2026-06-30-14-30), with a -2/-3 suffix on collision.
//
// SCOPE: this module is only "pick a folder + stream the file". Workspace
// markers (.vellum-workspace.json) and IndexedDB handle persistence are TASK-15
// (Phase 3) and intentionally not here.
//
// CRASH-RECOVERY NOTE (the reason AC#3 is worded the way it is): createWritable()
// writes to a temporary swap file (Chromium names it `recording.webm.crswap`)
// and only renames it onto `recording.webm` on close(). So a crash mid-recording
// leaves the partial bytes in that .crswap sibling, not in recording.webm — the
// data survives and the WebM plays back truncated, but recovery means renaming
// the swap file. There is no in-place write mode in the spec. Surfacing those
// orphaned swap files on next open is recovery-on-open work, tracked separately.

import { createSessionDir } from "./session-dir";

const RECORDING_FILENAME = "recording.webm";

/**
 * Show the native directory picker, requesting read+write upfront so we never
 * have to re-prompt at save time. Throws `AbortError` if the user cancels —
 * callers treat that as "no-op", not a failure (fail loud only on real errors).
 */
export function pickWorkspaceDirectory(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ mode: "readwrite" });
}

export interface RecordingSink {
  /** Session folder name — the <timestamp> dir actually created (post-collision). */
  readonly sessionDirName: string;
  /** Relative path written, e.g. "2026-06-30-14-30/recording.webm" — for logs/handoff. */
  readonly relativePath: string;
  /**
   * Enqueue one chunk for writing. Resolves once this chunk and every prior one
   * have hit the swap file. Wire this straight to the recorder's `onChunk`.
   */
  write: (chunk: Blob) => Promise<void>;
  /** Drain the write queue, then commit the swap file to recording.webm. */
  close: () => Promise<void>;
}

/**
 * Open a streaming sink for a fresh recording inside `workspace`. Creates the
 * timestamp session folder and the recording.webm writable before returning, so
 * the first chunk can be written with zero further setup latency.
 *
 * `now` is injected (not read from the clock here) so the folder name is
 * deterministic and testable.
 */
export async function createRecordingSink(
  workspace: FileSystemDirectoryHandle,
  now: Date,
): Promise<RecordingSink> {
  const { dir, name } = await createSessionDir(workspace, now);
  const fileHandle = await dir.getFileHandle(RECORDING_FILENAME, { create: true });
  // Default options: swap file starts empty (we're writing a brand-new file).
  const writable = await fileHandle.createWritable();

  // `dataavailable` fires ~once/second and synchronously, but writable.write()
  // is async and concurrent writes to one stream corrupt it. Serialize through
  // a single promise tail: each write waits for the previous one to land.
  let tail: Promise<void> = Promise.resolve();

  return {
    sessionDirName: name,
    relativePath: `${name}/${RECORDING_FILENAME}`,
    write: (chunk) => {
      tail = tail.then(() => writable.write(chunk));
      return tail;
    },
    close: async () => {
      await tail; // let every queued chunk finish writing
      await writable.close(); // atomically commit swap file → recording.webm
    },
  };
}
