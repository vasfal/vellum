// TASK-34 — read a session's rendered report for the Markdown view.
//
// The session view normally renders tasks from tasks.json. The Tasks/Markdown
// switcher instead shows the on-disk report.md exactly as it reads on GitHub /
// Obsidian. report.md is authored by render-report.ts (ADR-015) and references
// its screenshots with RELATIVE links — `![title](screenshots/frame-MM-SS.png)`.
// A browser won't resolve those relative paths against a File System Access
// handle, so we load the whole screenshots/ folder into a filename→File map and
// let the Markdown renderer swap each <img src> for the matching object URL.
//
// This is the read-side companion to write-report-browser.ts; it reads the file
// bytes only, never re-parses the Markdown structure — react-markdown does that.

/**
 * The bytes needed to render one session's report: the raw Markdown text and
 * every screenshot file keyed by its on-disk filename (e.g. "frame-01-23.png").
 */
export interface ReportContent {
  markdown: string;
  /** filename → File for everything under screenshots/. Empty if the folder is absent. */
  screenshots: Map<string, File>;
}

/**
 * Load a session's report Markdown + its screenshots. `reportFile` defaults to
 * the live `report.md`; TASK-51 passes an ADR-009 archive name (`report-<stamp>.md`)
 * to show an OLDER run's report. Throws if the session folder or that file is
 * missing — the caller only asks for this when the file is known to exist, and
 * surfaces a throw as an error state.
 *
 * Screenshots are read from `screenshotsDir` (default the live `screenshots/`).
 * Viewing an archived run (TASK-51 / ADR-023) passes that run's `screenshots-<stamp>/`
 * so it shows its OWN frames. A legacy run archived before Option B has no such
 * folder → the map is empty → images degrade to "no preview" (ADR-013).
 */
export async function loadReportContent(
  workspace: FileSystemDirectoryHandle,
  name: string,
  reportFile: string = "report.md",
  screenshotsDir: string = "screenshots",
): Promise<ReportContent> {
  const dir = await workspace.getDirectoryHandle(name);
  const reportHandle = await dir.getFileHandle(reportFile);
  const markdown = await (await reportHandle.getFile()).text();
  const screenshots = await loadScreenshotMap(dir, screenshotsDir);
  return { markdown, screenshots };
}

/** Every file under `screenshotsDir`, keyed by filename. Missing folder → empty map. */
async function loadScreenshotMap(
  dir: FileSystemDirectoryHandle,
  screenshotsDir: string,
): Promise<Map<string, File>> {
  const map = new Map<string, File>();
  let shotsDir: FileSystemDirectoryHandle;
  try {
    shotsDir = await dir.getDirectoryHandle(screenshotsDir);
  } catch (err) {
    if (isNotFound(err)) return map; // no such folder → images just won't resolve
    throw err;
  }
  for await (const entry of shotsDir.values()) {
    if (entry.kind === "file") {
      map.set(entry.name, await entry.getFile());
    }
  }
  return map;
}

/**
 * The screenshots-map key for a Markdown image `src`. report.md links are
 * relative POSIX paths ("screenshots/frame-01-23.png"), possibly percent-encoded
 * (encodeLink in render-report.ts) and possibly carrying a ?query/#hash — none of
 * which appear in Vellum's own output, but we normalize defensively. We resolve
 * by BASENAME so the map (keyed by bare filename) matches regardless of the
 * leading "screenshots/" segment.
 */
export function screenshotKeyFromSrc(src: string): string {
  const withoutQuery = src.split(/[?#]/)[0];
  const last = withoutQuery.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last; // malformed percent-encoding → use the raw segment
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}
