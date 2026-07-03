// TASK-48 — read ONE session's analysis history for the Info tab.
//
// Where loadSessionData (session-data.ts) parses only the LIVE tasks.json, this
// reader walks the whole session folder and gathers every run: the current
// tasks.json plus each ADR-009 archive (tasks-<stamp>.json, written before an
// overwrite by writeReportBrowser). Each file carries the `run` telemetry block
// (TASK-45: model(s) incl. fallback, mode, language, tokens, cost) it was
// written with, so the union of them IS the per-session analysis history.
//
// Best-effort throughout (ADR-008): a file that isn't valid JSON, or an old run
// written before TASK-45 (no `run`), never crashes the tab — it degrades to a
// row with "—" for the missing metadata, or is skipped when nothing usable
// survives. Client-safe: only FS Access + JSON, no Node built-ins.

import {
  AnalysisResultSchema,
  type AnalysisRun,
  type ReviewType,
} from "@/lib/gemini/schema";

/** The live marker (session-data.ts SESSION_MARKER) — the most recent run. */
const CURRENT_NAME = "tasks.json";

/**
 * An archive written by writeReportBrowser (ADR-009): `tasks-<stamp>.json`,
 * where <stamp> is archiveStamp() = "YYYY-MM-DD-HHMMSS", optionally with a
 * "-N" collision suffix (same-second re-archive). Matching this exact shape (not
 * a loose `tasks-*.json`) keeps us from mistaking an unrelated file for a run.
 */
const ARCHIVE_NAME = /^tasks-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/;

/**
 * One analysis run in a session's history. `run` is the TASK-45 telemetry, or
 * null for a pre-TASK-45 run (the file parsed but carried no `run` block) — the
 * Info tab shows "—" for such a row rather than hiding it. `taskCount` /
 * `reviewType` are light context, null when the file didn't parse as a result.
 */
export interface RunHistoryEntry {
  /** The file this run came from: "tasks.json" or "tasks-<stamp>.json". */
  source: string;
  /**
   * A short, stable, human-referenceable id (4 hex chars, rendered as "#a1f3").
   * Derived DETERMINISTICALLY from the run's own identity — the ADR-023 archive
   * stamp for an archive, the run's analyzedAt for the live one — so it holds
   * across reloads and never uses Math.random/Date.now (unstable + unavailable
   * in some contexts). A quiet handle for talking about a specific run.
   */
  id: string;
  /** True for the live tasks.json (the latest run); false for an archive. */
  current: boolean;
  /** Per-run telemetry (TASK-45), or null when the run predates it. */
  run: AnalysisRun | null;
  /** Epoch ms used to sort newest-first: run.analyzedAt, else stamp/mtime. */
  sortMs: number;
  /** Number of tasks the run produced, or null if the file didn't parse. */
  taskCount: number | null;
  /** The inferred review type, or null if the file didn't parse. */
  reviewType: ReviewType | null;
}

/**
 * Load a session's full run history, newest-first. Reads tasks.json + every
 * tasks-<stamp>.json archive in the folder, extracting each one's `run`. Never
 * throws for expected trouble: a gone folder, an unreadable file, or a corrupt
 * JSON is skipped; a valid-but-old run (no `run`) is kept with run: null. An
 * empty array means "no runs to show" (fresh/unanalyzed session or all files
 * unreadable) — the caller renders an empty state.
 */
export async function loadRunHistory(
  workspace: FileSystemDirectoryHandle,
  name: string,
): Promise<RunHistoryEntry[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await workspace.getDirectoryHandle(name);
  } catch {
    return []; // folder gone / unreachable — nothing to show, don't crash the tab
  }

  // Collect the run-bearing filenames first (current + archives), each with the
  // fallback timestamp we'd sort by if its `run` is missing.
  const files: { source: string; current: boolean; stampMs: number | null }[] = [];
  try {
    for await (const entry of dir.values()) {
      if (entry.kind !== "file") continue;
      if (entry.name === CURRENT_NAME) {
        files.push({ source: entry.name, current: true, stampMs: null });
        continue;
      }
      const m = ARCHIVE_NAME.exec(entry.name);
      if (m) {
        files.push({ source: entry.name, current: false, stampMs: stampToMs(m) });
      }
    }
  } catch {
    return []; // directory iteration failed mid-scan — best-effort, bail cleanly
  }

  const entries = await Promise.all(
    files.map((f) => readRunEntry(dir, f.source, f.current, f.stampMs)),
  );

  return entries
    .filter((e): e is RunHistoryEntry => e !== null)
    .sort((a, b) => b.sortMs - a.sortMs);
}

/**
 * Read one run file into an entry. Returns null only when the file can't be read
 * or isn't parseable JSON at all (nothing usable to show). A file that parses
 * but fails the AnalysisResult schema, or lacks `run`, still yields an entry —
 * with run: null and no context — so an old/partial run stays visible.
 */
async function readRunEntry(
  dir: FileSystemDirectoryHandle,
  source: string,
  current: boolean,
  stampMs: number | null,
): Promise<RunHistoryEntry | null> {
  let file: File;
  try {
    const handle = await dir.getFileHandle(source);
    file = await handle.getFile();
  } catch {
    return null; // vanished between listing and read — skip it
  }

  // The fallback sort key when `run.analyzedAt` is absent: the archive stamp
  // baked into the name, else the file's own last-modified time.
  const fallbackMs = stampMs ?? file.lastModified;

  let parsedRun: AnalysisRun | null = null;
  let taskCount: number | null = null;
  let reviewType: ReviewType | null = null;
  try {
    const json: unknown = JSON.parse(await file.text());
    const result = AnalysisResultSchema.safeParse(json);
    if (result.success) {
      parsedRun = result.data.run ?? null;
      taskCount = result.data.tasks.length;
      reviewType = result.data.review_type;
    }
    // A schema miss (bad/legacy shape) still counts as a run we saw — we just
    // can't show its context. Keep the row (run stays null) rather than hide it.
  } catch {
    return null; // not JSON at all — genuinely unreadable, skip
  }

  const sortMs = parsedRun ? Date.parse(parsedRun.analyzedAt) : NaN;

  // The id seed: for an archive, its filename carries the stamp (stable +
  // distinctive); for the live run, its own analyzedAt, else a source+mtime
  // fallback so a pre-TASK-45 run still gets a stable-enough handle.
  const idSeed =
    stampMs !== null
      ? source
      : parsedRun?.analyzedAt ?? `${source}:${fallbackMs}`;

  return {
    source,
    id: shortRunId(idSeed),
    current,
    run: parsedRun,
    // Guard Date.parse: a malformed analyzedAt falls back to the stamp/mtime.
    sortMs: Number.isNaN(sortMs) ? fallbackMs : sortMs,
    taskCount,
    reviewType,
  };
}

/**
 * Fold a stable seed into a compact 4-hex-char slug (e.g. "a1f3"). FNV-1a 32-bit
 * (Math.imul for correct 32-bit overflow), then fold to 16 bits — enough spread
 * for a handful of runs per session, short enough to read. Deterministic: the
 * same seed always yields the same slug, so a run keeps its id across reloads.
 */
function shortRunId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const slug = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return slug.toString(16).padStart(4, "0");
}

/**
 * Turn an ARCHIVE_NAME regex match (Y, M, D, H, Min, S capture groups) into
 * epoch ms in LOCAL time — archiveStamp() writes local-time components, so we
 * reconstruct with the local `new Date(y, m, …)` constructor to round-trip.
 */
function stampToMs(m: RegExpExecArray): number {
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}
