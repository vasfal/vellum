import { createPartFromUri, createUserContent, Type, type Schema } from "@google/genai";
import { z } from "zod";
import { FALLBACK_MODELS, getGemini, MODEL } from "./client";
import {
  ANALYSIS_RESPONSE_SCHEMA,
  AnalysisResultSchema,
  kebabCase,
  REVIEW_TYPES,
  type AnalysisLanguage,
  type AnalysisMode,
  type AnalysisOrigin,
  type AnalysisResult,
  type AnalysisRun,
} from "./schema";
import { basePrice, costUsd } from "./pricing";
import {
  buildCombinedPrompt,
  buildOverviewPrompt,
  buildTaskExtractionPrompt,
  PROMPT_VERSION,
} from "./prompts/extract-tasks";

/**
 * Stage 2 of the Phase 1 pipeline (ARCHITECTURE.md §Pipeline contracts):
 *
 *   analyze(fileUri): Promise<AnalysisResult>
 *
 * Multi-step per ADR-006, run as two structured calls (see the design choice in
 * TASK-5: separate generateContent calls, two model passes):
 *
 *   Step 1 — watch the video, produce `overview` + detect `review_type`.
 *   Step 2 — extract tasks (with screenshot timestamps) IN that established
 *            context. `review_type` tunes attention; the category enum is fixed.
 *
 * Step 1's overview/review_type are authoritative in the assembled result (that
 * is the step dedicated to them); step 2 contributes the task list. The whole is
 * validated once more through AnalysisResultSchema before returning.
 *
 * This builds the machinery and a FIRST-DRAFT prompt only. Task *quality* on
 * real recordings is iterated in TASK-21 (the validation gate), not here.
 *
 * Error philosophy (ARCHITECTURE.md §Error handling): fail loud, no silent
 * retries. Anything the model returns that doesn't validate throws with a
 * message that says what went wrong.
 */

/** Re-exported so a caller can stamp output with the prompt it came from. */
export { PROMPT_VERSION };

/**
 * createPartFromUri needs the file's mimeType. Vellum records WebM (ADR-003), so
 * that is the default; an IMPORTED mp4 (S13) threads "video/mp4" through the
 * contract — the propagation this comment anticipated, now wired end-to-end
 * (route.ts → analyze → analyzeSegment → runStructured).
 */
const DEFAULT_MIME_TYPE = "video/webm";

/** A failure the CLI can print verbatim — the message itself is the guidance. */
export class AnalyzeError extends Error {
  constructor(
    readonly kind:
      | "invalid_api_key"
      | "empty_response"
      | "invalid_json"
      | "schema_invalid"
      | "api_error",
    message: string,
  ) {
    super(message);
    this.name = "AnalyzeError";
  }
}

/**
 * Token usage of ONE generateContent call (TASK-45): which model actually ran
 * (the primary, or a fallback if the primary was overloaded — ADR-021) and its
 * captured token counts. `tokensOut` folds thinking tokens into candidate tokens
 * because Gemini bills both at the output rate (see runStructured). A run is a
 * list of these — analyzeSegment yields two (overview + tasks), analyzeLong many.
 */
export interface GeminiCall {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** analyzeSegment's output: the assembled result plus the calls it took to make it. */
interface SegmentAnalysis {
  result: AnalysisResult;
  calls: GeminiCall[];
}

/**
 * Fold the per-call usage of a whole analysis run into the `run` telemetry block
 * that lands on the AnalysisResult (and thus tasks.json). `analyzedAt` is stamped
 * here, server-side, since it is NOT part of any Gemini output. Cost is summed
 * PER CALL so each call is priced by its own model and prompt-size tier; if ANY
 * used model has no known price, the whole run's cost is omitted rather than
 * under-reported (a partial total would read as "cheaper than it was").
 */
export function buildRun(
  calls: GeminiCall[],
  mode: AnalysisMode,
  // TASK-49 — the output language the run was asked for, stamped into telemetry.
  // Defaults to "en" so any existing caller records the historical English run.
  language: AnalysisLanguage = "en",
  // TASK-60 — how the run was produced. Defaults to "analyze" so every existing
  // caller (analyze / analyzeLong) records the grounded-video path; the revise
  // paths pass "revise-text" / "revise-video".
  origin: AnalysisOrigin = "analyze",
): AnalysisRun {
  const models: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let costKnown = true;

  for (const call of calls) {
    if (!models.includes(call.model)) models.push(call.model);
    tokensIn += call.tokensIn;
    tokensOut += call.tokensOut;
    // Price each call by its own input size (the tier boundary is per-request).
    const callCost = costUsd(call.model, call.tokensIn, call.tokensOut, call.tokensIn);
    if (callCost === undefined) costKnown = false;
    else cost += callCost;
  }

  return {
    analyzedAt: new Date().toISOString(),
    mode,
    language,
    origin,
    models,
    tokensIn,
    tokensOut,
    // Round to whole cents-of-a-cent so a float-sum artifact ($0.2300000001)
    // doesn't leak into tasks.json; omitted entirely if any price was unknown.
    costUsd: costKnown ? Math.round(cost * 1e6) / 1e6 : undefined,
  };
}

// Step 1 emits overview + review_type + a suggested session name (TASK-22), so
// it gets its own narrow schemas built from the same enum single-source as the
// full schema (no duplicated values).
const OVERVIEW_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    review_type: {
      type: Type.STRING,
      enum: [...REVIEW_TYPES],
      description: "The kind of review session, inferred from the whole recording.",
    },
    overview: {
      type: Type.STRING,
      description:
        "Structural overview of the recording in English: what it is and its overall context.",
    },
    suggested_name: {
      type: Type.STRING,
      description:
        'A concise, kebab-case English name for this session (e.g. ' +
        '"onboarding-step-2-review"). Lowercase words joined by single hyphens.',
    },
  },
  required: ["review_type", "overview", "suggested_name"],
  propertyOrdering: ["review_type", "overview", "suggested_name"],
};

// suggested_name is validated LENIENTLY here (a plain string): Gemini may reply
// with a stray capital or space, and we'd rather kebab-normalize it (kebabCase
// below) than fail the whole analysis on a naming nit. The strict kebab check
// runs on the assembled result, after normalization.
const OverviewSchema = AnalysisResultSchema.pick({
  review_type: true,
  overview: true,
}).extend({
  suggested_name: z.string().optional(),
});

// Step 2 owns only the task list; it must NOT re-validate suggested_name (step 1
// owns that field, and step 2's Gemini reply may echo an un-normalized name).
const TaskStepSchema = AnalysisResultSchema.omit({ suggested_name: true });

// Economy single-pass (TASK-46) validates the WHOLE result from one reply, but
// suggested_name LENIENTLY — same rationale as OverviewSchema: kebab-normalize a
// slightly-off name rather than fail the run. `run` is pipeline-assembled, never
// in the Gemini reply, so it is omitted here (added by buildRun in analyze()).
const CombinedSchema = AnalysisResultSchema.omit({
  suggested_name: true,
  run: true,
}).extend({
  suggested_name: z.string().optional(),
});

export async function analyze(
  fileUri: string,
  mimeType: string = DEFAULT_MIME_TYPE,
  // TASK-42 — an optional abort signal, threaded into the Gemini call so a client
  // Cancel actually stops the in-flight request. Only the single-video path
  // forwards it today; analyzeLong is left as a follow-up (see route.ts).
  signal?: AbortSignal,
  // TASK-46 — "thorough" (default) runs the two-pass ADR-006 pipeline; "economy"
  // runs a single combined call for ~half the tokens/cost. Default keeps every
  // existing caller byte-identical until TASK-47 lets the user pick.
  mode: AnalysisMode = "thorough",
  // TASK-49 — output language. "en" (default) keeps the prompts byte-identical
  // (English-only, ADR-006); "uk" appends the Ukrainian normalization override.
  language: AnalysisLanguage = "en",
  // TASK-50 — an optional PRIMARY model override chosen in the pre-analysis
  // config (TASK-47 sends it). undefined keeps the built-in MODEL, so every
  // existing caller runs byte-identical; a chosen model becomes attemptPlan[0]
  // in runStructured, with the ADR-021 fallback chain trimmed to tiers BELOW it.
  model?: string,
  // TASK-60 — the re-run-with-video revise context (prior tasks + the reviewer's
  // comments), prepended to BOTH prompts exactly like the long-video running
  // summary (withContext). undefined for a plain analysis, so the prompts stay
  // byte-identical to before. The route weaves it from { priorResult, comments }.
  reviseContext?: string,
): Promise<AnalysisResult> {
  // The single-video contract is just analyzeSegment with no prior context (or
  // the revise context when re-running with video). Passing priorContext=undefined
  // leaves both prompts byte-identical to the originals (see withContext), so a
  // plain analyze()'s task output is unchanged.
  // The run telemetry (TASK-45) is stamped from the call(s) it took — two in
  // thorough, one in economy — and records the real mode (TASK-46) + language.
  const { result, calls } = await analyzeSegment(
    fileUri,
    reviseContext,
    mimeType,
    signal,
    mode,
    language,
    model,
  );
  return { ...result, run: buildRun(calls, mode, language) };
}

/**
 * The two-step analysis of ONE uploaded file, optionally seeded with a
 * `priorContext` block. analyze() (single videos) and analyzeLong() (TASK-9,
 * one call per segment) both run through here so there is a single Gemini code
 * path.
 *
 * `priorContext` is the running summary the long-video stage carries between
 * segments (what earlier segments established, which items are already captured,
 * and that this video is one segment of a larger recording). It is prepended to
 * BOTH prompts. For single videos it is undefined and changes nothing.
 *
 * Timestamps returned here are always LOCAL to the file analyzed (0-based). The
 * long-video stage is responsible for shifting them to the original recording.
 */
export async function analyzeSegment(
  fileUri: string,
  priorContext?: string,
  mimeType: string = DEFAULT_MIME_TYPE,
  signal?: AbortSignal,
  // TASK-46 — see analyze(). "economy" collapses the two passes below into one.
  mode: AnalysisMode = "thorough",
  // TASK-49 — see analyze(). Threaded into every prompt builder below; "en"
  // leaves them byte-identical, "uk" appends the normalization override.
  language: AnalysisLanguage = "en",
  // TASK-50 — see analyze(). The chosen PRIMARY model, forwarded to every
  // runStructured call below so both the economy and thorough paths honor it.
  // undefined → the built-in MODEL (unchanged behavior).
  model?: string,
): Promise<SegmentAnalysis> {
  // Economy (TASK-46) — ONE combined call: overview + review_type +
  // suggested_name + tasks in a single generateContent, using the full
  // ANALYSIS_RESPONSE_SCHEMA as responseSchema. Same assembly/normalization as
  // the thorough path, just from one reply instead of two.
  if (mode === "economy") {
    const combinedCall = await runStructured({
      prompt: withContext(buildCombinedPrompt(language), priorContext),
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
      file: { uri: fileUri, mimeType },
      signal,
      chosenModel: model,
    });
    const combined = parseOrThrow(CombinedSchema, combinedCall.data, "combined step");
    const result = parseOrThrow(
      AnalysisResultSchema,
      {
        review_type: combined.review_type,
        overview: combined.overview,
        suggested_name: kebabCase(combined.suggested_name ?? ""),
        tasks: combined.tasks,
      },
      "assembled result",
    );
    return { result, calls: [combinedCall.usage] };
  }

  // Step 1 — overview + review_type.
  const overviewCall = await runStructured({
    prompt: withContext(buildOverviewPrompt(language), priorContext),
    responseSchema: OVERVIEW_RESPONSE_SCHEMA,
    file: { uri: fileUri, mimeType },
    signal,
    chosenModel: model,
  });
  const overview = parseOrThrow(OverviewSchema, overviewCall.data, "overview step");

  // Step 2 — task extraction seeded with that context. Uses TASK-4's full
  // ANALYSIS_RESPONSE_SCHEMA as the responseSchema; we keep only its tasks.
  const tasksCall = await runStructured({
    prompt: withContext(
      buildTaskExtractionPrompt(overview.overview, overview.review_type, language),
      priorContext,
    ),
    responseSchema: ANALYSIS_RESPONSE_SCHEMA,
    file: { uri: fileUri, mimeType },
    signal,
    chosenModel: model,
  });
  const step2 = parseOrThrow(TaskStepSchema, tasksCall.data, "task-extraction step");

  // Assemble: step 1 owns overview/review_type/suggested_name; step 2 owns the
  // task list. Normalize the suggested name to kebab-case before the final
  // validation so a slightly-off Gemini reply becomes a clean display name (or
  // drops to undefined → the timestamp folder name is the fallback). Validate the
  // whole once more so the returned object is guaranteed valid.
  const result = parseOrThrow(
    AnalysisResultSchema,
    {
      review_type: overview.review_type,
      overview: overview.overview,
      suggested_name: kebabCase(overview.suggested_name ?? ""),
      tasks: step2.tasks,
    },
    "assembled result",
  );

  // Hand both calls' usage up so the caller can total it (a single-video run
  // stamps it directly; analyzeLong sums it across every segment).
  return { result, calls: [overviewCall.usage, tasksCall.usage] };
}

/**
 * Prepend the long-video running summary to a prompt. With no prior context the
 * prompt is returned untouched, so the single-video path is byte-for-byte what
 * it was before TASK-9.
 */
function withContext(prompt: string, priorContext?: string): string {
  return priorContext ? `${priorContext}\n\n---\n\n${prompt}` : prompt;
}

/** The parsed (but not yet validated) JSON of one call, plus its token usage. */
export interface StructuredCall {
  data: unknown;
  usage: GeminiCall;
}

/** Inputs to one structured-JSON Gemini call (runStructured). */
export interface StructuredCallInput {
  prompt: string;
  responseSchema: Schema;
  /**
   * The uploaded video part. Omit it for a TEXT-ONLY call — that is exactly what
   * the text-only revise path (TASK-60) needs: same retry/fallback machinery, no
   * fileUri. When present the part is prepended before the prompt (the historical
   * video-then-prompt ordering).
   */
  file?: { uri: string; mimeType: string };
  signal?: AbortSignal;
  // TASK-50 — the chosen PRIMARY model, or undefined for the built-in MODEL.
  chosenModel?: string;
}

/**
 * One structured-JSON call: (optional video +) prompt -> parsed JSON + captured
 * token usage, with the ADR-021 retry-then-model-fallback machinery. Exported so
 * the revise path (TASK-60) reuses the SAME resilience instead of hand-rolling it.
 */
export async function runStructured({
  prompt,
  responseSchema,
  file,
  signal,
  chosenModel,
}: StructuredCallInput): Promise<StructuredCall> {
  // Try the primary model, then fall back to the lighter one if the primary is
  // persistently overloaded. Within each model a bounded backoff absorbs a
  // transient 503/429 spike (re-using the already-ACTIVE fileUri — no re-upload).
  // Auth errors fail loud immediately; any non-transient error fails loud without
  // falling back; a client Abort propagates untouched (the route suppresses it).
  //
  // TASK-50 — the primary is the caller's chosen model (or the built-in MODEL).
  // The ADR-021 fallback chain is trimmed to tiers strictly BELOW the primary
  // (fallbacksBelow), so an overloaded primary never fails UP to a pricier model
  // and never re-tries the primary as its own fallback. With no override this is
  // exactly [MODEL, ...FALLBACK_MODELS] — behavior is unchanged.
  const primary = chosenModel ?? MODEL;
  const attemptPlan: { model: string; attempts: number }[] = [
    { model: primary, attempts: PRO_ATTEMPTS },
    ...fallbacksBelow(primary).map((model) => ({ model, attempts: FALLBACK_ATTEMPTS })),
  ];
  let text: string | undefined;
  // The model + usage of the attempt that actually succeeded (TASK-45). Captured
  // inside the loop so we record the real model — a fallback, not always MODEL.
  let usage: GeminiCall | undefined;
  let succeeded = false;
  let lastErr: unknown;

  plan: for (const { model, attempts } of attemptPlan) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Video-then-prompt when a file is attached; prompt-only for a text call.
        const parts = file
          ? [createPartFromUri(file.uri, file.mimeType), prompt]
          : [prompt];
        const response = await getGemini().models.generateContent({
          model,
          contents: createUserContent(parts),
          config: { responseMimeType: "application/json", responseSchema, abortSignal: signal },
        });
        text = response.text;
        usage = captureUsage(model, response.usageMetadata);
        succeeded = true;
        if (model !== primary) {
          console.warn(`[analyze] used fallback model ${model} (${primary} overloaded)`);
        }
        break plan;
      } catch (err) {
        lastErr = err;
        // A client Cancel surfaces as an AbortError — propagate it untouched.
        if (isAbortError(err)) throw err;
        if (isAuthError(err)) {
          throw new AnalyzeError(
            "invalid_api_key",
            [
              `Gemini rejected the API key (${messageOf(err)}).`,
              "Check GEMINI_API_KEY in .env.local (no extra spaces/quotes) and that",
              "the key is active at https://aistudio.google.com/apikey.",
            ].join("\n"),
          );
        }
        // Only transient overload/rate-limit is worth retrying or falling back;
        // everything else (e.g. a genuine 400) fails loud right away.
        if (!isTransientError(err)) {
          throw new AnalyzeError("api_error", `Gemini call failed: ${messageOf(err)}`);
        }
        // Back off and retry the SAME model; once its attempts are spent the
        // outer loop advances to the fallback model.
        if (attempt < attempts) {
          await sleep(
            GEMINI_BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250),
            signal,
          );
        }
      }
    }
  }

  // Both models exhausted their attempts on transient overload — surface it.
  if (!succeeded) {
    throw new AnalyzeError("api_error", `Gemini call failed: ${messageOf(lastErr)}`);
  }

  // usage is set on the same success path as text, so a missing one is the same
  // empty-response condition — guarding both here also narrows usage for TS.
  if (!text || !usage) {
    throw new AnalyzeError(
      "empty_response",
      "Gemini returned an empty response (no text). The model may have refused or hit a safety filter; re-run.",
    );
  }

  try {
    return { data: JSON.parse(text), usage };
  } catch {
    throw new AnalyzeError(
      "invalid_json",
      `Gemini returned text that is not valid JSON despite responseSchema. First 200 chars:\n${text.slice(0, 200)}`,
    );
  }
}

/**
 * The ADR-021 fallback chain trimmed to tiers that sit strictly BELOW `primary`
 * (TASK-50): the configured FALLBACK_MODELS minus the primary itself and minus
 * anything pricier than it. This enforces the invariant that an overloaded
 * primary never fails UP to a costlier model.
 *
 * With the default primary (gemini-2.5-pro) and default chain
 * (flash, flash-lite) this returns both — unchanged. Pick flash and only
 * flash-lite survives; pick flash-lite and the chain is empty (nothing cheaper).
 */
function fallbacksBelow(primary: string): string[] {
  return FALLBACK_MODELS.filter((f) => f !== primary && notPricierThan(f, primary));
}

/**
 * Is fallback `f` safe to use as a tier below `primary` — i.e. not more
 * expensive? Compared on the headline (lower-tier) input price (basePrice).
 * Unknown prices are treated as "possibly high", which keeps us conservative
 * against ever falling UP:
 *   - unknown fallback price → keep ONLY when the primary is also unknown (no
 *     basis to rank; defer to the operator's configured chain);
 *   - unknown primary but known fallback → keep (a known finite tier is not
 *     pricier than an unknown, typically-premium primary);
 *   - both known → keep iff the fallback's input rate ≤ the primary's.
 */
function notPricierThan(f: string, primary: string): boolean {
  const fp = basePrice(f)?.input;
  const pp = basePrice(primary)?.input;
  if (fp === undefined) return pp === undefined;
  if (pp === undefined) return true;
  return fp <= pp;
}

/**
 * Turn Gemini's optional usageMetadata into our GeminiCall (TASK-45). Missing
 * counts default to 0 (telemetry, never fatal). `tokensOut` = candidate tokens
 * PLUS thinking tokens: gemini-2.5-pro is a thinking model and its thoughts are
 * billed at the output rate, but they sit in a separate field that
 * candidatesTokenCount excludes — omitting them would under-count cost.
 */
function captureUsage(
  model: string,
  meta:
    | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
    | undefined,
): GeminiCall {
  return {
    model,
    tokensIn: meta?.promptTokenCount ?? 0,
    tokensOut: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
  };
}

/** Zod parse that turns a validation failure into a printable AnalyzeError. */
function parseOrThrow<T>(
  schema: { safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: unknown } },
  data: unknown,
  where: string,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new AnalyzeError(
    "schema_invalid",
    `Gemini output failed schema validation (${where}): ${messageOf(result.error)}`,
  );
}

// --- error classification (mirrors upload.ts; kept local to this stage) ------

function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return true;
  const msg = messageOf(err).toLowerCase();
  return (
    msg.includes("api key not valid") ||
    msg.includes("api_key_invalid") ||
    msg.includes("permission_denied")
  );
}

// Transient-failure resilience: try the primary model a couple of times to ride
// out a short 503 "high demand" spike, then fall back to the lighter model
// (which has far more capacity) with a few more attempts before giving up. Each
// attempt uses an exponential backoff + jitter. Fewer primary attempts because
// an overloaded pro call is slow to fail (~30s) — we'd rather fail over to the
// fallback than keep the user waiting on a saturated primary.
const PRO_ATTEMPTS = 2;
const FALLBACK_ATTEMPTS = 2;
const GEMINI_BASE_BACKOFF_MS = 1000;

/** True for overload/rate-limit that a retry usually clears (never for aborts). */
function isTransientError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const status = (err as { status?: number } | null)?.status;
  if (status === 500 || status === 503 || status === 429) return true;
  const msg = messageOf(err).toLowerCase();
  return (
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("try again later") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota")
  );
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/** Resolve after `ms`, or reject with the signal's AbortError if cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // ApiError stuffs the whole JSON error envelope into .message; pull the
  // human line so we don't echo a wall of JSON.
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // not JSON — fall through
  }
  return raw;
}
