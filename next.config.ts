import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ffmpeg-static resolves its binary via a __dirname-relative path. Bundling it
  // (Turbopack's default for server code) relocates that path into the build
  // output, so getFfmpegPath() can't find the real binary and /api/analyze's
  // screenshot stage fails. Keeping it external leaves the require() running
  // from node_modules, where the path stays correct. Same reasoning for the
  // Gemini SDK's native/file deps — exclude the packages the API route spawns
  // or streams from disk. (ADR-014: the analyze route runs the Node pipeline.)
  //
  // NOTE: the prod build MUST run with `next build --webpack` (see package.json
  // build/prepack). Turbopack's production build externalizes this package but
  // writes the runtime require under a content-hashed specifier —
  // require("ffmpeg-static-<hash>") instead of require("ffmpeg-static") — which
  // resolves to nothing, so /api/analyze fails at module load with a bare 500
  // (TASK-67, ADR-029). Webpack keeps the external as the plain specifier. `next
  // dev` is unaffected and stays on Turbopack.
  serverExternalPackages: ["ffmpeg-static"],

  // Vellum is a focused, single-window desktop tool; the floating Next.js dev
  // indicator overlaps the app chrome and reads as noise in an otherwise clean
  // monochrome shell (ADR-004). Hide it — this only affects dev, not the build.
  devIndicators: false,
};

export default nextConfig;
