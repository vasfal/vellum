// TASK-18 — pair each task back to its extracted screenshot file.
//
// tasks.json stores each task's `screenshot_timestamp` ("mm:ss") but NOT the
// screenshot filename. The glue layer (TASK-8 → extractScreenshots) derives the
// name from that timestamp: secondsToName(seconds) → "frame-MM-SS.png", walking
// the tasks in array order and suffixing "-2", "-3"… when two tasks land on the
// same whole second (uniqueName). To recover which file belongs to which task we
// replay that exact algorithm over the same tasks in the same order — deriving a
// name per task in isolation would mishandle the collision suffix (both
// same-second tasks would resolve to the un-suffixed name and one would be
// mismatched). This module is the read-side mirror of extract-screenshots.ts;
// the two naming helpers below must stay in sync with it.
//
// Client-safe on purpose: extract-screenshots.ts can't be imported here (it
// pulls in node:child_process / ffmpeg), so we re-derive the tiny name helpers.

import { mmssToSec, type VellumTask } from "@/lib/gemini/schema";
import type { StoredVellumTask } from "@/lib/gemini/stored";

/**
 * The screenshot filename each task maps to, parallel to `tasks` and in the same
 * order. Mirrors extractScreenshots' naming exactly (secondsToName + same-second
 * "-N" suffix), walked in task order.
 *
 * ADR-025 narrows this function's role: it is the initial-write NAMER (via
 * stored.upgrade) and the legacy read fallback (resolveScreenshotNames below) —
 * NOT the primary read-side pairing anymore. A stored task carries its resolved
 * `screenshot` filename, so reorder/add/delete no longer replays this (the replay
 * was order-dependent). It still assumes tasks are walked in array order.
 *
 * CAVEAT: extractScreenshots clamps a timestamp past the video's end to the last
 * frame *before* naming the file. We don't have the recording duration here, so a
 * task whose `screenshot_timestamp` sits past the end would derive a name the file
 * doesn't actually use. In practice `screenshot_timestamp` is always within the
 * recording (the frame was extracted from it), and a miss degrades to "no
 * preview" (loadScreenshots returns null) rather than crashing.
 */
export function deriveScreenshotNames(tasks: VellumTask[]): string[] {
  const used = new Set<string>();
  return tasks.map((task) =>
    uniqueName(secondsToName(mmssToSec(task.screenshot_timestamp)), used),
  );
}

/**
 * Resolve the frame filename for each STORED task (ADR-025): the primary source
 * is the task's own recorded `screenshot`. A stored task that somehow lacks one
 * (a legacy task that missed the in-memory upgrade, or a human task) falls back to
 * the derived name IF it has a screenshot_timestamp — else it has no frame (null).
 *
 * The fallback derivation reserves every already-stored name first, so a derived
 * name never collides with a filename another task already owns.
 */
function resolveScreenshotNames(tasks: StoredVellumTask[]): (string | null)[] {
  const used = new Set<string>();
  for (const task of tasks) if (task.screenshot) used.add(task.screenshot);

  return tasks.map((task) => {
    if (task.screenshot) return task.screenshot; // stored name — the ADR-025 pairing
    if (task.screenshot_timestamp == null) return null; // no frame to resolve
    return uniqueName(secondsToName(mmssToSec(task.screenshot_timestamp)), used);
  });
}

/**
 * Load the screenshot File for each task from the session's `screenshots/`
 * folder, parallel to `tasks`. Pairs by the STORED `task.screenshot` filename
 * (ADR-025) — position-independent, so it survives a reorder/add/delete — with a
 * derive-by-replay fallback for a task that lacks a stored name. A task whose file
 * is missing (or the whole folder is absent — an older or partial session) gets
 * `null`, so the view shows a graceful placeholder instead of crashing (AC#5).
 */
export async function loadScreenshots(
  sessionDir: FileSystemDirectoryHandle,
  tasks: StoredVellumTask[],
): Promise<(File | null)[]> {
  if (tasks.length === 0) return [];

  let shotsDir: FileSystemDirectoryHandle;
  try {
    shotsDir = await sessionDir.getDirectoryHandle(SCREENSHOTS_DIR);
  } catch (err) {
    // No screenshots/ folder at all → every task simply has no preview.
    if (isNotFound(err)) return tasks.map(() => null);
    throw err;
  }

  const names = resolveScreenshotNames(tasks);
  return Promise.all(
    names.map((name) => (name ? getFileOrNull(shotsDir, name) : null)),
  );
}

const SCREENSHOTS_DIR = "screenshots";

/** "frame-MM-SS.png", zero-padded. Mirror of extract-screenshots.ts secondsToName. */
function secondsToName(seconds: number): string {
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `frame-${mm}-${ss}.png`;
}

/** Same-second collision → "frame-MM-SS-2.png". Mirror of extract-screenshots.ts uniqueName. */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const stem = base.replace(/\.png$/, "");
  let n = 2;
  while (used.has(`${stem}-${n}.png`)) n += 1;
  const candidate = `${stem}-${n}.png`;
  used.add(candidate);
  return candidate;
}

/** getFile for a name, or null if it isn't there. Other errors propagate. */
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
