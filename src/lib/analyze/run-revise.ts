// TASK-60 (ADR-024) — the client-side TEXT-ONLY "Process comments" flow, the
// sibling of run-analyze.ts MINUS the video. It POSTs the current analysis + all
// comments to /api/revise (a single fast Gemini call, no upload/ffmpeg), then
// writes the revised result as a NEW run via writeRevisedRunBrowser — which
// archives the prior run + its comments and carries the existing frames forward
// (no fresh extraction). The re-run-WITH-video flavor is run-analyze.ts's job.
//
// Fails loudly with an AnalyzeFlowError (reused from run-analyze) so the caller can
// branch on `kind` exactly as for analyze; never retries silently.

import {
  writeRevisedRunBrowser,
  type WriteReportBrowserOutput,
} from "@/lib/filesystem/write-report-browser";
import type { AnalysisLanguage, AnalysisResult } from "@/lib/gemini/schema";
import type { StoredAnalysisResult } from "@/lib/gemini/stored";
import type { Comment } from "@/lib/comments/comment";
import { AnalyzeFlowError } from "./run-analyze";

export interface RunReviseArgs {
  /** The session folder handle — the new run is written back into it. */
  sessionDir: FileSystemDirectoryHandle;
  /** The session folder name — used only for the humanized report title. */
  sessionName: string;
  /** The current (live) analysis being revised — its tasks carry stored ids. */
  result: StoredAnalysisResult;
  /** All comments for the current version (anchored + global). */
  comments: Comment[];
  /** Output language (ADR-022). Omitted → the route defaults to the run's language, then "en". */
  language?: AnalysisLanguage;
  /** Chosen PRIMARY model (ADR-021/TASK-50). Omitted → the built-in MODEL. */
  model?: string;
  /** Aborts the in-flight POST (cancel). */
  signal?: AbortSignal;
}

/** The /api/revise response: a revised result, or a structured pipeline error. */
type ReviseResponse =
  | { result: AnalysisResult }
  | { error: { kind: string; message: string } }
  | { kind: string; message: string };

export async function runRevise({
  sessionDir,
  sessionName,
  result,
  comments,
  language,
  model,
  signal,
}: RunReviseArgs): Promise<WriteReportBrowserOutput> {
  let res: Response;
  try {
    res = await fetch("/api/revise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, comments, language, model }),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new AnalyzeFlowError(
      "network",
      "Couldn't reach the reviser. Check that the app is running, then retry.",
    );
  }

  let body: ReviseResponse;
  try {
    body = (await res.json()) as ReviseResponse;
  } catch {
    throw new AnalyzeFlowError(
      "stream",
      "The reviser sent a malformed response. Retry in a moment.",
    );
  }

  // A 400 (bad request) carries { kind, message } at the top level.
  if (!res.ok) {
    const kind = "kind" in body ? body.kind : "internal";
    const message = "message" in body ? body.message : `The reviser responded with ${res.status}.`;
    throw new AnalyzeFlowError(kind, message);
  }

  // A pipeline failure rides the 200 payload as { error }.
  if ("error" in body) {
    throw new AnalyzeFlowError(body.error.kind, body.error.message);
  }
  if (!("result" in body)) {
    throw new AnalyzeFlowError("stream", "The reviser returned no result. Retry in a moment.");
  }

  // Write the revised result as a new run (archives the prior run + comments,
  // carries existing frames forward — TASK-60).
  return writeRevisedRunBrowser(sessionDir, body.result, sessionName);
}
