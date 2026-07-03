// TASK-30 — resolve "the recording" without assuming recording.webm.
//
// Recorded sessions are always WebM (ADR-003); an IMPORTED session may be MP4
// (S13). Everything that reads a session's video — the analyze flow, the session
// view, the sidebar's incomplete check — used to hardcode `recording.webm`. It
// now goes through here so an mp4 import is a first-class session, not an
// "incomplete" one with an unplayable, unanalyzable file.
//
// The extension is the container contract end-to-end: uploadVideo validates it,
// ffmpeg infers the container from it, and Gemini needs the matching mimeType.
// So we PRESERVE the real extension on disk (recording.webm OR recording.mp4)
// rather than normalizing everything to .webm.

/** The containers Vellum supports end-to-end. WebM first: it's the default. */
export const RECORDING_EXTENSIONS = [".webm", ".mp4"] as const;
export type RecordingExt = (typeof RECORDING_EXTENSIONS)[number];

/** True when `ext` (leading dot, any case handled by the caller) is supported. */
export function isSupportedRecordingExt(ext: string): ext is RecordingExt {
  return (RECORDING_EXTENSIONS as readonly string[]).includes(ext);
}

/** The Gemini/`<source>` mimeType for a supported container. */
export function mimeForRecordingExt(ext: RecordingExt): "video/webm" | "video/mp4" {
  return ext === ".mp4" ? "video/mp4" : "video/webm";
}

export interface RecordingMatch {
  handle: FileSystemFileHandle;
  /** e.g. "recording.mp4" */
  name: string;
  ext: RecordingExt;
}

/**
 * Find the session's recording file, probing the supported names in order (so
 * WebM wins if — impossibly — both exist). Returns null when the session has no
 * recording at all (an incomplete session, ADR-008), which callers treat as a
 * meaningful state, not an error.
 */
export async function findRecording(
  dir: FileSystemDirectoryHandle,
): Promise<RecordingMatch | null> {
  for (const ext of RECORDING_EXTENSIONS) {
    const name = `recording${ext}`;
    const handle = await getFileHandleOrNull(dir, name);
    if (handle) return { handle, name, ext };
  }
  return null;
}

/** getFileHandle, but a missing file → null instead of throwing. */
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
