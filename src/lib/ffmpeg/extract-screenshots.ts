import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getFfmpegPath } from "./binary";
import { probeDurationSec } from "./probe-duration";

/**
 * Extract one PNG frame per requested timestamp from a video.
 *
 * Timestamps are in SECONDS — the glue layer (TASK-8) converts the Gemini
 * "mm:ss" strings to seconds before calling this (ARCHITECTURE §Pipeline
 * contracts). Output is PNG at the source (recording) resolution — no scaling —
 * for sharp UI edges (ARCHITECTURE §Screenshot strategy). We spawn the
 * ffmpeg-static binary directly, one short subprocess per frame, with no
 * wrapper library (CLAUDE.md §ffmpeg-static).
 *
 * Out-of-range timestamps are clamped into the video, not treated as errors:
 * a slightly-off Gemini timestamp past the end still yields the last usable
 * frame rather than crashing the pipeline (CLAUDE.md ambiguity example, AC#4).
 *
 * @returns absolute paths of the generated PNGs, parallel to `timestampsSec`.
 */
export async function extractScreenshots(
  videoPath: string,
  timestampsSec: number[],
  outDir: string,
): Promise<string[]> {
  if (!existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }
  await mkdir(outDir, { recursive: true });

  const ffmpeg = getFfmpegPath();
  const durationSec = await probeDurationSec(videoPath);

  // Resolve every requested timestamp to a clamped seek point and a
  // collision-free filename up front, so parallel jobs never race over a name.
  const usedNames = new Set<string>();
  const jobs = timestampsSec.map((requested) => {
    const seekSec = clampToRange(requested, durationSec);
    const fileName = uniqueName(secondsToName(seekSec), usedNames);
    return { seekSec, outPath: path.resolve(outDir, fileName) };
  });

  // Bounded concurrency: a handful of short ffmpeg processes at a time keeps
  // 10+ timestamps fast without spawning an unbounded swarm.
  const CONCURRENCY = 4;
  const results: string[] = new Array(jobs.length);
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (job, j) => {
        await extractOne(ffmpeg, videoPath, job.seekSec, job.outPath);
        results[i + j] = job.outPath;
      }),
    );
  }
  return results;
}

/** Clamp a requested second into [0, duration); never seek past the end. */
function clampToRange(seconds: number, durationSec: number | null): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  if (durationSec !== null && seconds >= durationSec) {
    // Step just inside the last frame instead of seeking past the end.
    return Math.max(0, durationSec - 0.1);
  }
  return seconds;
}

/** "frame-MM-SS.png", zero-padded (e.g. 72.4s -> "frame-01-12.png"). */
function secondsToName(seconds: number): string {
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `frame-${mm}-${ss}.png`;
}

/** Two timestamps in the same second would collide — suffix the later one. */
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

/** Extract a single frame at `seekSec` to `outPath` as PNG. */
function extractOne(
  ffmpeg: string,
  videoPath: string,
  seekSec: number,
  outPath: string,
): Promise<void> {
  // Input-side -ss (before -i) = fast keyframe seek then decode to the exact
  // timestamp; accurate to well within the 0.5s budget. No -vf scale, so the
  // PNG stays at the source (recording) resolution.
  const args = [
    "-nostdin",
    "-y",
    "-ss",
    seekSec.toFixed(3),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-update",
    "1",
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
          `ffmpeg failed to extract frame at ${seekSec}s (exit ${code}).\n${tail(stderr)}`,
        ),
      );
    });
  });
}

/** Last few lines of ffmpeg stderr — enough to diagnose, not a wall of text. */
function tail(text: string, lines = 8): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
