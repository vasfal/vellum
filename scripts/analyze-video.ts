/**
 * CLI wrapper around analyze (TASK-5). Thin by design: upload the clip (TASK-3),
 * run the multi-step analysis, print the structured result or a human error.
 * All real logic lives in src/lib/gemini/{upload,analyze}.ts so the UI and the
 * TASK-8 glue command can reuse it unchanged.
 *
 *   npm run analyze -- path/to/recording.webm
 */
import { uploadVideo, UploadError } from "../src/lib/gemini/upload";
import { analyze, AnalyzeError, PROMPT_VERSION } from "../src/lib/gemini/analyze";

async function main(): Promise<void> {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("Usage: npm run analyze -- <path-to-video.webm|.mp4>");
    process.exit(2);
  }

  console.log(`Uploading ${videoPath} …`);
  const { fileUri } = await uploadVideo(videoPath);

  console.log(`\nAnalyzing (prompt ${PROMPT_VERSION}) …`);
  const result = await analyze(fileUri);

  console.log(`\n✓ review_type: ${result.review_type}`);
  console.log(`✓ overview: ${result.overview}`);
  console.log(`✓ tasks: ${result.tasks.length}`);
  console.log("\nFull result:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  if (err instanceof UploadError || err instanceof AnalyzeError) {
    // Message is already user-facing guidance — print it as-is, no stack.
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  // Unknown failure: fail loud with the full error (error philosophy).
  console.error("\n✗ Unexpected error:");
  console.error(err);
  process.exit(1);
});
