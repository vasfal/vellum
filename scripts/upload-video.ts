/**
 * CLI wrapper around uploadVideo (TASK-3). Thin by design: parse argv, call the
 * library, print the URI or a human error. All real logic lives in
 * src/lib/gemini/upload.ts so the UI can reuse it unchanged later.
 *
 *   npm run upload -- path/to/recording.webm
 */
import { uploadVideo, UploadError } from "../src/lib/gemini/upload";

async function main(): Promise<void> {
  const videoPath = process.argv[2];
  if (!videoPath) {
    console.error("Usage: npm run upload -- <path-to-video.webm|.mp4>");
    process.exit(2);
  }

  console.log(`Uploading ${videoPath} …`);
  const { fileUri } = await uploadVideo(videoPath);

  console.log(`\n✓ Active. File URI:\n${fileUri}`);
}

main().catch((err: unknown) => {
  if (err instanceof UploadError) {
    // Message is already user-facing guidance — print it as-is, no stack.
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  // Unknown failure: fail loud with the full error (error philosophy).
  console.error("\n✗ Unexpected error:");
  console.error(err);
  process.exit(1);
});
