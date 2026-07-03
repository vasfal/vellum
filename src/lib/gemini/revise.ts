/**
 * TASK-60 (ADR-024) — the TEXT-ONLY comment→AI-revise call. Mirrors analyze()'s
 * ergonomics (a plain async function returning a validated AnalysisResult + run
 * telemetry), but there is NO video: it reuses runStructured (analyze.ts) so the
 * ADR-021 retry-then-model-fallback machinery is shared, not re-implemented, then
 * validates the reply through the SAME schema analyze uses.
 *
 * The re-run-WITH-video revise does NOT live here — that is the existing video
 * pipeline plus a revise context, wired in /api/analyze (buildReviseVideoContext).
 *
 * Error philosophy (ARCHITECTURE §Error handling): fail loud. Auth / empty /
 * bad-output throw an AnalyzeError with actionable text; transient 503/429 is
 * absorbed by runStructured's retry+fallback.
 */
import { z } from "zod";
import {
  ANALYSIS_RESPONSE_SCHEMA,
  AnalysisResultSchema,
  kebabCase,
  type AnalysisLanguage,
  type AnalysisResult,
} from "./schema";
import { AnalyzeError, buildRun, runStructured } from "./analyze";
import {
  buildRevisePrompt,
  REVISE_PROMPT_VERSION,
  type ReviseSource,
} from "./prompts/revise-tasks";
import type { Comment } from "@/lib/comments/comment";

export { REVISE_PROMPT_VERSION };

// The revised reply is the full result MINUS the pipeline-assembled `run` (added
// below by buildRun), and with suggested_name validated LENIENTLY — a slightly-off
// name is kebab-normalized rather than failing the whole revise (same rationale as
// analyze.ts's CombinedSchema).
const RevisedSchema = AnalysisResultSchema.omit({
  suggested_name: true,
  run: true,
}).extend({
  suggested_name: z.string().optional(),
});

export interface ReviseArgs {
  /** The prior analysis being revised (tasks carry their stored ids for anchoring). */
  source: ReviseSource;
  /** All the reviewer's comments for this version (anchored + global). */
  comments: Comment[];
  /** Output language (ADR-022). Defaults to "en". */
  language?: AnalysisLanguage;
  /** Chosen PRIMARY model, or undefined for the built-in MODEL (ADR-021/TASK-50). */
  model?: string;
  /** Aborts the in-flight Gemini call (ADR-021 cancellable). */
  signal?: AbortSignal;
}

/**
 * Text-only revise: prior analysis + comments -> a revised AnalysisResult. The
 * result carries run telemetry stamped `origin: "revise-text"` so the Details tab
 * can label it apart from a fresh analysis.
 */
export async function revise({
  source,
  comments,
  language = "en",
  model,
  signal,
}: ReviseArgs): Promise<AnalysisResult> {
  const call = await runStructured({
    prompt: buildRevisePrompt(source, comments, language),
    responseSchema: ANALYSIS_RESPONSE_SCHEMA,
    signal,
    chosenModel: model,
  });

  const parsed = RevisedSchema.safeParse(call.data);
  if (!parsed.success) {
    throw new AnalyzeError(
      "schema_invalid",
      `Revise output failed schema validation: ${messageOf(parsed.error)}`,
    );
  }

  // Assemble + validate once more so the returned object is guaranteed valid, and
  // normalize the (leniently-parsed) suggested_name to kebab-case — or drop it, so
  // the folder name is the display-name fallback downstream.
  const result = AnalysisResultSchema.parse({
    review_type: parsed.data.review_type,
    overview: parsed.data.overview,
    suggested_name: kebabCase(parsed.data.suggested_name ?? ""),
    tasks: parsed.data.tasks,
  });

  return { ...result, run: buildRun([call.usage], "thorough", language, "revise-text") };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
