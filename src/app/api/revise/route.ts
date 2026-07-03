import { z } from "zod";
import { revise } from "@/lib/gemini/revise";
import { AnalyzeError } from "@/lib/gemini/analyze";
import {
  ANALYSIS_LANGUAGES,
  AnalysisResultSchema,
  type AnalysisLanguage,
} from "@/lib/gemini/schema";
import {
  StoredAnalysisResultSchema,
  type StoredVellumTask,
} from "@/lib/gemini/stored";
import type { VellumTask } from "@/lib/gemini/schema";
import { CommentSchema } from "@/lib/comments/comment";
import type { ReviseSource } from "@/lib/gemini/prompts/revise-tasks";

/**
 * POST /api/revise — the stateless TEXT-ONLY comment→AI-revise bridge (TASK-60,
 * ADR-024). It is the sibling of /api/analyze MINUS the video: no upload, no
 * ffmpeg. The browser POSTs the current analysis + all comments as JSON; this
 * route runs the revise Gemini call (runStructured retry/fallback, ADR-021) and
 * returns a validated, revised AnalysisResult. Nothing is persisted server-side
 * (ADR-014) — the browser owns writing the new run.
 *
 * The re-run-WITH-video revise is NOT here — that reuses /api/analyze (which
 * accepts an optional revise part and weaves the comments into the video prompt).
 *
 * Wire format: plain JSON in, plain JSON out (a single fast call — no streaming).
 * Success → 200 { result }. A bad body → 400 { kind, message }. A pipeline
 * failure → 200 { error: { kind, message } } so the failure rides the payload
 * (HTTP transport is fine), matching /api/analyze's fail-loud-but-structured
 * stance. The key stays server-side; a missing/invalid key surfaces as an error.
 */
export const runtime = "nodejs";

// The result may arrive as the stored shape (ids on tasks — the normal case, the
// live editable run) or a bare legacy AnalysisResult. Accept both; legacy tasks
// get synthesized ids so the prompt can still tie comments to them by position.
const RequestSchema = z.object({
  result: z.union([StoredAnalysisResultSchema, AnalysisResultSchema]),
  comments: z.array(CommentSchema),
  language: z.enum(ANALYSIS_LANGUAGES).optional(),
  model: z.string().trim().min(1).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { kind: "bad_request", message: "Request body is not valid JSON." });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, {
      kind: "bad_request",
      message: `Invalid revise request: ${parsed.error.message}`,
    });
  }

  const { result, comments, language, model } = parsed.data;
  const source = toReviseSource(result);
  const lang: AnalysisLanguage = language ?? result.run?.language ?? "en";

  try {
    const revised = await revise({
      source,
      comments,
      language: lang,
      model,
      signal: req.signal,
    });
    return json(200, { result: revised });
  } catch (err) {
    // A client Cancel (aborted) needs no body — the browser already tore down.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("[revise] pipeline error:", err);
    return json(200, { error: toError(err) });
  }
}

/**
 * Build the prompt source from whatever result shape arrived. Stored tasks already
 * carry ids; a legacy task gets a positional `t{i+1}` id and origin "ai" so the
 * ReviseSource type is satisfied and comments can still resolve by id/quote.
 */
function toReviseSource(result: z.infer<typeof RequestSchema>["result"]): ReviseSource {
  const rawTasks: (StoredVellumTask | VellumTask)[] = result.tasks;
  const tasks: StoredVellumTask[] = rawTasks.map((task, i) =>
    "id" in task ? task : { ...task, id: `t${i + 1}`, origin: "ai" },
  );
  return {
    overview: result.overview,
    review_type: result.review_type,
    tasks,
  };
}

function toError(err: unknown): { kind: string; message: string } {
  if (err instanceof AnalyzeError) return { kind: err.kind, message: err.message };
  return { kind: "internal", message: err instanceof Error ? err.message : String(err) };
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
