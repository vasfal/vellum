import { GoogleGenAI } from "@google/genai";

export const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";

// Ordered fallbacks, tried in turn only when the primary is overloaded (503
// "high demand"). Each tier trades quality for capacity (ADR-002): 2.5-flash
// first, then 2.5-flash-lite (the lightest 2.5 tier — most headroom when flash
// is also saturated). Both are current-gen and LIVE-verified against the API
// (an older model that merely *appears* in models.list can still be retired —
// gemini-2.0-flash was, and hard-failed the chain; don't add a tier without
// confirming generateContent works on it). The primary is always tried first.
export const FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS ?? "gemini-2.5-flash,gemini-2.5-flash-lite"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

let client: GoogleGenAI | null = null;

/**
 * Lazily construct the shared Gemini client.
 *
 * Importing this module must NEVER crash — `analyze.ts` imports it, and the glue
 * command (TASK-8) imports analyze BEFORE the upload stage runs. The upload stage
 * (uploadVideo) handles a missing/invalid key with step-by-step guidance
 * (ARCHITECTURE §Error handling); if the key check fired here at module-load it
 * would throw a bare error from an import, bypassing that guidance entirely.
 * So we defer both the client construction and the key check to first real use.
 */
export function getGemini(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env.local and add your key from https://aistudio.google.com/apikey",
    );
  }
  client = new GoogleGenAI({ apiKey });
  return client;
}
