/**
 * render-report — the SINGLE SOURCE OF TRUTH for the report.md format (ADR-015).
 *
 * Every function here is PURE and client-safe: no Node built-in imports, no file I/O,
 * no filesystem-path APIs. It turns an AnalysisResult (plus already-relative,
 * forward-slash paths to the recording and screenshots) into the exact Markdown
 * string that lands on disk, and owns the shared naming/formatting helpers
 * (archive stamps, title humanizing, link encoding).
 *
 * Two writeReport variants consume this module so the format lives in ONE place
 * (ADR-014 called the two variants "kept in sync by comments, not a shared
 * module"; ADR-015 narrows that — the FORMAT is now shared here, only the file-I/O
 * halves differ):
 *   - Node:    src/lib/report/write-report.ts   (CLI, node fs → absolute paths)
 *   - Browser: src/lib/filesystem/write-report-browser.ts (app, FS Access handle)
 *
 * The path helpers assume POSIX ("/") input. That's what the browser produces
 * natively and what the Node side normalizes to via toPosix() before rendering,
 * so the Markdown is portable across OSes (relative links survive a folder move).
 */
import type { ReviewType } from "@/lib/gemini/schema";
import type {
  StoredAnalysisResult,
  StoredVellumTask,
} from "@/lib/gemini/stored";

/** Friendly labels for the review_type axis (humanizing the raw enum reads off). */
export const REVIEW_TYPE_LABELS: Record<ReviewType, string> = {
  ui_design: "UI Design",
  dev_vs_design: "Dev vs Design",
  documentation: "Documentation",
  mixed: "Mixed",
  other: "Other",
};

export interface RenderReportInput {
  /** Humanized session title (see humanizeTitle). */
  title: string;
  /** Report date "YYYY-MM-DD" (see today). */
  date: string;
  /** Relative, forward-slash path to the recording (e.g. "recording.webm"). */
  relVideo: string;
  /**
   * The stored result (ADR-025). Each task carries its resolved `screenshot`
   * filename, so the report sources per-task frames from that field instead of a
   * parallel array — pairing follows the STORED name, never the array position, so
   * a later reorder/add/delete can't mis-pair (the ADR-013 replay was
   * order-dependent). The filename is resolved into a relative link against
   * SCREENSHOTS_DIR here — the single place the report format lives (ADR-015).
   */
  result: StoredAnalysisResult;
}

/**
 * Render the report. Plain CommonMark — no HTML, no renderer-specific syntax —
 * so it reads identically in VS Code preview, GitHub, and Obsidian.
 */
export function renderMarkdown(input: RenderReportInput): string {
  const { title, date, relVideo, result } = input;
  const reviewLabel = REVIEW_TYPE_LABELS[result.review_type];

  const header = [
    `# ${title}`,
    "",
    `**Review type:** ${reviewLabel} · **Date:** ${date} · ` +
      `**Recording:** [${posixBasename(relVideo)}](${encodeLink(relVideo)})`,
    "",
    result.overview,
  ];

  const body =
    result.tasks.length === 0
      ? ["", "---", "", "_No tasks were extracted from this recording._"]
      : result.tasks.flatMap((task, i) => renderTask(task, i));

  return header.concat(body).join("\n").trimEnd() + "\n";
}

/** One task = a numbered section: heading, screenshot, metadata, body, context. */
function renderTask(task: StoredVellumTask, index: number): string[] {
  const lines = ["", "---", "", `## ${index + 1}. ${task.title}`, ""];

  // Source the frame from the STORED filename (ADR-025), relative to the live
  // screenshots/ folder. A task with no stored frame (a human-added task with no
  // screenshot_timestamp — ADR-024) simply renders without an image.
  if (task.screenshot) {
    const relScreenshot = `${SCREENSHOTS_DIR}/${task.screenshot}`;
    lines.push(`![${task.title}](${encodeLink(relScreenshot)})`, "");
  }

  // One compact metadata line; timestamps in inline code so they read as code.
  lines.push(
    `**Discussed at** \`${task.timestamp}\` · ` +
      `**Visible at** \`${task.screenshot_timestamp}\` · ` +
      `**Category:** ${cap(task.category)} · ` +
      `**Priority:** ${cap(task.priority)}`,
    "",
    task.description,
    "",
    `> **Screen context:** ${task.screen_context}`,
  );

  return lines;
}

/** Spaces in a relative path break Markdown links unless percent-encoded. */
export function encodeLink(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The three inputs that resolve a session's effective name (TASK-22). The folder
 * itself always stays a timestamp (the File System Access API can't rename a
 * directory), so a pretty name is RESOLVED for display from these, in priority
 * order: a manual override > Gemini's suggestion > the folder name.
 */
export interface SessionNameParts {
  /** The user's manual rename (from the session's `name.txt` sidecar), if any. */
  override?: string | null;
  /** Gemini's `suggested_name` (from tasks.json), if any. */
  suggested?: string | null;
  /** The session folder name — a timestamp; the always-present fallback. */
  folderName: string;
}

/**
 * The session's effective RAW name: manual override > Gemini suggestion > folder
 * name. Used where the exact string matters (not the humanized display form).
 */
export function resolveSessionName({
  override,
  suggested,
  folderName,
}: SessionNameParts): string {
  const o = override?.trim();
  if (o) return o;
  const s = suggested?.trim();
  if (s) return s;
  return folderName;
}

/**
 * The human-facing name shown in the sidebar, the session header, and the report
 * title. A manual override is shown VERBATIM (the user chose those exact words); a
 * Gemini kebab suggestion is humanized ("onboarding-step-2-review" -> "Onboarding
 * Step 2 Review"); the timestamp folder fallback is left as-is — humanizing
 * "2026-06-30-20-00-26" into spaced digits reads worse than the raw timestamp.
 */
export function sessionDisplayName({
  override,
  suggested,
  folderName,
}: SessionNameParts): string {
  const o = override?.trim();
  if (o) return o;
  const s = suggested?.trim();
  if (s) return humanizeTitle(s);
  return folderName;
}

/** "onboarding-step-2-review" -> "Onboarding Step 2 Review". */
export function humanizeTitle(folderName: string): string {
  const words = folderName
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(" ") : folderName;
}

/** Today's local date as "YYYY-MM-DD" for the report header. */
export function today(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Local-time "YYYY-MM-DD-HHMMSS" — filename-safe, sorts lexicographically. */
export function archiveStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/** The live run's screenshot folder. Superseded runs are archived beside it (see
 *  screenshotsArchiveName). Single-sourced here so writers and readers agree. */
export const SCREENSHOTS_DIR = "screenshots";

/**
 * The per-run screenshots archive folder (Option B, ADR-023): "screenshots-<stamp>".
 * On a re-analysis the live "screenshots/" frames are moved here under the SAME
 * unified run stamp as that run's `report-<stamp>.md` / `tasks-<stamp>.json`, so
 * the three artifacts of one run pair by exact stamp on the read side. Shared by
 * both writers and the archived-run reader so the naming can't drift (ADR-015).
 */
export function screenshotsArchiveName(stamp: string): string {
  return `${SCREENSHOTS_DIR}-${stamp}`;
}

// --- Pure path string helpers (no Node path module) --------------------------------
// These replace path.sep/relative/basename so the module stays client-safe. They
// operate on POSIX paths; the Node caller relativizes against the Node path module first and
// hands us the result, the browser caller builds relative paths directly.

/** Normalize any path to forward slashes for portable Markdown links. */
export function toPosix(p: string): string {
  return p.split(/[\\/]+/).join("/");
}

/** Last path segment of a forward-slash path ("a/b/frame.png" -> "frame.png"). */
export function posixBasename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * POSIX equivalent of path.relative(fromDir, to): keep an already-relative `to`
 * as-is, otherwise express the absolute `to` relative to `fromDir`. On macOS/Linux
 * (posix) this is byte-identical to the Node path module — verified by the TASK-27 regression
 * against the calendar-review fixture. In Vellum's pipeline `to` is always a
 * descendant of `fromDir`, so the common case is a plain prefix strip; the ".."
 * fallback keeps it general.
 */
export function relativize(fromDir: string, to: string): string {
  if (!to.startsWith("/")) return to; // already relative — leave untouched
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let i = 0;
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i] === toParts[i]
  ) {
    i += 1;
  }
  const up = fromParts.slice(i).map(() => "..");
  const down = toParts.slice(i);
  return [...up, ...down].join("/");
}
