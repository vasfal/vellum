/**
 * Authoritative schema for Vellum's video-analysis output (TASK-4).
 *
 * Two representations of the SAME structure live here, kept in sync on purpose:
 *   1. Zod schemas — runtime validation of what we parse back (Gemini output,
 *      `tasks.json` on re-render).
 *   2. `ANALYSIS_RESPONSE_SCHEMA` — the OpenAPI-subset shape we *send* to Gemini
 *      (`responseSchema`) so the model returns this exact structure.
 *
 * Why two hand-written representations instead of generating one from the other:
 * Gemini's schema is a narrow OpenAPI subset (no `$ref`, no string `pattern`,
 * `Type.*` not JSON-Schema `type`), so `z.toJSONSchema()` output would need
 * post-processing to be accepted — more machinery and a silent-incompatibility
 * risk on ~8 stable fields. Instead, the volatile part — the enums, pinned by
 * ADR-006 — is single-sourced as `const` arrays below; both representations read
 * from those, and `assertSchemasAgree()` fails loud if the two field lists ever
 * drift apart.
 *
 * These types MUST match ARCHITECTURE.md §Pipeline contracts (VellumTask /
 * AnalysisResult). Renaming a field or changing the shape ripples across
 * TASK-5 (analyze) and TASK-7 (writeReport) — change the contract first.
 */
import { z } from "zod";
import { Type, type Schema } from "@google/genai";

// --- Single source of truth: the enums (exact values per ADR-006) ---

/** Nature of the item. Fixed, identical for every video. */
export const CATEGORIES = [
  "problem",
  "idea",
  "question",
  "decision",
  "followup",
  "praise",
] as const;

/** Session metadata inferred in the overview step. Tunes attention, never changes CATEGORIES. */
export const REVIEW_TYPES = [
  "ui_design",
  "dev_vs_design",
  "documentation",
  "mixed",
  "other",
] as const;

export const PRIORITIES = ["low", "med", "high"] as const;

/**
 * "mm:ss" per the pipeline contract. Minutes may exceed 59 on long recordings
 * (e.g. "92:15") since we don't use an h:mm:ss form; seconds are 00–59.
 * Gemini's Schema can't express a string pattern, so this constraint lives only
 * in Zod — the Gemini side states the format in the field description instead.
 */
export const TIMESTAMP_PATTERN = /^\d{1,3}:[0-5]\d$/;

/**
 * `suggested_name` — a kebab-case, English session name Gemini proposes in the
 * overview step (TASK-22). Lowercase alphanumeric words joined by single
 * hyphens, no leading/trailing/doubled hyphens (e.g. "onboarding-step-2-review").
 * Capped at 60 chars in the schema. This is the display-name single source of
 * truth persisted in tasks.json; the folder itself stays a timestamp (the
 * File System Access API can't rename a directory), so a pretty name is RESOLVED
 * for display, never applied to the folder.
 */
export const SUGGESTED_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Upper bound on a suggested_name (kept in step with the Zod `.max`). */
export const SUGGESTED_NAME_MAX = 60;

/**
 * Coerce any string to a valid `suggested_name` (kebab-case) — used to tame a
 * Gemini overview reply that comes back slightly off-format (a stray capital,
 * spaces, punctuation) instead of failing the whole analysis on a naming nit.
 * Returns `undefined` when nothing usable survives, so the caller falls back to
 * the timestamp folder name. The output always satisfies SUGGESTED_NAME_PATTERN.
 */
export function kebabCase(raw: string): string | undefined {
  const slug = raw
    .normalize("NFKD") // split accents off their base letters …
    .replace(/[\u0300-\u036f]/g, "") // … then drop the marks so "Réview" -> "review", not "re-view"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics -> one hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, SUGGESTED_NAME_MAX)
    .replace(/-+$/g, ""); // re-trim if the slice cut mid-hyphen
  return slug.length > 0 ? slug : undefined;
}

/**
 * Convert a "mm:ss" timestamp to whole seconds ("92:15" -> 5535). This is the
 * seam the glue command (TASK-8) uses to feed extractScreenshots, which takes
 * seconds (ARCHITECTURE §Pipeline contracts). It lives here because this module
 * owns the "mm:ss" format; callers pass timestamps that already validated
 * against TIMESTAMP_PATTERN (i.e. straight off an AnalysisResult), so no
 * re-validation is needed.
 */
export function mmssToSec(mmss: string): number {
  const [minutes, seconds] = mmss.split(":");
  return Number(minutes) * 60 + Number(seconds);
}

/**
 * Inverse of mmssToSec: whole seconds -> "mm:ss" (5535 -> "92:15"). The long-video
 * stage (TASK-9) uses this to write back GLOBAL timestamps after shifting each
 * segment's local "mm:ss" by the segment's start offset. Minutes are NOT capped at
 * 59 — a long recording legitimately reaches "92:15" — which is exactly what
 * TIMESTAMP_PATTERN allows (up to 3 minute digits). Seconds are floored to a whole
 * number to match the schema (timestamps are whole seconds).
 */
export function secToMmss(totalSec: number): string {
  const whole = Math.max(0, Math.floor(totalSec));
  const mm = String(Math.floor(whole / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// --- Representation 1: Zod (runtime validation) ---

const timestamp = (field: string) =>
  z
    .string()
    .regex(TIMESTAMP_PATTERN, `${field} must be "mm:ss" (e.g. "03:42")`);

export const VellumTaskSchema = z.object({
  timestamp: timestamp("timestamp"),
  screenshot_timestamp: timestamp("screenshot_timestamp"),
  title: z.string().min(1),
  description: z.string().min(1),
  screen_context: z.string().min(1),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
});

/** Cost modes (TASK-46 adds "economy"; today every run is "thorough"). */
export const ANALYSIS_MODES = ["thorough", "economy"] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

/**
 * Output language of the analysis (TASK-49). "en" is the default and keeps the
 * historical English-only behavior (ADR-006); "uk" instructs Gemini to NORMALIZE
 * whatever was spoken (Ukrainian / Russian / surzhyk) into clean standard
 * Ukrainian for the natural-language fields. This never changes the enum codes
 * (category / review_type / priority) or suggested_name, which stay English /
 * kebab-ASCII — see the prompt builders.
 */
export const ANALYSIS_LANGUAGES = ["en", "uk"] as const;
export type AnalysisLanguage = (typeof ANALYSIS_LANGUAGES)[number];

/**
 * How a run was produced (TASK-60, ADR-024). Pure telemetry, NOT a Gemini field:
 *   - "analyze"      — the grounded video pipeline (the original path).
 *   - "revise-text"  — a text-only comment→AI revise (no video re-upload).
 *   - "revise-video" — a comment→AI revise re-grounded on the recording (full
 *                      video pipeline + the reviewer's comments woven in).
 * Lets the Details/run-history tab label a revise apart from a fresh analysis.
 */
export const ANALYSIS_ORIGINS = ["analyze", "revise-text", "revise-video"] as const;
export type AnalysisOrigin = (typeof ANALYSIS_ORIGINS)[number];

/**
 * Per-run analysis metadata (TASK-45), the foundation for model/token/cost
 * visibility (info tab TASK-48, picker TASK-47). NOT produced by Gemini — the
 * pipeline assembles it from each generateContent call's usageMetadata AFTER the
 * model output is parsed, and stamps it onto the result. Hence it is deliberately
 * ABSENT from `ANALYSIS_RESPONSE_SCHEMA` (Gemini never fills it).
 *
 * Every field is best-effort telemetry, so the whole block is optional (ADR-008):
 * a tasks.json written before TASK-45 has no `run` and must still parse. History
 * across re-analyses is the ADR-009 archives (tasks-<ts>.json), each carrying the
 * `run` it was written with.
 */
export const AnalysisRunSchema = z.object({
  /** ISO 8601, stamped server-side when the run finished (`new Date().toISOString()`). */
  analyzedAt: z.string().min(1),
  mode: z.enum(ANALYSIS_MODES),
  /**
   * Output language the run was asked for (TASK-49). Optional so a tasks.json
   * written before TASK-49 still parses (ADR-008); fresh runs always stamp it,
   * defaulting to "en".
   */
  language: z.enum(ANALYSIS_LANGUAGES).optional(),
  /**
   * How this run was produced (TASK-60). Optional so a tasks.json written before
   * TASK-60 still parses (ADR-008); fresh runs always stamp it. Absent → treat as
   * "analyze" (the only origin that existed before revise).
   */
  origin: z.enum(ANALYSIS_ORIGINS).optional(),
  /** Models actually used, in first-use order — primary first, then any fallback (ADR-021). */
  models: z.array(z.string()),
  tokensIn: z.number(),
  tokensOut: z.number(),
  /** Omitted (not zero) when a used model has no known price — never guess a cost. */
  costUsd: z.number().optional(),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

export const AnalysisResultSchema = z.object({
  review_type: z.enum(REVIEW_TYPES),
  overview: z.string().min(1),
  // OPTIONAL on purpose: a tasks.json written before TASK-22 has no
  // suggested_name, and it must still parse (ADR-008 — a schema addition can't
  // make an existing session malformed). Gemini's responseSchema requires it, so
  // fresh analyses always carry one; older sessions fall back to the folder name.
  suggested_name: z
    .string()
    .regex(SUGGESTED_NAME_PATTERN, "suggested_name must be kebab-case (e.g. \"onboarding-review\")")
    .max(SUGGESTED_NAME_MAX)
    .optional(),
  tasks: z.array(VellumTaskSchema),
  // Pipeline-assembled telemetry (TASK-45), not a Gemini field — see
  // AnalysisRunSchema. Optional so pre-TASK-45 sessions still parse (ADR-008) and
  // excluded from the Gemini cross-check in assertSchemasAgree (NON_GEMINI_FIELDS).
  run: AnalysisRunSchema.optional(),
});

export type VellumTask = z.infer<typeof VellumTaskSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

// The two enum axes as types (ARCHITECTURE.md §Pipeline contracts names both).
// Consumed by the analysis stage and its prompts (TASK-5).
export type ReviewType = (typeof REVIEW_TYPES)[number];
export type Category = (typeof CATEGORIES)[number];

// --- Representation 2: Gemini responseSchema (OpenAPI subset we send) ---

const enumField = (values: readonly string[], description: string): Schema => ({
  type: Type.STRING,
  enum: [...values],
  description,
});

const TASK_SCHEMA: Schema = {
  type: Type.OBJECT,
  description: "One actionable item extracted from the review.",
  properties: {
    timestamp: {
      type: Type.STRING,
      description: 'When the item was discussed in the recording, as "mm:ss".',
    },
    screenshot_timestamp: {
      type: Type.STRING,
      description:
        'When the item is best *visible* on screen, as "mm:ss". This may differ from `timestamp` — pick the moment the issue is clearest, not when it was spoken about.',
    },
    title: {
      type: Type.STRING,
      description: "Short, specific, actionable title (English).",
    },
    description: {
      type: Type.STRING,
      description:
        "Rich description: what was on screen + what was said + why it matters (English).",
    },
    screen_context: {
      type: Type.STRING,
      description: "What screen/view/state the recording is showing at this moment.",
    },
    category: enumField(
      CATEGORIES,
      "The nature of the item. Use exactly one of the allowed values.",
    ),
    priority: enumField(PRIORITIES, "Relative urgency of acting on the item."),
  },
  required: [
    "timestamp",
    "screenshot_timestamp",
    "title",
    "description",
    "screen_context",
    "category",
    "priority",
  ],
  // Gemini emits fields in this order; mirrors the contract's VellumTask order.
  propertyOrdering: [
    "timestamp",
    "screenshot_timestamp",
    "title",
    "description",
    "screen_context",
    "category",
    "priority",
  ],
};

export const ANALYSIS_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    review_type: enumField(
      REVIEW_TYPES,
      "The kind of review session, inferred from the overall recording.",
    ),
    overview: {
      type: Type.STRING,
      description: "Structural overview of the recording: what it is and its overall context.",
    },
    suggested_name: {
      type: Type.STRING,
      description:
        'A concise, kebab-case English name for this session, derived from what it is ' +
        'about (e.g. "onboarding-step-2-review", "settings-page-polish"). Lowercase ' +
        "words joined by single hyphens; no spaces, punctuation, or file extension.",
    },
    tasks: {
      type: Type.ARRAY,
      items: TASK_SCHEMA,
      description: "Every actionable item found, in the order discussed.",
    },
  },
  required: ["review_type", "overview", "suggested_name", "tasks"],
  propertyOrdering: ["review_type", "overview", "suggested_name", "tasks"],
};

// --- Cross-check: the two representations must describe the same structure ---

/**
 * Fields on AnalysisResultSchema that are pipeline-assembled telemetry, NOT part
 * of the Gemini request/response contract, so they must be excluded from the
 * cross-check with ANALYSIS_RESPONSE_SCHEMA (Gemini never fills them — TASK-45).
 */
const NON_GEMINI_FIELDS = ["run"] as const;

function objectKeys<T extends z.ZodRawShape>(schema: z.ZodObject<T>): string[] {
  return Object.keys(schema.shape)
    .filter((k) => !NON_GEMINI_FIELDS.includes(k as (typeof NON_GEMINI_FIELDS)[number]))
    .sort();
}

function geminiKeys(schema: Schema): string[] {
  return Object.keys(schema.properties ?? {}).sort();
}

function sameMembers(a: readonly string[], b: readonly string[]): string | null {
  const as = [...a].sort();
  const bs = [...b].sort();
  if (as.length === bs.length && as.every((v, i) => v === bs[i])) return null;
  return `expected [${as.join(", ")}], got [${bs.join(", ")}]`;
}

/**
 * Fails loud if the hand-written Zod and Gemini representations drift apart —
 * field names per object, plus the enum members. The enums share `const`
 * arrays so they can't really diverge, but checking them here also catches a
 * hand-edit to the Gemini schema. Run by `npm run validate:schema`.
 */
export function assertSchemasAgree(): void {
  const errors: string[] = [];

  const resultDelta = sameMembers(
    objectKeys(AnalysisResultSchema),
    geminiKeys(ANALYSIS_RESPONSE_SCHEMA),
  );
  if (resultDelta) errors.push(`AnalysisResult fields differ: ${resultDelta}`);

  const taskGemini = ANALYSIS_RESPONSE_SCHEMA.properties?.tasks?.items;
  if (!taskGemini) {
    errors.push("Gemini schema is missing tasks.items");
  } else {
    const taskDelta = sameMembers(objectKeys(VellumTaskSchema), geminiKeys(taskGemini));
    if (taskDelta) errors.push(`VellumTask fields differ: ${taskDelta}`);
  }

  const enumChecks: Array<[string, readonly string[], Schema | undefined]> = [
    ["review_type", REVIEW_TYPES, ANALYSIS_RESPONSE_SCHEMA.properties?.review_type],
    ["category", CATEGORIES, taskGemini?.properties?.category],
    ["priority", PRIORITIES, taskGemini?.properties?.priority],
  ];
  for (const [name, expected, field] of enumChecks) {
    const delta = sameMembers(expected, field?.enum ?? []);
    if (delta) errors.push(`${name} enum differs: ${delta}`);
  }

  if (errors.length > 0) {
    throw new Error(`Schema representations disagree:\n- ${errors.join("\n- ")}`);
  }
}
