// TASK-27 — browser-side writeReport: write one session's analysis into the
// workspace through its FileSystemDirectoryHandle (ADR-014). The app can't use
// the Node writeReport (src/lib/report/write-report.ts) — that writes to an
// absolute path via node fs, and the workspace is a browser directory handle
// with no absolute path (by browser design). This is the FS Access mirror.
//
// FORMAT IS SHARED, NOT DUPLICATED (ADR-015): the Markdown and every shared name
// come from src/lib/report/render-report.ts — the same client-safe module the
// Node writeReport imports. Only the I/O half differs: here it's createWritable()
// / removeEntry() against the handle instead of node fs. Keep the two I/O halves'
// BEHAVIOR in sync (ADR-009 archiving, ADR-008 bare-marker tasks.json); the FORMAT
// stays in sync automatically because both render through render-report.ts.
//
// Input contract (TASK-26 / ADR-014): /api/analyze returns the validated
// AnalysisResult plus screenshots as base64 PNGs, PARALLEL to result.tasks, named
// exactly as the extractor named them ("frame-MM-SS.png", ADR-013 — used as-is so
// the read-side pairing in screenshots.ts still resolves).
//
// Client-safe: no Node built-in imports (no Buffer, no fs, no path).

import { AnalysisResultSchema, type AnalysisResult } from "@/lib/gemini/schema";
import { upgrade } from "@/lib/gemini/stored";
import {
  archiveStamp,
  renderMarkdown,
  screenshotsArchiveName,
  sessionDisplayName,
  today,
} from "@/lib/report/render-report";
import { deriveScreenshotNames } from "./screenshots";
import { findRecording } from "./recording-file";
import { readOverrideName } from "./session-name";
import { AI_BASELINE_NAME } from "./write-edits-browser";

const REPORT_NAME = "report.md";
const TASKS_NAME = "tasks.json";
const SCREENSHOTS_DIR = "screenshots";
// TASK-60 — the current version's comments sidecar (comments-browser.ts). Archived
// with the run on any new run so an archived run keeps the comments it was revised
// from, and the fresh run starts comment-free.
const COMMENTS_NAME = "comments.json";

/** One extracted frame from /api/analyze: filename + base64-encoded PNG bytes. */
export interface ScreenshotPayload {
  /** As named by the extractor (ADR-013), e.g. "frame-00-34.png". Used as-is. */
  name: string;
  /** Base64 PNG (no data: prefix). */
  base64: string;
}

export interface WriteReportBrowserOutput {
  /** Relative names written, for the caller to link/log. */
  reportName: string;
  tasksJsonName: string;
  screenshotNames: string[];
}

/**
 * Write report.md + tasks.json + screenshots/*.png into the session folder via
 * its directory handle. `sessionName` is the session folder's own name — used
 * only for the humanized report title (mirrors the Node side's path.basename).
 *
 * Assumes the handle is reachable and readwrite-granted (callers gate on that,
 * per workspace.ts).
 */
export async function writeReportBrowser(
  sessionDir: FileSystemDirectoryHandle,
  result: AnalysisResult,
  screenshots: ScreenshotPayload[],
  sessionName: string,
): Promise<WriteReportBrowserOutput> {
  // Validate the marker payload up front: tasks.json MUST round-trip through the
  // authoritative schema (TASK-4), or the UI/re-render would choke on it. Same
  // fail-loud gate as the Node writeReport.
  const validated = AnalysisResultSchema.parse(result);

  // Screenshots are documented as parallel to tasks; a mismatch is a glue bug,
  // not something to paper over (mirrors the Node screenshotPaths check).
  if (screenshots.length !== validated.tasks.length) {
    throw new Error(
      `writeReportBrowser: screenshots (${screenshots.length}) must be parallel ` +
        `to result.tasks (${validated.tasks.length}).`,
    );
  }

  // ADR-009 + ADR-023 (Option B): archive the CURRENT run's artifacts BEFORE we
  // overwrite them — report.md, tasks.json, AND the screenshots/ folder — all
  // under ONE unified run stamp so a run's three archives pair by exact stamp on
  // the read side. Screenshots aren't written until further below, so screenshots/
  // here still holds the PRIOR run's frames (this is the seam Option B relies on).
  //
  // TASK-71 — a re-run-WITH-video (origin "revise-video") is the one path that can
  // REPLACE the session recording, so snapshot the prior recording into the
  // superseded run's archive (recording-<stamp>.webm) BEFORE the new video lands,
  // letting each run's ZIP export resolve the exact video it analyzed. A plain
  // analyze / text-revise shares the session recording, so it isn't snapshotted.
  await archivePriorRun(sessionDir, validated.run?.origin === "revise-video");

  // Relative, forward-slash path for the recording link — the browser builds this
  // directly (no absolute path to relativize).
  const relVideo = "recording.webm";

  // ADR-025: persist tasks.json in the STORED shape — each task gets a stable id,
  // origin='ai', and its screenshot filename recorded ON the task. We record the
  // ACTUAL extractor filenames (screenshots[i].name, parallel to tasks), NOT a
  // replay of the naming algorithm: the extractor CLAMPS a screenshot_timestamp
  // past the video end before naming (screenshots.ts CAVEAT), so a pure replay can
  // diverge from the real file. `upgrade`'s injected namer lets us hand it the
  // authoritative names directly. From here the file is pinned to the task by name,
  // so a later reorder/add/delete can't mis-pair it.
  const shotNames = screenshots.map((s) => s.name);
  const stored = upgrade(validated, () => shotNames);

  // The report title is the session's EFFECTIVE name (TASK-22): a manual override
  // (name.txt) wins, else Gemini's suggested_name, else the timestamp folder name.
  // Reading name.txt here means a re-analysis keeps a user's manual rename in the
  // report title instead of reverting to the folder timestamp.
  const override = await readOverrideName(sessionDir);
  const markdown = renderMarkdown({
    title: sessionDisplayName({
      override,
      suggested: stored.suggested_name,
      folderName: sessionName,
    }),
    date: today(),
    relVideo,
    // The report sources each task's frame from its stored `screenshot` name.
    result: stored,
  });

  await writeTextFile(sessionDir, REPORT_NAME, markdown);
  // Stored AnalysisResult (ADR-025 marker, layered over ADR-008's bare marker) —
  // pretty-printed so manual diffs read; still round-trips through
  // AnalysisResultSchema on re-render (Zod strips the storage-only fields), so
  // scanSessions / run-history keep working.
  await writeTextFile(
    sessionDir,
    TASKS_NAME,
    JSON.stringify(stored, null, 2) + "\n",
  );

  // screenshots/ — created if absent; each PNG written under its given name.
  const shotsDir = await sessionDir.getDirectoryHandle(SCREENSHOTS_DIR, {
    create: true,
  });
  for (const shot of screenshots) {
    await writeBytesFile(shotsDir, shot.name, base64ToBytes(shot.base64));
  }

  return {
    reportName: REPORT_NAME,
    tasksJsonName: TASKS_NAME,
    screenshotNames: screenshots.map((s) => s.name),
  };
}

/**
 * TASK-60 (ADR-024) — write a TEXT-ONLY revise as a NEW run, REUSING the session's
 * existing frames instead of extracting fresh ones. The revise Gemini call produces
 * a new AnalysisResult but no screenshots (there was no video pass), so we carry the
 * still-referenced frames forward and let genuinely-new timestamps fall through to
 * "no preview" (never crash).
 *
 * Write-path choice (ADR-023): this reuses the SAME archiving path as a normal
 * write — archivePriorRun copies the prior report/tasks/screenshots/comments under
 * one unified stamp (the OLD run keeps its FULL frame set in screenshots-<stamp>/),
 * then we recreate screenshots/ carrying forward only the frames the revised tasks
 * still point at. report.md / tasks.json are byte-consistent with a normal write
 * (same renderMarkdown + stored upgrade + JSON layout); the only difference is the
 * screenshots payload comes from disk, not from /api/analyze, and a task may have
 * no frame.
 *
 * Frames are read into memory BEFORE archiving (archivePriorRun removes the live
 * screenshots/ folder), then re-materialized into the fresh screenshots/.
 */
export async function writeRevisedRunBrowser(
  sessionDir: FileSystemDirectoryHandle,
  result: AnalysisResult,
  sessionName: string,
): Promise<WriteReportBrowserOutput> {
  const validated = AnalysisResultSchema.parse(result);

  // 1. Snapshot the existing frames (name -> bytes) before anything is archived.
  const existing = await readScreenshots(sessionDir);

  // 2. Resolve each revised task's frame by the SAME timestamp→name algorithm used
  //    at initial write (deriveScreenshotNames). A derived name that exists in the
  //    prior frame set carries forward; one that doesn't → no frame for that task.
  const derived = deriveScreenshotNames(validated.tasks);
  const carriedNames = derived.map((name) => (existing.has(name) ? name : undefined));

  // 3. Archive the prior run (report/tasks/screenshots/comments) under one stamp —
  //    the old run keeps its OWN full frames in screenshots-<stamp>/ (ADR-023). A
  //    text-revise re-uses the SAME recording (TASK-71), so it isn't snapshotted.
  await archivePriorRun(sessionDir, false);

  // 4. Persist tasks.json in the STORED shape, pinning each task's carried frame
  //    (or none). upgrade tolerates an undefined name per task (TASK-60).
  const stored = upgrade(validated, () => carriedNames);

  const override = await readOverrideName(sessionDir);
  const markdown = renderMarkdown({
    title: sessionDisplayName({
      override,
      suggested: stored.suggested_name,
      folderName: sessionName,
    }),
    date: today(),
    relVideo: "recording.webm",
    result: stored,
  });

  await writeTextFile(sessionDir, REPORT_NAME, markdown);
  await writeTextFile(sessionDir, TASKS_NAME, JSON.stringify(stored, null, 2) + "\n");

  // 5. Recreate screenshots/ carrying forward only the still-referenced frames.
  const shotsDir = await sessionDir.getDirectoryHandle(SCREENSHOTS_DIR, { create: true });
  const written: string[] = [];
  for (const name of carriedNames) {
    if (!name) continue;
    const bytes = existing.get(name);
    if (!bytes) continue; // defensive — carriedNames only holds names existing had
    if (written.includes(name)) continue; // a name is written at most once
    await writeBytesFile(shotsDir, name, bytes);
    written.push(name);
  }

  return {
    reportName: REPORT_NAME,
    tasksJsonName: TASKS_NAME,
    screenshotNames: written,
  };
}

/** Read every PNG in screenshots/ into memory (name -> bytes). Missing folder → empty. */
async function readScreenshots(
  dir: FileSystemDirectoryHandle,
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const out = new Map<string, Uint8Array<ArrayBuffer>>();
  const shotsDir = await getDirectoryHandleOrNull(dir, SCREENSHOTS_DIR);
  if (!shotsDir) return out;
  for await (const entry of shotsDir.values()) {
    if (entry.kind !== "file") continue;
    const file = await entry.getFile();
    out.set(entry.name, new Uint8Array(await file.arrayBuffer()));
  }
  return out;
}

/**
 * Archive the current (about-to-be-superseded) run's artifacts under ONE unified
 * stamp (ADR-009 + ADR-023). Order matters: this runs BEFORE the fresh screenshots
 * are written, so screenshots/ still holds the prior run's frames here.
 *
 * The canonical run stamp is the report's last-modified second (when this run was
 * written), falling back to tasks.json, then now — a single source so report/tasks/
 * screenshots archive names match exactly. A same-second re-analysis gets a shared
 * "-N" suffix across all three (reserveRunStamp), never a per-artifact divergence.
 * First-ever run (nothing on disk) is a clean no-op.
 *
 * TASK-71 — `snapshotRecording` is set only by a re-run-with-video (the sole path
 * that can swap the session recording): it copies the CURRENT recording into the
 * superseded run's archive (recording-<stamp>.<ext>) under the same unified stamp,
 * so the older run's ZIP export keeps the exact video it analyzed. The copy leaves
 * recording.webm in place (the new run reads it); it's a copy, not a move.
 */
async function archivePriorRun(
  dir: FileSystemDirectoryHandle,
  snapshotRecording: boolean,
): Promise<void> {
  const reportHandle = await getFileHandleOrNull(dir, REPORT_NAME);
  const tasksHandle = await getFileHandleOrNull(dir, TASKS_NAME);
  const shotsDir = await getDirectoryHandleOrNull(dir, SCREENSHOTS_DIR);
  if (!reportHandle && !tasksHandle && !shotsDir) return; // nothing to supersede

  const baseMs = reportHandle
    ? (await reportHandle.getFile()).lastModified
    : tasksHandle
      ? (await tasksHandle.getFile()).lastModified
      : Date.now();
  const stamp = await reserveRunStamp(dir, archiveStamp(new Date(baseMs)));

  if (snapshotRecording) await snapshotPriorRecording(dir, stamp);
  if (reportHandle) await archiveFileTo(dir, REPORT_NAME, `report-${stamp}.md`);
  if (tasksHandle) await archiveFileTo(dir, TASKS_NAME, `tasks-${stamp}.json`);
  if (shotsDir) await archiveScreenshots(dir, shotsDir, screenshotsArchiveName(stamp));
  // TASK-56 — a re-analysis is a new run, so the prior run's AI baseline
  // (tasks.ai.json, if the user edited that run) is stale. Archive it under the
  // same unified stamp and drop the live copy (archiveFileTo removes the source),
  // so the new run starts with no baseline — it gets re-snapshotted lazily on the
  // next first edit. A no-op when no edit ever created a baseline. The archive name
  // (`tasks.ai-<stamp>.json`) stays out of the `tasks-<stamp>.json` run shape, so
  // run-history never miscounts it as a run.
  await archiveFileTo(dir, AI_BASELINE_NAME, `tasks.ai-${stamp}.json`);
  // TASK-60 — a new run is a new version, so the prior run's comments.json belongs
  // WITH that run: archive it under the same unified stamp and drop the live copy
  // (archiveFileTo removes the source), so an archived run pairs with the comments
  // it was revised from and the fresh run starts comment-free. A no-op when the
  // superseded run had no comments.
  await archiveFileTo(dir, COMMENTS_NAME, `comments-${stamp}.json`);
}

/**
 * Find a run stamp free across ALL THREE archive names (report-/tasks-/screenshots-),
 * suffixing "-N" until none is taken — so a rare same-second re-analysis keeps one
 * shared stamp for the whole run rather than letting the three artifacts diverge.
 */
async function reserveRunStamp(
  dir: FileSystemDirectoryHandle,
  base: string,
): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await runStampTaken(dir, candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

async function runStampTaken(
  dir: FileSystemDirectoryHandle,
  stamp: string,
): Promise<boolean> {
  if (await getFileHandleOrNull(dir, `report-${stamp}.md`)) return true;
  if (await getFileHandleOrNull(dir, `tasks-${stamp}.json`)) return true;
  if (await getDirectoryHandleOrNull(dir, screenshotsArchiveName(stamp))) return true;
  return false;
}

/**
 * Copy `srcName`'s bytes to `destName`, then remove the original so the stable
 * name is free for the fresh write. Read → write-new → remove (not move()) so it
 * uses only the well-established FS Access methods used across lib/filesystem.
 */
async function archiveFileTo(
  dir: FileSystemDirectoryHandle,
  srcName: string,
  destName: string,
): Promise<void> {
  const existing = await getFileHandleOrNull(dir, srcName);
  if (!existing) return;
  const bytes = new Uint8Array(await (await existing.getFile()).arrayBuffer());
  await writeBytesFile(dir, destName, bytes);
  await dir.removeEntry(srcName);
}

/**
 * Archive the live screenshots/ folder to `destName` (screenshots-<stamp>/). The
 * File System Access API has NO atomic directory rename, so we copy every frame
 * into the freshly-created stamped folder, then remove the live folder — the
 * caller recreates screenshots/ (create: true) when it writes the new run's PNGs.
 */
async function archiveScreenshots(
  dir: FileSystemDirectoryHandle,
  srcDir: FileSystemDirectoryHandle,
  destName: string,
): Promise<void> {
  const dest = await dir.getDirectoryHandle(destName, { create: true });
  for await (const entry of srcDir.values()) {
    if (entry.kind !== "file") continue;
    const bytes = new Uint8Array(await (await entry.getFile()).arrayBuffer());
    await writeBytesFile(dest, entry.name, bytes);
  }
  await dir.removeEntry(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * TASK-71 — copy the session's current recording into `recording-<stamp>.<ext>`
 * (the superseded run's archived video), preserving the real container extension
 * (webm/mp4). Unlike archiveFileTo this is a COPY: recording.webm stays put for
 * the new run. A no-op for an incomplete session with no recording (ADR-008).
 */
async function snapshotPriorRecording(
  dir: FileSystemDirectoryHandle,
  stamp: string,
): Promise<void> {
  const match = await findRecording(dir);
  if (!match) return;
  const bytes = new Uint8Array(await (await match.handle.getFile()).arrayBuffer());
  await writeBytesFile(dir, `recording-${stamp}${match.ext}`, bytes);
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

/** Write raw bytes to a file under `dir`, creating/overwriting it. The
 *  `Uint8Array<ArrayBuffer>` annotation (not the bare `Uint8Array`) pins the
 *  backing buffer so it satisfies the DOM BufferSource type under TS 5.7+. */
async function writeBytesFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
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

/** getDirectoryHandle, but NotFoundError → null instead of throwing. */
async function getDirectoryHandleOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await dir.getDirectoryHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}

/** Decode a base64 string (no data: prefix) to bytes. Browser atob, no Buffer. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
