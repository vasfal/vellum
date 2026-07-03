import { spawn } from "node:child_process";
import { getFfmpegPath } from "./binary";

/**
 * Read a recording's duration in seconds, or null if it genuinely can't be read.
 *
 * ffmpeg-static bundles no ffprobe, so we lean on ffmpeg itself. Two strategies,
 * fast one first:
 *
 *  1. Banner probe — `ffmpeg -i <file>` (no output) exits non-zero but prints a
 *     "Duration: HH:MM:SS.ms" line. Instant. This is all a re-encoded file (one
 *     ffmpeg wrote) needs.
 *
 *  2. Decode-the-length fallback — MediaRecorder WebM has NO duration header, so
 *     the banner shows "Duration: N/A" and step 1 finds nothing (TASK-23). We
 *     then REMUX the file to the null muxer with `-c copy -f null -`: ffmpeg
 *     walks every packet and reports the last one's timestamp as `time=...`,
 *     which IS the duration. `-c copy` means demux-only (no VP9 decode), so this
 *     stays near-instant even on a 1.8 h recording — measured ~30 ms on a 17 s
 *     clip, and it does NOT grow with pixel count the way a full decode would.
 *
 * Used by both the screenshot stage (to clamp past-end Gemini timestamps) and the
 * segmentation stage (to plan cuts), so it lives in its own module rather than
 * being copied into each (it previously was, and only one copy would have been
 * fixed). The banner-vs-N/A difference is exactly why the calendar test file
 * worked before this fix and a raw recorder file did not: the former had been
 * re-encoded by ffmpeg (header written), the latter came straight from
 * MediaRecorder (no header).
 */
export function probeDurationSec(videoPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    runFfmpegStderr(["-nostdin", "-i", videoPath]).then((stderr) => {
      const fromBanner = parseDurationLine(stderr);
      if (fromBanner !== null) {
        resolve(fromBanner);
        return;
      }
      // No usable "Duration:" line (header-less recorder WebM) — decode the
      // real length by remuxing to null and reading the final packet time.
      runFfmpegStderr(["-nostdin", "-i", videoPath, "-c", "copy", "-f", "null", "-"])
        .then((decodeStderr) => resolve(parseLastProgressTime(decodeStderr)))
        .catch(() => resolve(null));
    }, () => resolve(null));
  });
}

/** Spawn ffmpeg and resolve with its full stderr (it exits non-zero here — fine). */
function runFfmpegStderr(args: string[]): Promise<string> {
  const ffmpeg = getFfmpegPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", () => resolve(stderr));
  });
}

/** "Duration: HH:MM:SS.ms" from the banner. null if absent or "Duration: N/A". */
function parseDurationLine(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * The LAST "time=HH:MM:SS.ms" ffmpeg prints while processing — the end of the
 * file when remuxing to null. ffmpeg emits this repeatedly as it advances, so we
 * take the final match. Early frames can momentarily print "time=N/A" or a
 * negative value before timestamps settle; the global scan + "take last" skips
 * those, and a never-positive result resolves to null rather than 0.
 */
function parseLastProgressTime(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (matches.length === 0) return null;
  const m = matches[matches.length - 1];
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return seconds > 0 ? seconds : null;
}
