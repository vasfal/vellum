import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { uploadVideo } from "./upload";
import { analyzeSegment, buildRun, type GeminiCall } from "./analyze";
import {
  mmssToSec,
  secToMmss,
  type AnalysisLanguage,
  type AnalysisMode,
  type AnalysisResult,
  type ReviewType,
  type VellumTask,
} from "./schema";
import {
  budgetExceedsGeminiLimit,
  cutSegment,
  maxSegmentBytes,
  planSegments,
  probeDurationSec,
  type Segment,
  type SegmentPlan,
} from "../ffmpeg/segment-video";

/**
 * Stage 2-long of the Phase 1 pipeline (ARCHITECTURE §Pipeline contracts):
 *
 *   analyzeLong(videoPath): Promise<AnalysisResult>
 *
 * Same OUTPUT contract as analyze(); segmentation and global-timestamp remapping
 * are hidden behind this boundary. Note the input differs from analyze(): this
 * takes a LOCAL videoPath (not a fileUri), because it must cut the file locally
 * before uploading each segment.
 *
 * What it does (ARCHITECTURE §Recording defaults — long recordings):
 *   1. Probe duration, plan overlapping segments under the byte budget.
 *   2. For each segment, in order: cut it (stream-copy), upload it, analyze it
 *      seeded with a running summary of everything earlier segments established.
 *   3. Shift each segment's LOCAL "mm:ss" timestamps to the ORIGINAL recording's
 *      timeline (offset = segment start), dropping overlap-zone duplicates.
 *   4. Merge into one AnalysisResult.
 *
 * Segmentation is a NORMAL path, not an error state (AC#4): a long recording is
 * expected here and is logged as routine progress, never thrown.
 *
 * Logging: this is a multi-minute operation with real sub-steps, so it prints
 * progress (like uploadVideo's dots), matching the glue command's plain-stdout
 * style so the segmentation + remap are visible in a run.
 */
export async function analyzeLong(
  videoPath: string,
  // TASK-46 — threaded per-segment: in "economy" each segment is a single
  // combined call. Default "thorough" keeps the long path byte-identical.
  mode: AnalysisMode = "thorough",
  // TASK-49 — output language, threaded into every segment's prompts and the
  // merged run block. "en" (default) keeps the long path byte-identical.
  language: AnalysisLanguage = "en",
  // TASK-50 — the chosen PRIMARY model, threaded into every segment so an
  // override applies to long recordings too. undefined → the built-in MODEL
  // (unchanged behavior).
  model?: string,
  // TASK-60 — the re-run-with-video revise context (prior tasks + comments),
  // prepended to every segment's prompt so the reviewer's feedback grounds the
  // whole recording. undefined for a plain analysis (byte-identical to before).
  reviseContext?: string,
): Promise<AnalysisResult> {
  const { size } = await stat(videoPath);

  const maxBytes = maxSegmentBytes();
  if (budgetExceedsGeminiLimit(maxBytes)) {
    // Not fatal — segments could still come in under 2 GB — but warn loudly:
    // a budget over the hard limit risks a segment Gemini will reject.
    console.warn(
      `  ! VELLUM_SEGMENT_MAX_BYTES is above Gemini's 2 GB limit; segments may be rejected.`,
    );
  }

  const duration = await probeDurationSec(videoPath);
  if (duration === null) {
    throw new Error(
      `Could not read the duration of "${videoPath}" (ffmpeg printed no Duration line). ` +
        `The file may be corrupt or an unsupported container.`,
    );
  }

  const plan = planSegments(size, duration, { maxBytes });
  logPlan(plan, size, maxBytes);

  const tmpDir = await mkdtemp(path.join(tmpdir(), "vellum-seg-"));
  try {
    return await analyzePlan(videoPath, plan, tmpDir, mode, language, model, reviseContext);
  } finally {
    // Segments are throwaway; clean them up regardless of success or failure.
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Run every planned segment in order, threading the running summary forward. */
async function analyzePlan(
  videoPath: string,
  plan: SegmentPlan,
  tmpDir: string,
  mode: AnalysisMode,
  language: AnalysisLanguage,
  model: string | undefined,
  reviseContext: string | undefined,
): Promise<AnalysisResult> {
  const captured: VellumTask[] = [];
  const reviewTypes: ReviewType[] = [];
  // TASK-45 — every segment's Gemini calls, accumulated so the whole recording's
  // token usage + cost is summed into one `run` block on the merged result.
  const calls: GeminiCall[] = [];
  let firstOverview = "";
  // The whole recording gets ONE name; segment 0 saw the opening, so its
  // suggested_name is the most representative (TASK-22). undefined → the
  // timestamp folder name is the fallback downstream.
  let firstSuggestedName: string | undefined;

  for (const segment of plan.segments) {
    const label = `[segment ${segment.index + 1}/${plan.segments.length}]`;
    console.log(
      `\n  ${label} ${secToMmss(segment.startSec)}–` +
        `${secToMmss(segment.startSec + segment.durationSec)} of the original …`,
    );

    // 1. Cut this segment out of the original (stream-copy, throwaway file).
    const segPath = path.join(tmpDir, `segment-${segment.index}.webm`);
    await cutSegment(videoPath, segment, segPath);

    // 2. Upload it (uploadVideo validates + waits for ACTIVE, same as the short path).
    process.stdout.write(`    uploading `);
    const { fileUri } = await uploadVideo(segPath);
    console.log(` ✓`);

    // 3. Analyze it, seeded with what earlier segments established. Segment 0 has
    //    no running summary yet; later segments carry one. TASK-60: when this is a
    //    re-run-with-video, the revise context prepends to whatever's there (and
    //    is the sole context for segment 0), so the feedback grounds every segment.
    const runningSummary =
      segment.index === 0
        ? undefined
        : buildRunningSummary(firstOverview, captured, plan.overlapSec);
    const priorContext = prependContext(reviseContext, runningSummary);
    const { result: segResult, calls: segCalls } = await analyzeSegment(
      fileUri,
      priorContext,
      undefined, // mimeType — segments are always re-encoded WebM (the default).
      undefined, // signal — analyzeLong doesn't forward abort yet (see route.ts).
      mode,
      language,
      model,
    );
    calls.push(...segCalls);

    if (segment.index === 0) {
      firstOverview = segResult.overview;
      firstSuggestedName = segResult.suggested_name;
    }
    reviewTypes.push(segResult.review_type);

    // 4. Shift local timestamps onto the original timeline, drop overlap dupes.
    const remapped = remapTasks(segResult.tasks, segment);
    let added = 0;
    for (const task of remapped) {
      if (!isDuplicate(task, captured, plan.overlapSec)) {
        captured.push(task);
        added += 1;
      }
    }
    console.log(
      `    ${segResult.tasks.length} task(s) found, ${added} new after overlap dedup`,
    );
  }

  // Chronological by global timestamp (segments already run in order, but dedup
  // and within-segment ordering can leave minor gaps — sort to be safe).
  captured.sort((a, b) => mmssToSec(a.timestamp) - mmssToSec(b.timestamp));

  return {
    review_type: majorityReviewType(reviewTypes),
    overview: firstOverview,
    suggested_name: firstSuggestedName,
    tasks: captured,
    // One run block for the whole recording: usage summed across every segment's
    // calls (TASK-45), recording the real mode (TASK-46) + language (TASK-49).
    run: buildRun(calls, mode, language),
  };
}

/**
 * Shift one segment's LOCAL timestamps to the ORIGINAL recording's timeline.
 * A local second is clamped into [0, durationSec] first, so a Gemini timestamp
 * that drifts past the segment's end never maps beyond the segment's real span
 * (the screenshot stage clamps again against the full recording's true end).
 */
/**
 * Prepend the TASK-60 revise context (if any) to a segment's running summary.
 * With no revise context the summary is returned untouched (plain long-video path,
 * byte-identical to before). With no summary (segment 0) the revise context alone
 * is the context. Same "---" separator withContext uses, so the prompt reads
 * consistently whichever pieces are present.
 */
function prependContext(
  reviseContext: string | undefined,
  summary: string | undefined,
): string | undefined {
  if (!reviseContext) return summary;
  if (!summary) return reviseContext;
  return `${reviseContext}\n\n---\n\n${summary}`;
}

// Exported (with buildRunningSummary below) so the two pieces of pure TASK-9
// logic — remap and the running summary — can be exercised deterministically
// without a Gemini call, since a synthetic test clip yields no real tasks.
export function remapTasks(tasks: VellumTask[], segment: Segment): VellumTask[] {
  const toGlobal = (mmss: string): string => {
    const local = Math.min(Math.max(mmssToSec(mmss), 0), segment.durationSec);
    return secToMmss(local + segment.startSec);
  };
  return tasks.map((task) => ({
    ...task,
    timestamp: toGlobal(task.timestamp),
    screenshot_timestamp: toGlobal(task.screenshot_timestamp),
  }));
}

/**
 * The running summary carried into the NEXT segment (local synthesis — no extra
 * Gemini call). It tells the model what's already established and, crucially,
 * that this video is one segment of a larger recording whose first seconds
 * overlap the previous one, so it should not re-report items already captured
 * and should emit timestamps local to its own 0-based clip.
 */
export function buildRunningSummary(
  overview: string,
  captured: VellumTask[],
  overlap: number,
): string {
  // Cap the carried list so a very long recording doesn't grow the prompt
  // unbounded; the most recent items are the ones the overlap could duplicate.
  const recent = captured.slice(-40);
  const lines = [
    "CONTEXT FROM EARLIER SEGMENTS OF THIS RECORDING (background — already analyzed, do not redo):",
    `Overview so far: ${overview}`,
    "",
    "Items already captured (timestamps are in the FULL original recording):",
    ...recent.map((t) => `- [${t.timestamp}] ${t.title} (${t.category})`),
    "",
    "IMPORTANT: The video below is ONE SEGMENT of a longer recording, not the whole",
    `thing. Its first ~${overlap}s overlap the end of the previous segment. Do NOT`,
    "re-report any item already listed above. Emit timestamps LOCAL to the video",
    "below, starting at 00:00 — the segments are stitched back together afterwards.",
  ];
  if (recent.length === 0) {
    // Defensive: earlier segments found nothing actionable. Keep the framing.
    lines.splice(3, 1, "(no actionable items captured yet)");
  }
  return lines.join("\n");
}

/**
 * Two segments share an overlap window, so the same item can surface in both.
 * Treat a task as a duplicate when an already-captured task has the same title
 * (normalized) AND a global timestamp within the overlap window (plus a small
 * margin for the ±5–15 s timestamp drift ADR-002 tolerates). The prompt already
 * asks the model not to repeat itself; this is the safety net.
 */
function isDuplicate(
  task: VellumTask,
  captured: VellumTask[],
  overlap: number,
): boolean {
  const title = normalizeTitle(task.title);
  const sec = mmssToSec(task.timestamp);
  const window = overlap + 15; // overlap zone plus ADR-002 drift margin
  return captured.some(
    (c) =>
      normalizeTitle(c.title) === title &&
      Math.abs(mmssToSec(c.timestamp) - sec) <= window,
  );
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Most common review_type across segments; ties resolve to the first segment's. */
function majorityReviewType(types: ReviewType[]): ReviewType {
  const counts = new Map<ReviewType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = types[0];
  let bestCount = 0;
  // Iterate types in segment order so the first segment wins any tie.
  for (const t of types) {
    const c = counts.get(t)!;
    if (c > bestCount) {
      best = t;
      bestCount = c;
    }
  }
  return best;
}

function logPlan(plan: SegmentPlan, sizeBytes: number, maxBytes: number): void {
  const gb = (sizeBytes / 1024 / 1024 / 1024).toFixed(2);
  const budgetMb = (maxBytes / 1024 / 1024).toFixed(0);
  console.log(
    `  Long recording: ${gb} GB over the ${budgetMb} MB segment budget — ` +
      `splitting into ${plan.segments.length} segment(s) ` +
      `(~${plan.overlapSec}s overlap). This is the normal path for long videos.`,
  );
}
