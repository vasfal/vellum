// TASK-28 — the client-side Analyze flow, reusable across entry points.
//
// One recording -> report, driven entirely from the browser (ADR-014): read
// recording.webm through the session's directory handle, POST the bytes to
// /api/analyze, consume the NDJSON progress stream, then write the report back
// into the same folder via writeReportBrowser (TASK-27). The server never sees
// the workspace path; it just runs the pipeline on the posted bytes and streams
// results.
//
// This is a plain async function (no React) so every caller can reuse it: the
// session view's Re-analyze action today, and the post-recording Analyze that
// TASK-25/30 will add. The caller owns UI, navigation, and the Retry decision;
// this function fails loudly with a typed error and never retries silently
// (ARCHITECTURE §Error handling).

import {
  writeReportBrowser,
  type ScreenshotPayload,
  type WriteReportBrowserOutput,
} from "@/lib/filesystem/write-report-browser";
import {
  findRecording,
  mimeForRecordingExt,
  type RecordingExt,
} from "@/lib/filesystem/recording-file";
import type { AnalysisLanguage, AnalysisMode, AnalysisResult } from "@/lib/gemini/schema";
import type { StoredAnalysisResult } from "@/lib/gemini/stored";
import type { Comment } from "@/lib/comments/comment";
import { splitLines } from "./ndjson";

/** The pipeline phases the stream reports, in the order they occur. */
export type AnalyzePhase = "upload" | "analyzing" | "extracting" | "writing";

export interface AnalyzeProgress {
  phase: AnalyzePhase;
  /** `extracting` carries an n-of-m frame counter; other phases leave these unset. */
  n?: number;
  m?: number;
}

/**
 * The wire contract of POST /api/analyze (route.ts), mirrored here by hand. It
 * is intentionally NOT a shared import: the route pulls in node:fs + ffmpeg and
 * can't enter the browser bundle. The two halves share a wire format, not a
 * module (ADR-014) — keep this union in step with the route's StreamEvent.
 */
type StreamEvent =
  | { type: "progress"; phase: AnalyzePhase; pct?: number; n?: number; m?: number }
  | { type: "done"; result: AnalysisResult; screenshots: ScreenshotPayload[] }
  | { type: "error"; kind: string; message: string };

/**
 * A failure carrying a machine-usable `kind` so the UI can branch — notably an
 * "upload" key error routing toward the API-key screen (TASK-29). `kind` is
 * either a server error kind ("upload" | "analyze" | "internal") or a
 * client-side one ("recording" | "network" | "stream").
 */
export class AnalyzeFlowError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "AnalyzeFlowError";
  }
}

export interface RunAnalyzeArgs {
  /** The session folder handle: recording.webm is read from it, the report written back into it. */
  sessionDir: FileSystemDirectoryHandle;
  /** The session folder name — used only for the humanized report title. */
  sessionName: string;
  /** Called on every progress event so the caller can render granular status. */
  onProgress: (progress: AnalyzeProgress) => void;
  /** Aborts the in-flight POST (e.g. on unmount). */
  signal?: AbortSignal;
  /**
   * Cost mode (TASK-46). Omitted → the route defaults to "thorough" (two-pass).
   * TASK-47 wires the user's picker here; until then callers leave it unset and
   * the current behavior is unchanged.
   */
  mode?: AnalysisMode;
  /**
   * Output language (TASK-49). Omitted → the route defaults to "en" (English,
   * ADR-006). TASK-47 wires the user's picker here; until then callers leave it
   * unset and the current English behavior is unchanged. "uk" normalizes the
   * spoken review into clean Ukrainian output.
   */
  language?: AnalysisLanguage;
  /**
   * Chosen PRIMARY model (TASK-50). Omitted → the route defaults to the built-in
   * MODEL (unchanged behavior). TASK-47 wires the user's picker here; the string
   * is a Gemini model id without the "models/" prefix (e.g. "gemini-2.5-flash"),
   * as returned by GET /api/models.
   */
  model?: string;
  /**
   * TASK-60 — the re-run-WITH-video revise payload. When set, the recording is
   * re-analyzed WITH the prior tasks + the reviewer's comments woven into the
   * prompt (buildReviseVideoContext, server-side) and fresh screenshots extracted,
   * then written as a normal new run. Omitted → a plain analysis (unchanged). Sent
   * as multipart (video + JSON) so the payload isn't size-bounded like a header.
   */
  revise?: { result: StoredAnalysisResult; comments: Comment[] };
}

/**
 * Run the full Analyze flow for one session. Resolves to what was written; on
 * any failure throws an AnalyzeFlowError (or re-throws AbortError when the
 * caller aborted). Whatever the browser-side write already committed stays on
 * disk — there is no rollback, matching the "never lose data" stance.
 */
export async function runAnalyze({
  sessionDir,
  sessionName,
  onProgress,
  signal,
  mode,
  language,
  model,
  revise,
}: RunAnalyzeArgs): Promise<WriteReportBrowserOutput> {
  // 1. Read the recording bytes through the handle. The server has no path to a
  //    File-System-Access folder, so it receives the bytes themselves (ADR-014).
  //    An imported session may be mp4 (S13), so resolve the real file/extension
  //    rather than assuming recording.webm.
  const { bytes, ext } = await readRecording(sessionDir);
  const mimeType = mimeForRecordingExt(ext);

  // 2. POST the bytes. ?ext= tells the route the container up front (ADR-003) so
  //    it names the temp file correctly and threads the matching mimeType into
  //    Gemini — without sniffing. webm remains the common case. ?mode= carries
  //    the cost mode (TASK-46) only when the caller set one; otherwise the route
  //    defaults to "thorough". ?lang= carries the output language (TASK-49) only
  //    when the caller set one; otherwise the route defaults to "en". ?model=
  //    carries the chosen primary model (TASK-50) only when the caller set one;
  //    otherwise the route defaults to the built-in MODEL.
  const query =
    `?ext=${ext.slice(1)}` +
    `${mode ? `&mode=${mode}` : ""}` +
    `${language ? `&lang=${language}` : ""}` +
    `${model ? `&model=${encodeURIComponent(model)}` : ""}`;
  // The re-run-with-video path (TASK-60) posts multipart (video + the revise JSON)
  // so the prior tasks + comments aren't bounded by header limits; a plain analysis
  // posts the raw bytes with the container Content-Type exactly as before.
  const init: RequestInit = revise
    ? { method: "POST", body: reviseFormData(bytes, ext, mimeType, revise), signal }
    : { method: "POST", headers: { "Content-Type": mimeType }, body: bytes, signal };

  let res: Response;
  try {
    res = await fetch(`/api/analyze${query}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new AnalyzeFlowError(
      "network",
      "Couldn't reach the analyzer. Check that the app is running, then retry.",
    );
  }

  // The route keeps HTTP 200 even on a pipeline failure (the failure rides the
  // stream as an error event), so a non-OK status here is a transport-level
  // fault, not a pipeline one.
  if (!res.ok || !res.body) {
    throw new AnalyzeFlowError(
      "internal",
      `The analyzer responded with ${res.status}. Retry in a moment.`,
    );
  }

  // 3. Consume the NDJSON stream: progress events drive the UI; the terminal
  //    "done" carries the result + screenshots; a terminal "error" throws with
  //    its cause so the caller can show it plus a Retry (no silent loop).
  const done = await consumeStream(res.body, onProgress);

  // 4. Write report.md / tasks.json / screenshots/ back into the session folder
  //    through the handle. ADR-009 archiving of any prior run lives inside
  //    writeReportBrowser. The server already emitted "writing"; keep the phase
  //    up while the real browser-side write runs.
  onProgress({ phase: "writing" });
  return writeReportBrowser(sessionDir, done.result, done.screenshots, sessionName);
}

/**
 * Build the multipart body for the re-run-with-video revise (TASK-60): the video
 * under "video" (so the route reads it exactly like the raw-bytes path) and the
 * prior tasks + comments as JSON under "revise". The browser sets the multipart
 * boundary, so the caller must NOT set a Content-Type header here.
 */
function reviseFormData(
  bytes: ArrayBuffer,
  ext: RecordingExt,
  mimeType: string,
  revise: { result: StoredAnalysisResult; comments: Comment[] },
): FormData {
  const form = new FormData();
  form.append("video", new Blob([bytes], { type: mimeType }), `recording${ext}`);
  form.append("revise", JSON.stringify(revise));
  return form;
}

/** Read the session's recording as bytes + its container extension, or fail
 * with a "recording" kind if there is none (webm or mp4). */
async function readRecording(
  sessionDir: FileSystemDirectoryHandle,
): Promise<{ bytes: ArrayBuffer; ext: RecordingExt }> {
  const match = await findRecording(sessionDir);
  if (!match) {
    throw new AnalyzeFlowError(
      "recording",
      "This session has no recording (recording.webm or recording.mp4) to analyze.",
    );
  }
  const file = await match.handle.getFile();
  return { bytes: await file.arrayBuffer(), ext: match.ext };
}

/**
 * Read the NDJSON stream to its terminal event. Progress events are forwarded
 * to `onProgress`; an error event throws; a done event is captured and returned.
 * A stream that ends without a terminal event is itself an error.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (progress: AnalyzeProgress) => void,
): Promise<{ result: AnalysisResult; screenshots: ScreenshotPayload[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: { result: AnalysisResult; screenshots: ScreenshotPayload[] } | null =
    null;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    const split = splitLines(buffer);
    buffer = split.rest;
    for (const line of split.lines) {
      const event = parseEvent(line);
      if (event.type === "progress") {
        onProgress({ phase: event.phase, n: event.n, m: event.m });
      } else if (event.type === "error") {
        throw new AnalyzeFlowError(event.kind, event.message);
      } else {
        // "done" is terminal — capture it and stop; nothing follows on the wire.
        done = { result: event.result, screenshots: event.screenshots };
      }
    }
    if (done) break;
  }

  if (!done) {
    throw new AnalyzeFlowError(
      "stream",
      "The analysis stream ended before finishing. Retry in a moment.",
    );
  }
  return done;
}

/** Parse one NDJSON line, mapping a malformed line to a "stream" failure. */
function parseEvent(line: string): StreamEvent {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    throw new AnalyzeFlowError(
      "stream",
      "The analyzer sent a malformed response. Retry in a moment.",
    );
  }
}
