/**
 * Smoke test for writeReport() (TASK-7) — pure local file generation, no API key.
 *
 *   npm run report
 *
 * Builds a fixture AnalysisResult, extracts real PNGs for it via TASK-6 (so the
 * screenshotPaths-parallel-to-tasks contract is exercised for real), writes the
 * report, then asserts every acceptance criterion:
 *   AC#1 report.md renders (printed for eyeballing in VS Code preview)
 *   AC#2 screenshot paths are relative
 *   AC#3 video link is relative
 *   AC#4 a second run ARCHIVES the prior report.md / tasks.json (manual edit kept)
 *   AC#5 tasks.json marker is written and round-trips through the schema
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFfmpegPath } from "../src/lib/ffmpeg/binary";
import { extractScreenshots } from "../src/lib/ffmpeg/extract-screenshots";
import { writeReport } from "../src/lib/report/write-report";
import { AnalysisResultSchema, mmssToSec, type AnalysisResult } from "../src/lib/gemini/schema";

const WIDTH = 1280;
const HEIGHT = 720;
const DURATION_SEC = 8;

const FIXTURE: AnalysisResult = {
  review_type: "ui_design",
  overview:
    "A walkthrough of the onboarding flow's second step. The reviewer flags " +
    "spacing inconsistencies, questions the copy, and praises the empty state.",
  tasks: [
    {
      timestamp: "00:03",
      screenshot_timestamp: "00:02",
      title: "Inconsistent padding on the primary CTA",
      description:
        "The Continue button uses 12px vertical padding while every other " +
        "primary button in the flow uses 16px. On screen it reads as visibly " +
        "shorter, breaking the rhythm of the form.",
      screen_context: "Onboarding step 2 — the profile details form.",
      category: "problem",
      priority: "high",
    },
    {
      timestamp: "00:05",
      screenshot_timestamp: "00:04",
      title: 'Reconsider the "Skip for now" wording',
      description:
        "The reviewer wonders aloud whether \"Skip for now\" undersells the " +
        "step. Worth A/B testing against \"I'll do this later\".",
      screen_context: "Same form, secondary action below the CTA.",
      category: "question",
      priority: "low",
    },
    {
      timestamp: "00:07",
      screenshot_timestamp: "00:06",
      title: "Empty state illustration lands well",
      description:
        "Praise: the empty-state illustration for an unfilled avatar is on " +
        "brand and immediately legible. Keep it.",
      screen_context: "Avatar upload area in its empty state.",
      category: "praise",
      priority: "med",
    },
  ],
};

function generateVideo(ffmpeg: string, out: string): void {
  const gen = spawnSync(
    ffmpeg,
    [
      "-nostdin", "-y",
      "-f", "lavfi", "-i", `testsrc=size=${WIDTH}x${HEIGHT}:rate=30:duration=${DURATION_SEC}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${DURATION_SEC}`,
      "-c:v", "libvpx-vp9", "-b:v", "1M", "-c:a", "libopus",
      out,
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) {
    console.error(gen.stderr);
    throw new Error("Failed to generate test video");
  }
}

function assert(cond: boolean, msg: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  const ffmpeg = getFfmpegPath();
  const work = mkdtempSync(path.join(tmpdir(), "vellum-report-"));

  // A realistic session folder name (post-Gemini-rename) so the title humanizes.
  const sessionDir = path.join(work, "onboarding-step-2-review");
  const video = path.join(sessionDir, "recording.webm");

  // mkdir the session dir by generating the video into it (ffmpeg won't mkdir).
  spawnSync("mkdir", ["-p", sessionDir]);
  console.log(`Generating ${DURATION_SEC}s test recording…`);
  generateVideo(ffmpeg, video);
  console.log(" ✓", video);

  // TASK-6: extract one PNG per task, parallel to FIXTURE.tasks.
  const timestampsSec = FIXTURE.tasks.map((t) => mmssToSec(t.screenshot_timestamp));
  const screenshotPaths = await extractScreenshots(
    video,
    timestampsSec,
    path.join(sessionDir, "screenshots"),
  );
  console.log(`\nExtracted ${screenshotPaths.length} screenshot(s) (absolute, from TASK-6).`);

  // --- First write -------------------------------------------------------
  console.log("\n--- First writeReport ---");
  const out = await writeReport({
    sessionDir,
    videoPath: video,
    result: FIXTURE,
    screenshotPaths,
  });

  const report = readFileSync(out.reportPath, "utf8");

  console.log("\n=== report.md ===\n");
  console.log(report);
  console.log("=== end report.md ===\n");

  console.log("Assertions:");
  // AC#2 — screenshot paths relative, not absolute.
  assert(report.includes("](screenshots/"), "AC#2 screenshot link is relative (screenshots/…)");
  assert(!report.includes(sessionDir), "AC#2/#3 report contains NO absolute sessionDir path");
  // AC#3 — video link relative.
  assert(report.includes("](recording.webm)"), "AC#3 video link is relative (recording.webm)");
  // AC#1 — structure present.
  assert(report.startsWith("# Onboarding Step 2 Review"), "AC#1 title humanized from folder name");
  assert(
    FIXTURE.tasks.every((t) => report.includes(`. ${t.title}`)),
    "AC#1 every task title is rendered as a section",
  );
  // AC#5 — tasks.json marker round-trips through the authoritative schema.
  const marker = AnalysisResultSchema.parse(
    JSON.parse(readFileSync(out.tasksJsonPath, "utf8")),
  );
  assert(marker.tasks.length === FIXTURE.tasks.length, "AC#5 tasks.json marker round-trips through schema");

  // --- Manual edit, then a second write (ADR-009 / AC#4) -----------------
  console.log("\n--- Simulating a manual edit, then a second writeReport ---");
  const MANUAL = "\n<!-- MANUAL EDIT: reviewed with the team 2026-06-30 -->\n";
  appendFileSync(out.reportPath, MANUAL);

  const before = new Set(readdirSync(sessionDir));
  await writeReport({ sessionDir, videoPath: video, result: FIXTURE, screenshotPaths });
  const after = readdirSync(sessionDir);
  const created = after.filter((f) => !before.has(f));

  const archivedReports = after.filter((f) => /^report-.*\.md$/.test(f));
  const archivedTasks = after.filter((f) => /^tasks-.*\.json$/.test(f));
  assert(archivedReports.length === 1, "AC#4 exactly one report-<ts>.md archive created");
  assert(archivedTasks.length === 1, "AC#4 exactly one tasks-<ts>.json archive created");

  const archivedBody = readFileSync(path.join(sessionDir, archivedReports[0]), "utf8");
  assert(archivedBody.includes("MANUAL EDIT"), "AC#4 manual edit is preserved in the archive (not lost)");

  const freshBody = readFileSync(out.reportPath, "utf8");
  assert(!freshBody.includes("MANUAL EDIT"), "AC#4 new report.md is regenerated (no stale edit)");

  console.log(`\n  archived this run: ${created.join(", ")}`);
  console.log(`\nWork dir (open report.md in VS Code to eyeball AC#1):\n  ${sessionDir}`);
  console.log("\nAll assertions passed. ✓");
}

main().catch((err) => {
  console.error("\n✗", err);
  process.exit(1);
});
