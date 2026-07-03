// TASK-14 — scan the workspace folder for Vellum sessions.
//
// This is the read side of ADR-008 ("identity via markers, never assume
// structure"). We scan ONLY the first level of the workspace root and treat a
// subfolder as a session only if it carries the `tasks.json` marker that
// writeReport (TASK-7) drops. Everything else in the workspace — foreign files,
// unmarked folders, the `.vellum-workspace.json` marker itself — is ignored.
//
// We deliberately do NOT parse tasks.json here. Presence of the marker is the
// whole signal (ADR-008); a corrupt or unrecognized payload must not make a
// session vanish from the list. Parsing is the session view's job (Phase 4).
//
// TASK-43 — the name sidecar (a 0-byte `<display-name>.txt` dropped inside a
// session folder for Finder findability) is NOT a marker: it's a plain file, and
// this scan only ever treats root-level DIRECTORIES carrying tasks.json/recording
// as sessions. So the sidecar is ignored here by construction — it never changes
// the lists / incomplete / unanalyzed logic and is never rendered as a session.

import { findRecording } from "./recording-file";
import { readOverrideName } from "./session-name";
import { sessionDisplayName } from "@/lib/report/render-report";

/** The session marker (ADR-008) and the two deliverables a complete session has. */
export const SESSION_MARKER = "tasks.json";
const REPORT_FILE = "report.md";

export interface SessionRow {
  /**
   * The folder name — the stable session identity and URL slug. It is a
   * timestamp; it is NEVER renamed (the File System Access API can't rename a
   * directory), so this stays constant even after a Gemini suggestion or a manual
   * rename. Use `displayName` for what the user sees.
   */
  name: string;
  /**
   * The human-facing name (TASK-22): a manual override (name.txt) > Gemini's
   * suggested_name (tasks.json) > the folder name. Read best-effort — a corrupt
   * or unreadable tasks.json / name.txt falls back to the folder name, so a
   * session still lists (ADR-008 spirit) even when its name can't be resolved.
   */
  displayName: string;
  /**
   * Recency key: the marker file's last-modified time (ms). Reflects when the
   * session was last analyzed / re-rendered, which is the freshness we sort by.
   * Survives a folder rename, unlike a timestamp parsed from the folder name.
   */
  lastModified: number;
  /**
   * tasks.json is present but recording.webm or report.md is missing (ADR-008):
   * shown with an `incomplete` badge rather than hidden or crashing.
   */
  incomplete: boolean;
  /**
   * No tasks.json yet, but a real recording is on disk — a just-recorded (TASK-25)
   * or just-imported session that hasn't been analyzed. Surfaced (with an
   * `unanalyzed` badge) so the recording is reachable from the sidebar and never
   * orphaned by navigating away (never-lose-data). Mutually exclusive with an
   * analyzed row: an `unanalyzed` row has no marker, so `incomplete` is false.
   */
  unanalyzed: boolean;
}

/**
 * Does this session match a search query? Pure and case-insensitive so it can be
 * unit-tested offline (TASK-19). An empty/whitespace query matches everything
 * (the filter is "off"). Otherwise a plain substring match over the display NAME
 * only — searching hidden task content surfaced timestamp-named sessions with no
 * visible reason, which read as false positives; name-only is the predictable
 * behavior (content search deferred with a match reason / snippet if ever wanted).
 */
export function matchesQuery(row: SessionRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.displayName.toLowerCase().includes(q);
}

/**
 * List the workspace's sessions, most-recent first. Returns [] for an empty or
 * marker-only workspace. A directory entry that disappears mid-scan (or whose
 * marker can't be read) is simply skipped — a partially-deleted folder must not
 * crash the whole list.
 */
export async function scanSessions(
  workspace: FileSystemDirectoryHandle,
): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];

  for await (const entry of workspace.values()) {
    if (entry.kind !== "directory") continue; // files in the root are not sessions
    const row = await readSession(entry);
    if (row) rows.push(row);
  }

  // Most-recent first. lastModified is a number, so a plain descending sort.
  rows.sort((a, b) => b.lastModified - a.lastModified);
  return rows;
}

/**
 * Turn one subfolder into a SessionRow, or null if it isn't a Vellum session
 * (no marker and no recording) or became unreadable mid-scan.
 */
async function readSession(
  dir: FileSystemDirectoryHandle,
): Promise<SessionRow | null> {
  const markerHandle = await getFileHandleOrNull(dir, SESSION_MARKER);
  if (!markerHandle) return readUnanalyzed(dir); // no marker → maybe a raw recording

  // Read the marker's mtime for recency (and, best-effort, its suggested_name).
  // If the file vanished between the handle and the read, treat the folder as
  // gone and skip it.
  let markerFile: File;
  try {
    markerFile = await markerHandle.getFile();
  } catch {
    return null;
  }
  const lastModified = markerFile.lastModified;

  // Recording may be webm (recorded) or mp4 (imported — S13); resolve either so
  // an imported session isn't wrongly flagged incomplete in the sidebar.
  const [recording, report, suggested, override] = await Promise.all([
    findRecording(dir),
    getFileHandleOrNull(dir, REPORT_FILE),
    readSuggestedName(markerFile),
    readOverrideName(dir),
  ]);

  return {
    name: dir.name,
    displayName: sessionDisplayName({ override, suggested, folderName: dir.name }),
    lastModified,
    incomplete: !recording || !report,
    unanalyzed: false,
  };
}

/**
 * Pull `suggested_name` out of the marker file, best-effort (TASK-22). We do NOT
 * run the full schema here — ADR-008 keeps this scan tolerant of a corrupt or
 * partial tasks.json — so we read the one field only if it's plausibly there and
 * fall back to null (→ folder name for display) on any problem.
 */
async function readSuggestedName(markerFile: File): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await markerFile.text());
    if (parsed && typeof parsed === "object" && "suggested_name" in parsed) {
      const value = (parsed as { suggested_name?: unknown }).suggested_name;
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A folder with no `tasks.json` but a real recording is a recorded/imported
 * session awaiting analysis (TASK-25/30) — surface it so it's reachable, never
 * orphaned. A folder with no recording is not ours (ADR-008) → skip. A 0-byte
 * `recording.webm` is a crash stub owned by the recovery scan (TASK-24), not a
 * session here → skip. Recency is the recording's own mtime.
 */
async function readUnanalyzed(
  dir: FileSystemDirectoryHandle,
): Promise<SessionRow | null> {
  const recording = await findRecording(dir);
  if (!recording) return null;

  let file: File;
  try {
    file = await recording.handle.getFile();
  } catch {
    return null; // vanished mid-scan
  }
  if (file.size === 0) return null; // crash stub → TASK-24, not a session row

  // No tasks.json yet → no suggested_name; a manual override is still possible.
  const override = await readOverrideName(dir);
  return {
    name: dir.name,
    displayName: sessionDisplayName({ override, suggested: null, folderName: dir.name }),
    lastModified: file.lastModified,
    incomplete: false,
    unanalyzed: true,
  };
}

/**
 * getFileHandle, but NotFoundError → null instead of throwing. A missing file
 * is an expected, meaningful state here (no marker, or an incomplete session),
 * not an error. Any other failure (e.g. permission) still throws.
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
