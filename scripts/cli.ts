/**
 * Vellum Phase 1 glue command (TASK-8): one command, raw video -> full report.
 *
 *   npm run cli -- path/to/recording.webm
 *
 * This is the ONLY place that orchestrates the Phase 1 stages behind
 * ARCHITECTURE §Pipeline contracts:
 *
 *   uploadVideo (TASK-3) -> analyze (TASK-5)        ... or, for long recordings,
 *   analyzeLong (TASK-9)                            -> extractScreenshots (TASK-6)
 *     -> writeReport (TASK-7)
 *
 * Long-recording routing (TASK-9, AC#1): a file over the per-segment byte budget
 * (VELLUM_SEGMENT_MAX_BYTES) is sent through analyzeLong, which segments it with
 * overlap, carries a running summary between segments, and remaps timestamps back
 * to the original — returning the SAME AnalysisResult shape as analyze(), so the
 * stages below are identical either way. The routing lives HERE because the
 * contract names the glue as the orchestrator of uploadVideo/analyzeLong, and
 * because uploadVideo deliberately rejects >2 GB files: a long recording must
 * bypass it, which only the glue can decide. Screenshots are always extracted
 * from the original recording (not the throwaway segments), so global timestamps
 * resolve against the full-length video.
 *
 * The one new seam it owns is converting each task's "mm:ss"
 * `screenshot_timestamp` to the seconds that extractScreenshots expects
 * (`mmssToSec`, single-sourced in the schema module that owns the format).
 *
 * Behaviors it is responsible for (TASK-8 acceptance criteria):
 *
 *   - Granular progress (AC#2/#5): uploading -> analyzing -> extracting N/M ->
 *     writing, as plain stdout lines (robust in non-TTY, matches the other
 *     scripts, never fights the dots uploadVideo prints).
 *
 *   - Error philosophy (AC#4, ARCHITECTURE §Error handling): fail loud with the
 *     cause, never a silent retry loop (the stages own their own at-most-one
 *     network-timeout retry). The expensive artifact is the Gemini result, so
 *     the moment analyze() returns we persist `tasks.json` — which is also the
 *     ADR-008 session marker, so a run that dies during extraction still leaves
 *     a recognizable (incomplete) session, not an empty folder. On any failure
 *     we print the cause, where the partial output is, and the exact command to
 *     retry by hand.
 *
 *   - Session folder per §Local storage layout: a timestamp-named folder under
 *     ./vellum-sessions/, with the recording COPIED in as recording.<ext> so the
 *     folder is self-contained (relative links in the report stay clean).
 *
 * Gemini-suggested folder renaming (the combo-naming step in §Local storage
 * layout) is intentionally NOT done here: the current AnalysisResult schema
 * carries no suggested name, so it would need a schema + prompt change — out of
 * TASK-8's scope. The folder keeps its timestamp name.
 */
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { uploadVideo, UploadError } from "../src/lib/gemini/upload";
import { analyze, AnalyzeError, PROMPT_VERSION } from "../src/lib/gemini/analyze";
import { analyzeLong } from "../src/lib/gemini/analyze-long";
import { maxSegmentBytes } from "../src/lib/ffmpeg/segment-video";
import { extractScreenshots } from "../src/lib/ffmpeg/extract-screenshots";
import { writeReport } from "../src/lib/report/write-report";
import { mmssToSec, type AnalysisResult } from "../src/lib/gemini/schema";

/** Where session folders are created. Kept simple (no flag) for v1. */
const SESSIONS_ROOT = path.resolve("vellum-sessions");
const TASKS_MARKER = "tasks.json";

async function main(): Promise<void> {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("Usage: npm run cli -- <path-to-video.webm|.mp4>");
    process.exit(2);
  }

  // --- Stages 1–2: upload + analyze (routing long recordings) -----------
  // Both the upload and the analysis fail loud with human-readable guidance,
  // and run BEFORE we create any folder so a bad key or a typo'd path never
  // leaves an orphan session directory behind. A recording over the segment
  // budget is routed through analyzeLong (TASK-9), which does its own per-segment
  // uploads; everything else takes the single uploadVideo -> analyze path.
  const result = await runAnalysis(videoPath);
  console.log(
    `  ✓ review_type: ${result.review_type} · ${result.tasks.length} task(s)`,
  );

  // Analysis succeeded -> commit to a session folder and copy the original
  // recording in so the folder is self-contained (§Local storage layout). The
  // copy is the ORIGINAL (not a segment): screenshots and the report link the
  // full-length video, which the remapped global timestamps point into.
  const sessionDir = await createSessionDir();
  const recordingName = `recording${path.extname(videoPath).toLowerCase()}`;
  const recordingPath = path.join(sessionDir, recordingName);
  await copyFile(videoPath, recordingPath);
  console.log(`  ✓ session: ${sessionDir}`);

  // Persist the expensive Gemini result IMMEDIATELY (error philosophy / AC#4):
  // a failure in extraction or report writing below must not throw this away.
  // This is the bare AnalysisResult, identical to what writeReport will write —
  // and the ADR-008 marker that makes this folder a recognizable session.
  const partialMarker = path.join(sessionDir, TASKS_MARKER);
  await writeFile(partialMarker, JSON.stringify(result, null, 2) + "\n", "utf8");

  // --- Stage 3: extract screenshots -------------------------------------
  // One call per task so progress is a real N/M counter and a mid-loop failure
  // leaves exactly the screenshots taken so far on disk. Two tasks pointing at
  // the same whole second resolve to the same filename; since the seek is by
  // that same integer second, the re-extraction is byte-for-byte identical —
  // the overwrite is idempotent, not data loss (timestamps are whole seconds
  // per the schema). screenshotPaths stays parallel to result.tasks.
  const screenshotsDir = path.join(sessionDir, "screenshots");
  const screenshotPaths: string[] = [];
  console.log(`\n[3/4] Extracting screenshots (${result.tasks.length}) …`);
  for (let i = 0; i < result.tasks.length; i += 1) {
    const task = result.tasks[i];
    const sec = mmssToSec(task.screenshot_timestamp);
    console.log(
      `  extracting ${i + 1}/${result.tasks.length}  ` +
        `(${task.screenshot_timestamp} → ${sec}s)  ${task.title}`,
    );
    const [shotPath] = await extractScreenshots(recordingPath, [sec], screenshotsDir);
    screenshotPaths.push(shotPath);
  }

  // --- Stage 4: write report --------------------------------------------
  // Drop our own partial marker first so writeReport's ADR-009 archiving doesn't
  // mistake it for a prior version and leave a spurious tasks-<ts>.json. The
  // session dir is fresh this run, so there is nothing else to preserve.
  await rm(partialMarker, { force: true });
  console.log("\n[4/4] Writing report …");
  const { reportPath, tasksJsonPath } = await writeReport({
    sessionDir,
    videoPath: recordingPath,
    result,
    screenshotPaths,
  });

  console.log("\n✓ Done.");
  console.log(`  report:      ${reportPath}`);
  console.log(`  tasks.json:  ${tasksJsonPath}`);
  console.log(`  screenshots: ${screenshotPaths.length} in ${screenshotsDir}`);
  console.log(`  session:     ${sessionDir}`);
}

/**
 * Stages 1–2: produce the AnalysisResult, routing by file size. A recording over
 * the per-segment byte budget (VELLUM_SEGMENT_MAX_BYTES) goes through analyzeLong
 * — which segments, uploads each part, and remaps timestamps to the original;
 * everything else takes the single uploadVideo -> analyze path. Either way the
 * return shape is the same, so the caller is identical downstream.
 */
async function runAnalysis(videoPath: string): Promise<AnalysisResult> {
  const { size } = await stat(videoPath);
  if (size > maxSegmentBytes()) {
    const gb = (size / 1024 / 1024 / 1024).toFixed(2);
    console.log(
      `[1-2/4] Long recording (${gb} GB) — segmenting + analyzing (prompt ${PROMPT_VERSION}) …`,
    );
    return analyzeLong(videoPath);
  }

  console.log(`[1/4] Uploading ${videoPath} …`);
  const { fileUri } = await uploadVideo(videoPath);
  console.log("\n  ✓ uploaded, file is ACTIVE");

  console.log(`\n[2/4] Analyzing (prompt ${PROMPT_VERSION}) …`);
  return analyze(fileUri);
}

/**
 * Create a fresh timestamp-named session folder under SESSIONS_ROOT
 * (`2026-06-30-14-30-22/`), suffixing `-2`, `-3`… on the rare same-second
 * collision. Returns the absolute path.
 */
async function createSessionDir(): Promise<string> {
  const base = timestampName();
  let dir = path.join(SESSIONS_ROOT, base);
  let n = 2;
  while (existsSync(dir)) {
    dir = path.join(SESSIONS_ROOT, `${base}-${n}`);
    n += 1;
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Local-time "YYYY-MM-DD-HH-MM-SS" — filename-safe and sorts by recency. */
function timestampName(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `-${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
  );
}

main().catch((err: unknown) => {
  // The typed stage errors already carry user-facing guidance — print verbatim,
  // no stack. Everything else fails loud with the full error (error philosophy).
  if (err instanceof UploadError || err instanceof AnalyzeError) {
    console.error(`\n✗ ${err.message}`);
  } else {
    console.error("\n✗ Pipeline failed:");
    console.error(err);
  }

  // AC#4: point at what survived and how to retry. Anything produced before the
  // failure (recording.webm, a persisted tasks.json, partial screenshots) is
  // still on disk under the session folder. Retry is a manual re-run — no
  // automatic loop. We don't reach into module state here; the guidance is
  // generic on purpose so it holds wherever the failure happened.
  console.error(
    "\nNo silent retry. Whatever completed is saved under ./vellum-sessions/" +
      " (the latest folder). To retry, re-run:\n" +
      `  npm run cli -- ${process.argv[2] ?? "<video>"}`,
  );
  process.exit(1);
});
