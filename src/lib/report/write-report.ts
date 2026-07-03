/**
 * writeReport (TASK-7) — the final pipeline stage for the CLI/Node path: turn an
 * AnalysisResult plus its extracted screenshots into the on-disk deliverable for
 * one session, writing to an ABSOLUTE `sessionDir` via node:fs.
 *
 * It writes two files into `sessionDir`:
 *   - `report.md`   — the human-readable Markdown report (the deliverable).
 *   - `tasks.json`  — the session marker the UI scans for (ADR-008), and the
 *                     re-render source (ARCHITECTURE §Local storage layout).
 *
 * FORMAT LIVES ELSEWHERE (ADR-015): every function that produces Markdown text
 * or a shared name (renderMarkdown, humanizeTitle, archiveStamp, relativize,
 * toPosix…) is imported from `./render-report`, the client-safe single source of
 * truth. This file owns ONLY the node:fs I/O — the browser variant
 * (src/lib/filesystem/write-report-browser.ts) mirrors this same I/O against a
 * FileSystemDirectoryHandle while sharing the identical render module.
 *
 * Two behaviors are load-bearing and come straight from the ADRs:
 *
 *   ADR-009 (versioning, manual edits preserved): before overwriting an existing
 *   `report.md` / `tasks.json`, the current file is ARCHIVED (renamed) to
 *   `report-<timestamp>.md` / `tasks-<timestamp>.json` first. A user may have
 *   hand-edited the report; we never silently destroy that.
 *
 *   ADR-008 (identity via markers): `tasks.json` is the marker the UI uses to
 *   recognize a folder as a Vellum session. We write it as a bare AnalysisResult
 *   so it parses straight back through AnalysisResultSchema on re-render (the
 *   contract TASK-4 owns) — no envelope of our own.
 *
 * Portability: every path written INTO the report is relative to `sessionDir`
 * (`screenshots/frame-00-03.png`, `recording.webm`), so the report still renders
 * after the user moves or renames the session folder. Absolute `screenshotPaths`
 * (from TASK-6) are relativized here; separators are normalized to `/`.
 *
 * Contract: ARCHITECTURE.md §Pipeline contracts.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { AnalysisResultSchema, type AnalysisResult } from "@/lib/gemini/schema";
import { upgrade } from "@/lib/gemini/stored";
import {
  archiveStamp,
  relativize,
  renderMarkdown,
  screenshotsArchiveName,
  sessionDisplayName,
  today,
  toPosix,
} from "./render-report";

export interface WriteReportInput {
  sessionDir: string;
  /** Path to the recording, for the report's video link. Absolute or already
   *  relative to sessionDir — either way it ends up relative in the report. */
  videoPath: string;
  result: AnalysisResult;
  /** Absolute PNG paths from extractScreenshots, parallel to result.tasks. */
  screenshotPaths: string[];
}

export interface WriteReportOutput {
  reportPath: string;
  tasksJsonPath: string;
}

const REPORT_NAME = "report.md";
const TASKS_NAME = "tasks.json";
/** Manual-rename sidecar (TASK-22); mirrors OVERRIDE_NAME_FILE on the browser side. */
const OVERRIDE_NAME_FILE = "name.txt";

/**
 * Read a session's manual override (`name.txt`), or null if absent. Best-effort:
 * any read failure falls back to null (the folder name), never throwing — the
 * node mirror of readOverrideName in lib/filesystem/session-name.ts. Only the
 * first non-empty line is used, trimmed.
 */
async function readOverrideName(sessionDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(sessionDir, OVERRIDE_NAME_FILE), "utf8");
    const first = text.split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

export async function writeReport(
  input: WriteReportInput,
): Promise<WriteReportOutput> {
  const { sessionDir, videoPath, screenshotPaths } = input;

  // Validate the marker payload up front: tasks.json MUST round-trip through
  // the authoritative schema (TASK-4), or the UI/re-render would choke on it.
  const result = AnalysisResultSchema.parse(input.result);

  // Screenshots are documented as parallel to tasks; a mismatch is a glue bug,
  // not something to paper over (error philosophy: fail loud).
  if (screenshotPaths.length !== result.tasks.length) {
    throw new Error(
      `writeReport: screenshotPaths (${screenshotPaths.length}) must be parallel ` +
        `to result.tasks (${result.tasks.length}).`,
    );
  }

  await mkdir(sessionDir, { recursive: true });

  const reportPath = path.join(sessionDir, REPORT_NAME);
  const tasksJsonPath = path.join(sessionDir, TASKS_NAME);

  // ADR-009 + ADR-023: archive any existing report.md / tasks.json BEFORE we
  // overwrite them, under ONE unified run stamp (so report-/tasks- of a run pair
  // by exact stamp — matching the browser writer). See archivePriorRun for why
  // the CLI never actually archives SCREENSHOTS here (fresh dir per run).
  await archivePriorRun(sessionDir);

  const relVideo = toPosix(relativize(sessionDir, videoPath));

  // ADR-025: persist tasks.json in the STORED shape (mirrors write-report-browser
  // so CLI + app stay format-compatible). upgrade() assigns each task a stable id,
  // origin='ai', and its screenshot filename. We record the ACTUAL extracted frame
  // filenames (basename of screenshotPaths[i], parallel to tasks), NOT a replay of
  // the naming algorithm — the extractor clamps a past-the-end screenshot_timestamp
  // before naming (screenshots.ts CAVEAT), so a pure replay can diverge from the
  // real file. The report then sources each task's frame from its stored
  // `screenshot` name, not from array position.
  const shotNames = screenshotPaths.map((p) => path.basename(p));
  const stored = upgrade(result, () => shotNames);

  // The report title is the session's EFFECTIVE name (TASK-22): a manual override
  // (name.txt) wins, else Gemini's suggested_name, else the timestamp folder name.
  // Mirrors the browser writeReport so the CLI and the app title reports identically.
  const override = await readOverrideName(sessionDir);
  const markdown = renderMarkdown({
    title: sessionDisplayName({
      override,
      suggested: stored.suggested_name,
      folderName: path.basename(sessionDir),
    }),
    date: today(),
    relVideo,
    result: stored,
  });

  await writeFile(reportPath, markdown, "utf8");
  // Stored AnalysisResult (ADR-025 marker, over ADR-008's bare marker) — pretty-
  // printed so manual diffs read; still round-trips through AnalysisResultSchema on
  // re-render (Zod strips the storage-only fields).
  await writeFile(tasksJsonPath, JSON.stringify(stored, null, 2) + "\n", "utf8");

  return { reportPath, tasksJsonPath };
}

/**
 * Archive the current run's report.md / tasks.json under ONE unified run stamp
 * (ADR-009 + ADR-023), mirroring the browser writer (write-report-browser.ts).
 * The canonical stamp is the report's last-modified second (when this run was
 * written), falling back to tasks.json — a single source so report-/tasks- names
 * match exactly. A same-second re-analysis gets a shared "-N" across both.
 *
 * SCREENSHOTS are deliberately NOT archived here. In the Node/CLI contract the
 * new run's frames are extracted straight into `screenshots/` BEFORE writeReport
 * runs (scripts/cli.ts), so at this point `screenshots/` already holds the CURRENT
 * run — archiving it would misfile the new frames, not the old. In practice the
 * CLI always writes a FRESH session dir (createSessionDir), so there is never a
 * prior run to archive. The per-run screenshot archiving of Option B (ADR-023)
 * therefore lives only in the browser writer, which writes frames itself and can
 * correctly archive the prior `screenshots/` before writing the new set.
 */
async function archivePriorRun(dir: string): Promise<void> {
  const reportPath = path.join(dir, REPORT_NAME);
  const tasksPath = path.join(dir, TASKS_NAME);
  const hasReport = existsSync(reportPath);
  const hasTasks = existsSync(tasksPath);
  if (!hasReport && !hasTasks) return; // fresh session dir — nothing to supersede

  const baseMtime = hasReport
    ? (await stat(reportPath)).mtime
    : (await stat(tasksPath)).mtime;
  const stamp = await reserveRunStamp(dir, archiveStamp(baseMtime));

  if (hasReport) await rename(reportPath, path.join(dir, `report-${stamp}.md`));
  if (hasTasks) await rename(tasksPath, path.join(dir, `tasks-${stamp}.json`));
}

/**
 * A run stamp free across all three archive names (report-/tasks-/screenshots-),
 * suffixing "-N" until none is taken. Checks the screenshots archive too so a
 * unified stamp stays collision-free even next to browser-written archives.
 */
async function reserveRunStamp(dir: string, base: string): Promise<string> {
  let candidate = base;
  let n = 2;
  while (runStampTaken(dir, candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function runStampTaken(dir: string, stamp: string): boolean {
  return (
    existsSync(path.join(dir, `report-${stamp}.md`)) ||
    existsSync(path.join(dir, `tasks-${stamp}.json`)) ||
    existsSync(path.join(dir, screenshotsArchiveName(stamp)))
  );
}
