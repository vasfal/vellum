// TASK-56 — the NON-ARCHIVING edit-save path + the AI-baseline sidecar (ADR-024).
//
// Two write paths exist for a session's tasks.json now, and they must not be
// confused:
//   - writeReportBrowser (write-report-browser.ts) is an AI action — it ARCHIVES
//     the prior run (report-<stamp>.md / tasks-<stamp>.json / screenshots-<stamp>/,
//     ADR-009/023) and creates a NEW run/version.
//   - saveSessionEdits (this file) is a MANUAL edit — it writes tasks.json in place
//     and re-renders report.md so the two stay in sync, WITHOUT archiving anything.
//     Manual edits are in-place on the current version; only AI actions version
//     (ADR-024). It never touches screenshots/.
//
// The AI baseline (tasks.ai.json) is the immutable pristine AI output of the
// CURRENT run — used later (TASK-57) for "edited" markers + revert-to-AI. Policy
// (ADR-024/025, lazy): snapshot it on the FIRST edit of a session (the current
// tasks.json is still pure AI output then) if it doesn't already exist; never
// overwrite an existing baseline. A re-analysis resets it (writeReportBrowser
// archives + drops it) so the baseline always tracks the live run.
//
// FORMAT IS SHARED, NOT DUPLICATED (ADR-015): report.md is rendered through
// render-report.ts — the same module the two writeReport variants use — so a save
// produces byte-identical Markdown to a fresh analysis write of the same tasks.
//
// Client-safe: File System Access handle I/O only, no Node built-ins.

import {
  parseStoredResult,
  StoredAnalysisResultSchema,
  upgrade,
  type StoredAnalysisResult,
} from "@/lib/gemini/stored";
import {
  renderMarkdown,
  sessionDisplayName,
  today,
} from "@/lib/report/render-report";
import { deriveScreenshotNames } from "./screenshots";
import { readOverrideName } from "./session-name";

const REPORT_NAME = "report.md";
const TASKS_NAME = "tasks.json";
/** The immutable pristine-AI baseline of the current run (ADR-024/025). Named so
 *  it can NEVER be mistaken for a run archive (tasks-<stamp>.json) by run-history's
 *  reader (the "." keeps it out of the `tasks-<stamp>` shape). */
export const AI_BASELINE_NAME = "tasks.ai.json";

/**
 * Save a manual edit of a session's analysis IN PLACE — no archiving, no new run.
 *
 *   1. Snapshot the AI baseline (tasks.ai.json) if this is the first edit and no
 *      baseline exists yet — captures the pristine AI output before we overwrite
 *      tasks.json (ADR-024/025).
 *   2. Validate `result` against StoredAnalysisResultSchema (fail loud — a bad
 *      shape would break the UI / re-render, same gate as the analysis writers).
 *   3. Write tasks.json (pretty-printed stored shape).
 *   4. Re-render + write report.md from the SAME tasks, so tasks.json and report.md
 *      never drift.
 *
 * `sessionName` is the session folder's own name — used only to resolve the report
 * title (override name.txt > suggested_name > folder), exactly as writeReportBrowser
 * does, so the report title survives an edit unchanged.
 *
 * Deliberately does NOT call any archive* helper and never touches screenshots/ —
 * that behavior is exclusive to the AI writeReportBrowser path (ADR-024).
 */
export async function saveSessionEdits(
  sessionDir: FileSystemDirectoryHandle,
  result: StoredAnalysisResult,
  sessionName: string,
): Promise<void> {
  // Snapshot the baseline BEFORE overwriting tasks.json — at first-edit time the
  // on-disk tasks.json is still the pristine AI output. No-op if a baseline
  // already exists (second+ save) so the baseline stays pristine.
  await writeAiBaselineIfAbsent(sessionDir);

  // Fail loud on a malformed edit — the UI and every re-render round-trip through
  // this schema, so an invalid result must never reach disk.
  const validated = StoredAnalysisResultSchema.parse(result);

  // The report title is the session's EFFECTIVE name (TASK-22), resolved exactly
  // like writeReportBrowser: manual override (name.txt) > suggested_name > folder.
  const override = await readOverrideName(sessionDir);
  const markdown = renderMarkdown({
    title: sessionDisplayName({
      override,
      suggested: validated.suggested_name,
      folderName: sessionName,
    }),
    date: today(),
    relVideo: "recording.webm",
    result: validated,
  });

  // tasks.json first, then report.md — both in the stored shape / shared format.
  await writeTextFile(
    sessionDir,
    TASKS_NAME,
    JSON.stringify(validated, null, 2) + "\n",
  );
  await writeTextFile(sessionDir, REPORT_NAME, markdown);
}

/**
 * Create the AI baseline sidecar (tasks.ai.json) from the CURRENT tasks.json IF it
 * doesn't already exist. The snapshot is normalized to the STORED shape with ids
 * (a stored tasks.json is copied as-is after a schema round-trip; a legacy one is
 * upgraded via the same one-time replay session-data uses) so TASK-57 can diff
 * edited fields against a baseline that always carries ids.
 *
 * Never overwrites an existing baseline (that would lose the pristine snapshot),
 * and skips silently when tasks.json is missing or malformed — there is nothing
 * trustworthy to snapshot, and a save must not fabricate a baseline.
 */
export async function writeAiBaselineIfAbsent(
  sessionDir: FileSystemDirectoryHandle,
): Promise<void> {
  // Already snapshotted — leave it untouched (the baseline is immutable per run).
  if (await getFileHandleOrNull(sessionDir, AI_BASELINE_NAME)) return;

  const tasksHandle = await getFileHandleOrNull(sessionDir, TASKS_NAME);
  if (!tasksHandle) return; // nothing to snapshot

  let text: string;
  try {
    text = await (await tasksHandle.getFile()).text();
  } catch {
    return; // unreadable — don't fabricate a baseline
  }

  const baseline = normalizeToStored(text);
  if (!baseline) return; // malformed tasks.json — skip

  await writeTextFile(
    sessionDir,
    AI_BASELINE_NAME,
    JSON.stringify(baseline, null, 2) + "\n",
  );
}

/**
 * Read the AI baseline for a session (tasks.ai.json), or null when there is none
 * yet (no edit has happened) or it can't be parsed. Best-effort by design — a
 * missing/unreadable baseline degrades the caller (TASK-57) to "no edited markers"
 * rather than crashing.
 */
export async function readAiBaseline(
  sessionDir: FileSystemDirectoryHandle,
): Promise<StoredAnalysisResult | null> {
  const handle = await getFileHandleOrNull(sessionDir, AI_BASELINE_NAME);
  if (!handle) return null;
  try {
    const text = await (await handle.getFile()).text();
    return normalizeToStored(text);
  } catch {
    return null;
  }
}

/**
 * Parse tasks.json text into a StoredAnalysisResult, upgrading a legacy shape in
 * memory (same as session-data.ts), or null if it's not valid JSON / neither
 * shape. Kept here (not exported from session-data) so this module stays free of
 * the SessionData load machinery.
 */
function normalizeToStored(text: string): StoredAnalysisResult | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null; // not JSON at all
  }
  const parsed = parseStoredResult(json);
  if (parsed.status === "stored") return parsed.result;
  if (parsed.status === "legacy") return upgrade(parsed.result, deriveScreenshotNames);
  return null; // malformed for both layers
}

/** Write a UTF-8 text file under `dir`, creating/overwriting it. */
async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  contents: string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

/** getFileHandle, but NotFoundError → null instead of throwing (see sessions.ts). */
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
