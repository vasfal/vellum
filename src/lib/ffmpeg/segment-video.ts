import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getFfmpegPath } from "./binary";

// Re-exported so this stage's consumers (analyze-long.ts) keep importing the
// probe from here, while the implementation lives in one shared module rather
// than being copied into each ffmpeg stage (TASK-23).
export { probeDurationSec } from "./probe-duration";

/**
 * Segmenting a long recording for the Gemini File API (TASK-9).
 *
 * The Gemini File API rejects files past ~2 GB, so a recording that long is cut
 * into overlapping segments, each analyzed on its own (ARCHITECTURE §Recording
 * defaults — long recordings). This module owns ONLY the ffmpeg side: planning
 * where the cuts go and producing the segment files. The orchestration (upload
 * each segment, carry a running summary, remap timestamps back to the original)
 * lives in analyze-long.ts.
 *
 * Cutting is stream-copy (`-c copy`), not re-encode: the segments are throwaway
 * inputs for Gemini and are never the source of the final screenshots (those
 * come from the original recording in the glue command), so segment quality does
 * not matter and a slow VP9 re-encode would only cost time. Copy snaps the cut
 * to the nearest keyframe at or before the requested start, so a segment may
 * begin slightly earlier than its nominal start; we treat the NOMINAL start as
 * the offset, which keeps timestamp drift within the ±5–15 s ADR-002 already
 * tolerates, and the per-segment overlap absorbs anything lost at the seam.
 */

/** One planned segment, in seconds against the ORIGINAL recording's timeline. */
export interface Segment {
  index: number; // 0-based
  startSec: number; // nominal start in the original recording (the remap offset)
  durationSec: number; // length of this segment
}

export interface SegmentPlan {
  segments: Segment[];
  totalDurationSec: number;
  overlapSec: number;
  /** True when the file fit in one piece (segments.length === 1). */
  single: boolean;
}

/** Gemini File API hard limit; segment budget defaults a little under it. */
const GEMINI_FILE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const DEFAULT_MAX_SEGMENT_BYTES = Math.floor(1.8 * 1024 * 1024 * 1024); // ~1.8 GB
const DEFAULT_OVERLAP_SEC = 12; // within the 10–15 s window (ARCHITECTURE)

/**
 * The byte budget per segment, also used by the glue command as the routing
 * threshold (a file over this is segmented). Configurable so segmentation can be
 * forced on a short clip in tests without a 1.8 h recording — set
 * VELLUM_SEGMENT_MAX_BYTES tiny and a 10 s clip splits into overlapping parts.
 */
export function maxSegmentBytes(): number {
  return readPositiveEnv("VELLUM_SEGMENT_MAX_BYTES", DEFAULT_MAX_SEGMENT_BYTES);
}

/** Overlap between adjacent segments, in seconds. Configurable for the same tests. */
export function overlapSec(): number {
  return readPositiveEnv("VELLUM_SEGMENT_OVERLAP_SEC", DEFAULT_OVERLAP_SEC);
}

/**
 * Plan the cuts. Segment length is derived from the file's MEASURED bitrate
 * (size / duration) so each segment lands under the byte budget regardless of
 * the actual encode. Segments advance by (segLen - overlap) and the last one
 * runs to the end. A file that already fits yields a single segment spanning the
 * whole recording (so analyzeLong on a small file behaves like analyze).
 */
export function planSegments(
  fileSizeBytes: number,
  totalDurationSec: number,
  opts?: { maxBytes?: number; overlap?: number },
): SegmentPlan {
  if (!(totalDurationSec > 0)) {
    throw new Error(
      `Cannot plan segments: video duration is ${totalDurationSec}s. ffmpeg could not read a usable Duration from the file.`,
    );
  }

  const maxBytes = opts?.maxBytes ?? maxSegmentBytes();
  const overlap = opts?.overlap ?? overlapSec();
  const bytesPerSec = fileSizeBytes / totalDurationSec;

  // Seconds of video that fit in the budget at the measured bitrate, capped at
  // the whole recording. Math.max(1, …) guards a pathological tiny budget so
  // segLen never collapses to 0.
  const segLenForBudget = Math.max(1, Math.floor(maxBytes / bytesPerSec));
  const segLen = Math.min(segLenForBudget, totalDurationSec);

  // Overlap must leave a positive forward step, else segments never advance.
  if (overlap >= segLen) {
    throw new Error(
      `Overlap (${overlap}s) must be smaller than the segment length (${segLen}s). ` +
        `Lower VELLUM_SEGMENT_OVERLAP_SEC or raise VELLUM_SEGMENT_MAX_BYTES.`,
    );
  }
  const step = segLen - overlap;

  const segments: Segment[] = [];
  let index = 0;
  for (let start = 0; ; start += step) {
    const durationSec = Math.min(segLen, totalDurationSec - start);
    segments.push({ index: index++, startSec: start, durationSec });
    // Stop once this segment already reaches the end of the recording.
    if (start + segLen >= totalDurationSec) break;
  }

  return {
    segments,
    totalDurationSec,
    overlapSec: overlap,
    single: segments.length === 1,
  };
}

/**
 * Cut one segment to `outPath` (a .webm) via stream-copy. `-ss` before `-i` is a
 * fast keyframe seek; `-avoid_negative_ts make_zero` rebases the output to start
 * at ~0 so Gemini reads the segment as a 0-based video and emits local "mm:ss".
 */
export function cutSegment(
  videoPath: string,
  segment: Segment,
  outPath: string,
): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const args = [
    "-nostdin",
    "-y",
    "-ss",
    segment.startSec.toFixed(3),
    "-i",
    videoPath,
    "-t",
    segment.durationSec.toFixed(3),
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    outPath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && existsSync(outPath)) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ffmpeg failed to cut segment ${segment.index} ` +
            `(${segment.startSec}s +${segment.durationSec}s, exit ${code}).\n${tail(stderr)}`,
        ),
      );
    });
  });
}

/** Warn (don't fail) if a misconfigured budget could exceed Gemini's hard limit. */
export function budgetExceedsGeminiLimit(maxBytes: number): boolean {
  return maxBytes > GEMINI_FILE_LIMIT_BYTES;
}

function readPositiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tail(text: string, lines = 8): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
