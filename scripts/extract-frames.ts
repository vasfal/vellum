/**
 * Smoke test for extractScreenshots() — pure local ffmpeg, no API key.
 *
 *   npm run extract
 *
 * Generates a short test video with ffmpeg-static, extracts frames at a few
 * in-range timestamps plus one past the end (the clamp path), then verifies
 * every PNG was written at the source resolution.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFfmpegPath } from "../src/lib/ffmpeg/binary";
import { extractScreenshots } from "../src/lib/ffmpeg/extract-screenshots";

const WIDTH = 1280;
const HEIGHT = 720;
const DURATION_SEC = 5;

async function main() {
  const ffmpeg = getFfmpegPath();
  const work = mkdtempSync(path.join(tmpdir(), "vellum-extract-"));
  const video = path.join(work, "test.webm");

  console.log(`Generating ${DURATION_SEC}s ${WIDTH}x${HEIGHT} VP9/Opus webm...`);
  const gen = spawnSync(
    ffmpeg,
    [
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${WIDTH}x${HEIGHT}:rate=30:duration=${DURATION_SEC}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${DURATION_SEC}`,
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "1M",
      "-c:a",
      "libopus",
      video,
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) {
    console.error(gen.stderr);
    throw new Error("Failed to generate test video");
  }
  console.log(" ✓", video);

  const outDir = path.join(work, "screenshots");
  const requested = [1, 2.5, 4, 99]; // 99s is past the 5s end -> clamp path
  console.log(
    `\nExtracting frames at [${requested.join(", ")}]s (99s is out of range)...`,
  );
  const paths = await extractScreenshots(video, requested, outDir);

  console.log(`\nGenerated ${paths.length} PNG(s):`);
  let allOk = true;
  for (const p of paths) {
    const size = statSync(p).size;
    const probe = spawnSync(ffmpeg, ["-nostdin", "-i", p], { encoding: "utf8" });
    const m = probe.stderr.match(/Video:\s*(png)[\s\S]*?(\d+)x(\d+)/);
    const ok =
      m !== null &&
      Number(m[2]) === WIDTH &&
      Number(m[3]) === HEIGHT &&
      size > 0;
    allOk = allOk && ok;
    console.log(
      `  ${ok ? "✓" : "✗"} ${path.basename(p)}  ${size} bytes  ${
        m ? `${m[1]} ${m[2]}x${m[3]}` : "UNREADABLE"
      }`,
    );
  }

  if (!allOk) {
    throw new Error("Some screenshots are missing / wrong format / wrong resolution");
  }
  console.log(
    `\nAll ${paths.length} screenshots are PNG at ${WIDTH}x${HEIGHT}. ✓`,
  );

  // AC#2 — 10+ timestamps in one call. 0.0..4.5s in 0.5s steps = 10 frames.
  const many = Array.from({ length: 10 }, (_, i) => i * 0.5);
  console.log(`\nAC#2 — extracting ${many.length} timestamps in one call...`);
  const manyOut = path.join(work, "many");
  const manyPaths = await extractScreenshots(video, many, manyOut);
  const allExist = manyPaths.every((p) => statSync(p).size > 0);
  console.log(
    `  ${allExist ? "✓" : "✗"} ${manyPaths.length} PNGs written: ${manyPaths
      .map((p) => path.basename(p))
      .join(", ")}`,
  );
  if (!allExist) throw new Error("AC#2: not every timestamp produced a PNG");

  console.log(`\nWork dir: ${work}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
