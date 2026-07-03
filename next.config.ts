import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its binary via a __dirname-relative path. Bundling it
  // (Turbopack's default for server code) relocates that path into the build
  // output, so getFfmpegPath() can't find the real binary and /api/analyze's
  // screenshot stage fails. Keeping it external leaves the require() running
  // from node_modules, where the path stays correct. Same reasoning for the
  // Gemini SDK's native/file deps — exclude the packages the API route spawns
  // or streams from disk. (ADR-014: the analyze route runs the Node pipeline.)
  serverExternalPackages: ["ffmpeg-static"],

  // Vellum is a focused, single-window desktop tool; the floating Next.js dev
  // indicator overlaps the app chrome and reads as noise in an otherwise clean
  // monochrome shell (ADR-004). Hide it — this only affects dev, not the build.
  devIndicators: false,
};

export default nextConfig;
