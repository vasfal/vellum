// TASK-17 — read ONE session's data for the session view.
//
// The sidebar list (TASK-14) only needs to know a folder is a session (the
// `tasks.json` marker exists — ADR-008). The session view needs the actual
// payload: the parsed tasks and the recording file. This is where we finally
// parse `tasks.json` through the authoritative schema (TASK-4) and hand back a
// File for the <video> player.
//
// Everything here is defensive per ADR-008 + the "fail loud, never crash on bad
// data" error philosophy: a missing folder, an unparseable `tasks.json`, or a
// missing `recording.webm` each resolve to a distinct, non-throwing state so the
// view can render a partial session instead of a blank crash.

import {
  parseStoredResult,
  upgrade,
  type StoredAnalysisResult,
} from "@/lib/gemini/stored";
import {
  screenshotsArchiveName,
  sessionDisplayName,
  SCREENSHOTS_DIR,
} from "@/lib/report/render-report";
import { deriveScreenshotNames, loadScreenshots } from "./screenshots";
import { findRecording } from "./recording-file";
import { readOverrideName, writeNameSidecar } from "./session-name";

const SESSION_MARKER = "tasks.json";
const REPORT_FILE = "report.md";

/**
 * The loaded shape of one session.
 *
 *   not-found  — the folder is gone, or it holds neither a `tasks.json` marker
 *                nor a recording. To the view this session simply doesn't exist.
 *   unanalyzed — the folder holds a recording but no `tasks.json` yet: a just-
 *                recorded (TASK-25) or imported (TASK-30) session awaiting its
 *                first analysis. Per ADR-008 it isn't a listed "session" until
 *                analysis writes the marker, but the view still opens it to show
 *                the player + an Analyze CTA rather than a dead "not found".
 *   error      — an unexpected failure (e.g. permission revoked mid-session).
 *   ok        — the session folder is readable. `analysis` is the parsed tasks,
 *               or null when `tasks.json` is present but malformed (bad JSON or
 *               fails the schema) — the view shows the player + an inline notice
 *               instead of vanishing. `recording` is null for an incomplete
 *               session whose `recording.webm` is missing (ADR-008).
 */
export type SessionData =
  | { status: "not-found" }
  | { status: "error" }
  | { status: "unanalyzed"; recording: File; displayName: string }
  | {
      status: "ok";
      /**
       * The human-facing name (TASK-22): manual override (name.txt) > the parsed
       * suggested_name > the folder name. Resolved here so the header, sidebar,
       * and report all show the same effective name.
       */
      displayName: string;
      /**
       * The parsed analysis as a StoredAnalysisResult (ADR-025). A stored
       * tasks.json is used as-is; a LEGACY (pre-ADR-025) one is normalized in
       * memory via `upgrade` so the view uniformly gets stable ids + resolved
       * screenshot filenames. The upgrade is NOT persisted here (lazy-persist-on-
       * edit is TASK-56); null when tasks.json is present but malformed.
       */
      analysis: StoredAnalysisResult | null;
      /** tasks.json exists but couldn't be parsed/validated. */
      malformed: boolean;
      recording: File | null;
      /**
       * ADR-008: the session marker is present but `recording.webm` OR `report.md`
       * is missing. Mirrors scanSessions' rule (sessions.ts) so the view's badge
       * matches the sidebar. NOTE: a session can be incomplete while `recording`
       * is non-null — the figma-flow-incomplete fixture has a recording but no
       * report.md — so this can't be derived from `recording` alone.
       */
      incomplete: boolean;
      /**
       * TASK-34: whether `report.md` exists in the folder. `incomplete` can't stand
       * in for this — a session can be incomplete for a *missing recording* while
       * the report is present, so the Tasks/Markdown switcher needs its own flag.
       */
      hasReport: boolean;
      /**
       * One screenshot File per task, parallel to `analysis.tasks` and in the same
       * order (TASK-18). A task with no matching frame on disk is null → the view
       * renders a placeholder, never crashes. Empty when `analysis` is null.
       */
      screenshots: (File | null)[];
    };

/**
 * Load one session by folder name against the live workspace handle.
 *
 * `name` is the raw folder name (the session identity until Gemini renames it),
 * exactly as it came from scanSessions / the route param.
 */
export async function loadSessionData(
  workspace: FileSystemDirectoryHandle,
  name: string,
): Promise<SessionData> {
  // Resolve the session folder. A missing folder is "not-found", not an error.
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await workspace.getDirectoryHandle(name);
  } catch (err) {
    if (isNotFound(err)) return { status: "not-found" };
    return { status: "error" };
  }

  // The manual-rename override (name.txt), read once and best-effort — it wins
  // over the suggested_name and the folder name for the display name (TASK-22).
  const override = await readOverrideName(dir);

  // The marker file is what makes this a listed session (ADR-008). If it's gone
  // but a recording is sitting here, this is an un-analyzed session (just
  // recorded/imported) — surface it so the view can offer Analyze. Only a folder
  // with neither marker nor recording is genuinely "not a session".
  let markerFile: File;
  try {
    const markerHandle = await dir.getFileHandle(SESSION_MARKER);
    markerFile = await markerHandle.getFile();
  } catch (err) {
    if (isNotFound(err)) {
      const match = await findRecording(dir);
      if (match) {
        const displayName = sessionDisplayName({ override, suggested: null, folderName: name });
        maybeWriteSidecar(dir, displayName, name);
        return {
          status: "unanalyzed",
          recording: await match.handle.getFile(),
          displayName,
        };
      }
      return { status: "not-found" };
    }
    return { status: "error" };
  }

  // Parse tasks.json. Bad JSON or a schema violation is NON-fatal: we keep the
  // session (status "ok") but mark it malformed so the view degrades instead of
  // disappearing. Only an unexpected read failure becomes "error".
  //
  // ADR-025: a stored tasks.json is used directly; a legacy (bare AnalysisResult)
  // one is upgraded IN MEMORY so the view always sees stored tasks with resolved
  // screenshot filenames. The upgrade is not written back (TASK-56 owns lazy
  // persist-on-edit).
  let analysis: StoredAnalysisResult | null = null;
  let malformed = false;
  try {
    const json = JSON.parse(await markerFile.text());
    const parsed = parseStoredResult(json);
    if (parsed.status === "stored") {
      analysis = parsed.result;
    } else if (parsed.status === "legacy") {
      analysis = upgrade(parsed.result, deriveScreenshotNames);
    } else {
      malformed = true;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      malformed = true; // not JSON at all
    } else {
      return { status: "error" };
    }
  }

  // The recording and report are optional for rendering: an incomplete session
  // (marker but a missing deliverable — ADR-008) still shows its task list. We
  // read report.md only for its presence (the badge), not its content — the
  // session view renders tasks from tasks.json, not the Markdown.
  // The recording may be webm (recorded) or mp4 (imported — S13); resolve the
  // actual file so an imported session plays and isn't flagged incomplete.
  const [recordingMatch, report] = await Promise.all([
    findRecording(dir),
    getFileOrNull(dir, REPORT_FILE),
  ]);
  const recording = recordingMatch ? await recordingMatch.handle.getFile() : null;
  const incomplete = !recording || !report;

  // Screenshots pair to tasks by the STORED task.screenshot filename (ADR-025,
  // screenshots.ts) with a derive fallback; only meaningful when tasks parsed. A
  // malformed tasks.json yields no previews.
  const screenshots = analysis ? await loadScreenshots(dir, analysis.tasks) : [];

  const displayName = sessionDisplayName({
    override,
    suggested: analysis?.suggested_name ?? null,
    folderName: name,
  });
  maybeWriteSidecar(dir, displayName, name);

  return {
    status: "ok",
    displayName,
    analysis,
    malformed,
    recording,
    incomplete,
    hasReport: report !== null,
    screenshots,
  };
}

/**
 * TASK-51 — one archived run's payload for the Info-tab run switcher.
 *
 *   analysis   — the tasks parsed from an ADR-009 archive (tasks-<stamp>.json),
 *                or null when that file is malformed. The view renders these
 *                against the SAME recording.webm as the latest run.
 *   malformed  — the archive exists but isn't valid JSON / fails the schema.
 *   reportFile — the report archive that pairs with this run (report-<stamp>.md)
 *                IF present on disk, else null. Used by the Markdown view; null
 *                simply hides the Markdown tab for this run (the task list still
 *                works). See resolveArchivedReport for why a pair can be absent.
 *   screenshotsDir — the folder this run's frames live in: `screenshots-<stamp>/`
 *                (Option B / ADR-023), paired by the run's unified stamp. The
 *                Markdown view resolves images against it; a legacy run archived
 *                before Option B has no such folder, so its frames degrade to "no
 *                preview" (ADR-013) rather than crashing.
 */
export interface ArchivedRunData {
  /** The archived run as a StoredAnalysisResult (ADR-025): a stored archive is used
   *  as-is, a legacy one is upgraded in memory (not persisted). Null when malformed. */
  analysis: StoredAnalysisResult | null;
  malformed: boolean;
  reportFile: string | null;
  screenshotsDir: string;
}

/**
 * Load one archived run (an ADR-009 `tasks-<stamp>.json`) for read-only viewing.
 * Mirrors loadSessionData's tasks.json parse (bad JSON / schema miss → malformed,
 * never a throw), and best-effort resolves the paired report archive. Throws only
 * if the session folder or the archive file itself can't be reached — the caller
 * (which listed this run in the Info tab) treats that as a transient miss and
 * degrades to a malformed run rather than crashing.
 */
export async function loadArchivedRun(
  workspace: FileSystemDirectoryHandle,
  name: string,
  tasksSource: string,
): Promise<ArchivedRunData> {
  const dir = await workspace.getDirectoryHandle(name);
  const handle = await dir.getFileHandle(tasksSource);
  const file = await handle.getFile();

  let analysis: StoredAnalysisResult | null = null;
  let malformed = false;
  try {
    const json = JSON.parse(await file.text());
    const parsed = parseStoredResult(json);
    if (parsed.status === "stored") {
      analysis = parsed.result;
    } else if (parsed.status === "legacy") {
      // Legacy archive → normalize in memory (ADR-025), same as the live path.
      analysis = upgrade(parsed.result, deriveScreenshotNames);
    } else {
      malformed = true;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      malformed = true; // not JSON at all
    } else {
      throw err;
    }
  }

  // Resolve the run's paired artifacts by its unified stamp (ADR-023): both the
  // report archive and the screenshots folder share the tasks archive's stamp.
  const stamp = stampFromArchiveTasks(tasksSource);
  const reportCandidate = stamp ? `report-${stamp}.md` : null;
  const reportFile =
    reportCandidate && (await getFileOrNull(dir, reportCandidate)) !== null
      ? reportCandidate
      : null;
  // The frames folder for this run; may be absent (legacy pre-Option-B run) — the
  // reader that consumes it handles a missing folder as "no preview" (ADR-013).
  const screenshotsDir = stamp ? screenshotsArchiveName(stamp) : SCREENSHOTS_DIR;

  return { analysis, malformed, reportFile, screenshotsDir };
}

/**
 * Extract a run's unified stamp from its tasks archive name: `tasks-<stamp>.json`
 * → `<stamp>` (e.g. "2026-07-02-131500", or "…-2" on a same-second collision).
 * Matches the exact shape archiveStamp writes (render-report.ts) so we never
 * mistake an unrelated file for a run. Since ADR-023 stamps report/tasks/screenshots
 * of one run identically, this same stamp names all three archives.
 */
function stampFromArchiveTasks(tasksSource: string): string | null {
  const m = /^tasks-(\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?)\.json$/.exec(tasksSource);
  return m ? m[1] : null;
}

/**
 * TASK-43 — drop/refresh the Finder findability sidecar when a session resolves to
 * a real name (an override or a Gemini suggestion — not the bare timestamp). Fire-
 * and-forget: writeNameSidecar is best-effort and never throws, so opening a
 * session never waits on or fails because of it. Skipped when the display name IS
 * the folder name (nothing to reveal).
 */
function maybeWriteSidecar(
  dir: FileSystemDirectoryHandle,
  displayName: string,
  folderName: string,
): void {
  if (displayName === folderName) return;
  void writeNameSidecar(dir, displayName);
}

/** getFile for a name, or null if the file isn't there. Other errors propagate. */
async function getFileOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<File | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}
