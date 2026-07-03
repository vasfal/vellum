import { ApiError, FileState, GoogleGenAI } from "@google/genai";
import { extname } from "node:path";
import { stat } from "node:fs/promises";

/**
 * Stage 1 of the Phase 1 pipeline (ARCHITECTURE.md §Pipeline contracts):
 *
 *   uploadVideo(videoPath): Promise<{ fileUri: string }>
 *
 * Takes a local recording, uploads it to the Gemini Files API, waits for it to
 * become ACTIVE, and returns the file URI that the analysis stage will consume.
 *
 * Error philosophy (ARCHITECTURE.md §Error handling): fail loud, never silent
 * retry loops. The only automatic retry is a SINGLE retry on a network timeout
 * during upload — everything else throws immediately with a human message.
 */

// Gemini Files API hard limit. Bigger files are TASK-9's job (segment + overlap),
// not something we silently try and let the API reject with a cryptic error.
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const SUPPORTED_EXTENSIONS = [".webm", ".mp4"] as const;

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min; override with GEMINI_UPLOAD_TIMEOUT_MS

/**
 * A failure the user can act on. The CLI prints `message` verbatim — so the
 * message itself must be the guidance, not a code the user has to look up.
 */
export class UploadError extends Error {
  constructor(
    readonly kind:
      | "missing_api_key"
      | "invalid_api_key"
      | "file_not_found"
      | "unsupported_format"
      | "file_too_large"
      | "upload_timeout"
      | "processing_failed",
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export async function uploadVideo(videoPath: string): Promise<{ fileUri: string }> {
  await validateFile(videoPath);
  const ai = makeClient();

  const file = await uploadWithOneRetry(ai, videoPath);
  const active = await pollUntilActive(ai, file.name!);

  if (!active.uri) {
    // ACTIVE but no URI should never happen; treat as a hard failure rather
    // than returning an empty string downstream.
    throw new UploadError(
      "processing_failed",
      `File became ACTIVE but the API returned no URI (file: ${file.name}). This is unexpected — re-run the upload.`,
    );
  }

  return { fileUri: active.uri };
}

async function validateFile(videoPath: string): Promise<void> {
  let stats;
  try {
    stats = await stat(videoPath);
  } catch {
    throw new UploadError(
      "file_not_found",
      `No file at "${videoPath}". Pass the path to a .webm or .mp4 recording.`,
    );
  }

  if (!stats.isFile()) {
    throw new UploadError(
      "file_not_found",
      `"${videoPath}" is not a file. Pass the path to a .webm or .mp4 recording.`,
    );
  }

  const ext = extname(videoPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number])) {
    throw new UploadError(
      "unsupported_format",
      `Unsupported file type "${ext || "(none)"}". Vellum records WebM; supported inputs are: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    );
  }

  if (stats.size > MAX_FILE_BYTES) {
    const gb = (stats.size / 1024 / 1024 / 1024).toFixed(2);
    throw new UploadError(
      "file_too_large",
      `File is ${gb} GB, over the Gemini Files API limit of 2 GB. Long recordings are segmented automatically once that path lands (TASK-9); for now, use a shorter recording.`,
    );
  }
}

/**
 * Build the client here (rather than importing the shared one) so we own the
 * missing-key message: the user gets step-by-step guidance, not a raw 401.
 */
function makeClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new UploadError(
      "missing_api_key",
      [
        "GEMINI_API_KEY is not set.",
        "",
        "  1. Get a key at https://aistudio.google.com/apikey",
        "  2. Copy .env.example to .env.local",
        "  3. Paste the key after GEMINI_API_KEY=",
        "  4. Re-run this command",
      ].join("\n"),
    );
  }
  return new GoogleGenAI({ apiKey });
}

async function uploadWithOneRetry(ai: GoogleGenAI, videoPath: string) {
  try {
    return await ai.files.upload({ file: videoPath });
  } catch (err) {
    if (isAuthError(err)) throw authGuidance(err);
    if (!isNetworkTimeout(err)) throw err; // fail loud — no retry on unknown errors

    // The one allowed automatic retry (error philosophy: at most one, on a
    // network timeout). If this also fails, the error propagates loud.
    console.error("Upload timed out, retrying once…");
    try {
      return await ai.files.upload({ file: videoPath });
    } catch (retryErr) {
      if (isAuthError(retryErr)) throw authGuidance(retryErr);
      throw new UploadError(
        "upload_timeout",
        `Upload timed out twice (one automatic retry already used). Check your connection and re-run. Original error: ${messageOf(retryErr)}`,
      );
    }
  }
}

async function pollUntilActive(ai: GoogleGenAI, fileName: string) {
  const timeoutMs = pollTimeoutMs();
  const deadline = nowMs() + timeoutMs;

  // We re-fetch the file by name; the freshly-uploaded object starts in
  // PROCESSING and flips to ACTIVE (or FAILED) when Gemini finishes ingesting.
  for (;;) {
    const file = await ai.files.get({ name: fileName });

    if (file.state === FileState.ACTIVE) return file;
    if (file.state === FileState.FAILED) {
      throw new UploadError(
        "processing_failed",
        `Gemini failed to process the file: ${file.error?.message ?? "no reason given"}. The video may be corrupt or an unsupported codec.`,
      );
    }

    if (nowMs() >= deadline) {
      const mins = Math.round(timeoutMs / 60_000);
      throw new UploadError(
        "upload_timeout",
        `File still PROCESSING after ${mins} min. Increase GEMINI_UPLOAD_TIMEOUT_MS for very long videos, or check https://aistudio.google.com for service status.`,
      );
    }

    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }
}

// --- error classification -------------------------------------------------

function isAuthError(err: unknown): boolean {
  // An invalid key comes back as HTTP 400 with an API_KEY_INVALID reason — not
  // a 401 — so we can't classify on status alone; we also sniff the message.
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
    return true;
  }
  const msg = messageOf(err).toLowerCase();
  return (
    msg.includes("api key not valid") ||
    msg.includes("api_key_invalid") ||
    msg.includes("permission_denied")
  );
}

function authGuidance(err: unknown): UploadError {
  return new UploadError(
    "invalid_api_key",
    [
      `Gemini rejected the API key (${messageOf(err)}).`,
      "",
      "  1. Check GEMINI_API_KEY in .env.local has no extra spaces or quotes",
      "  2. Confirm the key is active at https://aistudio.google.com/apikey",
      "  3. If unsure, generate a fresh key and paste it in",
    ].join("\n"),
  );
}

function isNetworkTimeout(err: unknown): boolean {
  // Node fetch / undici surface timeouts and dropped connections through these
  // codes or names; we treat all of them as a retryable network timeout.
  const code = (err as { code?: string } | null)?.code ?? "";
  const name = (err as { name?: string } | null)?.name ?? "";
  const msg = messageOf(err).toLowerCase();
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    msg.includes("timeout") ||
    msg.includes("network")
  );
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // ApiError stuffs the whole JSON error envelope into .message; pull out the
  // human-readable line so we don't echo a wall of JSON at the user.
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // not JSON — fall through
  }
  return raw;
}

// --- small helpers --------------------------------------------------------

function pollTimeoutMs(): number {
  const raw = process.env.GEMINI_UPLOAD_TIMEOUT_MS;
  if (!raw) return DEFAULT_POLL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_TIMEOUT_MS;
}

// Date.now wrapped so the polling loop reads as intent, not arithmetic.
function nowMs(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
