// TASK-30 — import a pre-recorded video into the workspace as a new session.
//
// The non-record entry point (S13). Two steps, kept separate so the UI can run
// the file picker inside its click gesture, then own the copy + analyze with its
// own progress/cancel:
//
//   pickVideoToImport()          — show the native picker, restricted to
//                                  webm/mp4, and hand back the chosen File.
//   importVideoToWorkspace(...)  — copy that File into a fresh <timestamp>/
//                                  session as recording.<ext> (real extension
//                                  preserved — ADR-003 / recording-file.ts).
//
// After the copy the caller runs the SAME analyze flow a recording uses
// (runAnalyze), so an imported session reaches the identical end state: a
// tasks.json-marked, viewable session (ADR-008).

import { createSessionDir } from "./session-dir";
import {
  isSupportedRecordingExt,
  RECORDING_EXTENSIONS,
  type RecordingExt,
} from "./recording-file";

/**
 * A pick fails loudly only for a genuinely unsupported file. `unsupported`
 * carries a user-facing message; the caller shows it and stops (no crash — AC#3).
 * User cancellation is NOT an error — pickVideoToImport resolves to null.
 */
export class ImportError extends Error {
  constructor(
    readonly kind: "unsupported" | "copy",
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportPick {
  file: File;
  /** The normalized (lowercased, leading-dot) container extension. */
  ext: RecordingExt;
}

/**
 * Show the file picker restricted to webm/mp4 and return the chosen file plus
 * its container extension. Resolves to null when the user cancels the dialog.
 * Throws ImportError("unsupported") if the returned file isn't a webm/mp4 — the
 * picker's filter is only a hint, so we re-check the extension here (AC#3).
 */
export async function pickVideoToImport(): Promise<ImportPick | null> {
  let handle: FileSystemFileHandle;
  try {
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      // Hide the "All files" escape hatch so the picker itself steers toward
      // webm/mp4; we still validate below for the paths that slip through.
      excludeAcceptAllOption: true,
      types: [
        {
          description: "Video (WebM or MP4)",
          accept: { "video/webm": [".webm"], "video/mp4": [".mp4"] },
        },
      ],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }

  const file = await handle.getFile();
  const ext = extensionOf(file.name);
  if (!isSupportedRecordingExt(ext)) {
    throw new ImportError(
      "unsupported",
      `Vellum can import ${RECORDING_EXTENSIONS.join(" and ")} videos. “${file.name}” isn’t one of those — convert it first, then import.`,
    );
  }

  return { file, ext };
}

export interface ImportedSession {
  sessionDir: FileSystemDirectoryHandle;
  /** The new session folder name (a timestamp until analysis renames it). */
  name: string;
}

/**
 * Copy the picked file into a new <timestamp>/recording.<ext> session under the
 * workspace and return the created folder + name. Streams the copy through
 * createWritable() so a large import isn't held in one buffer. The folder has no
 * tasks.json marker yet, so it is NOT a listed session (ADR-008) until the
 * caller's analyze run writes one — a copy without a follow-up analyze leaves no
 * half-session in the sidebar.
 */
export async function importVideoToWorkspace(
  workspace: FileSystemDirectoryHandle,
  pick: ImportPick,
  now: Date,
): Promise<ImportedSession> {
  const { dir, name } = await createSessionDir(workspace, now);

  try {
    const handle = await dir.getFileHandle(`recording${pick.ext}`, { create: true });
    const writable = await handle.createWritable();
    // write(Blob) streams the file's bytes to the swap file; close() commits it.
    await writable.write(pick.file);
    await writable.close();
  } catch {
    throw new ImportError(
      "copy",
      "Couldn't copy the video into the workspace. Check the folder is still available, then try again.",
    );
  }

  return { sessionDir: dir, name };
}

/** ".mp4" (lowercased) from a filename, or "" when it has no extension. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}
