import ffmpegStatic from "ffmpeg-static";
import { existsSync } from "node:fs";

export function getFfmpegPath(): string {
  const p = ffmpegStatic;
  if (!p || !existsSync(p)) {
    throw new Error(
      "ffmpeg-static binary not found. Run: npm install ffmpeg-static",
    );
  }
  return p;
}
