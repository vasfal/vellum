import { getFfmpegPath } from "../src/lib/ffmpeg/binary";
import { GoogleGenAI } from "@google/genai";
import { execSync } from "node:child_process";

console.log("Verifying ffmpeg-static...");
const p = getFfmpegPath();
const version = execSync(`"${p}" -version`).toString().split("\n")[0];
console.log(" ✓", version);

console.log("Verifying Gemini SDK import...");
if (typeof GoogleGenAI !== "function") throw new Error("SDK import failed");
console.log(" ✓ @google/genai import OK");

console.log(
  "\nAll dependencies verified. Note: actual Gemini API call not tested here — that needs a real API key and happens in Phase 1 dev work.",
);
