/**
 * Stored task model (TASK-54, ADR-025) — the shape `tasks.json` actually holds
 * going forward. It is a thin STORAGE layer LAYERED ON TOP of the Gemini contract
 * in `schema.ts`; it never edits VellumTask / AnalysisResult / ANALYSIS_RESPONSE_SCHEMA,
 * so `assertSchemasAgree()` and `npm run validate:schema` stay valid.
 *
 * What storage adds over the model's raw output (none of this is produced by Gemini):
 *   - id         — stable per-task identity, assigned at WRITE time. Enables
 *                  provenance (edited markers / revert), comment anchoring, and
 *                  structural edits (reorder / add / delete) — ADR-024.
 *   - origin     — 'ai' (extracted by Gemini) | 'human' (added by the reviewer).
 *   - screenshot — the resolved frame filename ("frame-03-42.png"). ADR-025 pins
 *                  the file to the task here so reorder/add/delete stop mis-pairing
 *                  (the ADR-013 derive-by-replay was order-dependent). Derived by
 *                  replay ONCE at upgrade/initial-write, then it just rides along.
 *   - note       — optional per-task human annotation.
 * StoredAnalysisResult additionally carries a session-level `note`.
 *
 * Human-added tasks relax the Gemini-required optionals (a manual task may have no
 * timestamp / frame / on-screen context); `title` stays required. `screenshot` is
 * likewise optional so a human task with no frame is representable — AI/upgraded
 * tasks always carry one (see `upgrade`), a human one may omit it.
 *
 * The Gemini-contract fields are reused straight from the schemas' `.shape` so the
 * two layers can't silently drift.
 */
import { z } from "zod";
import {
  AnalysisResultSchema,
  VellumTaskSchema,
  type AnalysisResult,
  type VellumTask,
} from "./schema";

/** Provenance of a stored task. Assigned at write time, never by Gemini. */
export const TASK_ORIGINS = ["ai", "human"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

export const StoredVellumTaskSchema = z.object({
  // --- Storage-only fields (not part of the Gemini contract) ---
  id: z.string().min(1),
  origin: z.enum(TASK_ORIGINS),
  // Optional: an AI/upgraded task always has a resolved frame; a human-added task
  // may have none (no screenshot_timestamp to derive from).
  screenshot: z.string().min(1).optional(),
  note: z.string().optional(),

  // --- Gemini-contract fields, reused from VellumTaskSchema.shape so they can't
  //     drift from the model's output. Three are relaxed to optional for
  //     human-added tasks (ADR-025); title/description/category/priority stay
  //     required exactly as Gemini emits them.
  timestamp: VellumTaskSchema.shape.timestamp.optional(),
  screenshot_timestamp: VellumTaskSchema.shape.screenshot_timestamp.optional(),
  screen_context: VellumTaskSchema.shape.screen_context.optional(),
  title: VellumTaskSchema.shape.title,
  description: VellumTaskSchema.shape.description,
  category: VellumTaskSchema.shape.category,
  priority: VellumTaskSchema.shape.priority,
});

export const StoredAnalysisResultSchema = z.object({
  // Session-level fields reused from AnalysisResultSchema.shape (single-sourced).
  review_type: AnalysisResultSchema.shape.review_type,
  overview: AnalysisResultSchema.shape.overview,
  suggested_name: AnalysisResultSchema.shape.suggested_name,
  run: AnalysisResultSchema.shape.run,
  // Storage-only: a session-level human annotation (ADR-025).
  note: z.string().optional(),
  tasks: z.array(StoredVellumTaskSchema),
});

export type StoredVellumTask = z.infer<typeof StoredVellumTaskSchema>;
export type StoredAnalysisResult = z.infer<typeof StoredAnalysisResultSchema>;

/**
 * Back-compat reader for a `tasks.json` that may be EITHER the new stored shape
 * (has id/origin/screenshot) OR a legacy bare AnalysisResult (pre-ADR-025, none of
 * those). It never throws — mirrors session-data.ts's ergonomics (safeParse →
 * "malformed" instead of an exception) so the session view degrades instead of
 * crashing on bad data.
 *
 * We try the stored schema first, then fall back to the legacy schema. The result
 * is discriminated so the caller can react to provenance:
 *   - "stored" → use `result` directly.
 *   - "legacy" → an un-upgraded session; render it as-is, or call `upgrade()` when
 *                it's first edited / rewritten (ADR-025's lazy upgrade).
 *   - "malformed" → not valid JSON-shape for either layer.
 *
 * `json` is the already-JSON-parsed value (this function does no JSON.parse, so a
 * SyntaxError stays the caller's concern, exactly like session-data.ts today).
 */
export type StoredParseResult =
  | { status: "stored"; result: StoredAnalysisResult }
  | { status: "legacy"; result: AnalysisResult }
  | { status: "malformed" };

export function parseStoredResult(json: unknown): StoredParseResult {
  const stored = StoredAnalysisResultSchema.safeParse(json);
  if (stored.success) return { status: "stored", result: stored.data };

  const legacy = AnalysisResultSchema.safeParse(json);
  if (legacy.success) return { status: "legacy", result: legacy.data };

  return { status: "malformed" };
}

/**
 * Prefix + index id scheme: the task at position `i` gets `t${i + 1}` → "t1", "t2", …
 * Deterministic and stable for a given task order, which is all an initial upgrade
 * needs. (Later structural edits mint fresh ids for ADDED tasks; that lives in the
 * write path, TASK-55/56, not here.)
 */
function taskId(index: number): string {
  return `t${index + 1}`;
}

/**
 * Mint a collision-free id for a NEWLY ADDED (human) task in Edit mode (TASK-58).
 *
 * The upgrade scheme above is POSITION-based (`t${i+1}`), so a new task must NOT
 * reuse that shape — after a later reorder/delete a position-based id could collide
 * with an existing one. We mint an `h`-prefixed id whose number is one past the
 * LARGEST numeric suffix among ALL current ids: the distinct prefix keeps it clear
 * of the `t*` space, and taking max+1 (not a running count) means deleting then
 * re-adding never reuses a still-live id — every current suffix is <= max, so
 * `h${max+1}` differs from all of them.
 */
export function mintTaskId(tasks: StoredVellumTask[]): string {
  let max = 0;
  for (const task of tasks) {
    const match = /(\d+)$/.exec(task.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `h${max + 1}`;
}

/**
 * Lazy upgrade (ADR-025): turn a legacy AnalysisResult into a StoredAnalysisResult —
 * assign stable ids, stamp origin='ai' on every existing task (they all came from
 * Gemini), and resolve each task's screenshot filename.
 *
 * `deriveNames` is injected rather than imported so the frame-naming algorithm stays
 * single-sourced in `screenshots.ts` (deriveScreenshotNames) AND this module stays
 * free of that file's DOM/filesystem dependencies. Callers pass the real
 * `deriveScreenshotNames`; it MUST be walked over the tasks in array order (its
 * "-N" same-second collision suffixing is order-dependent — ADR-013), so we hand it
 * the whole `tasks` array and pair the returned names back by position.
 *
 * Notes are absent on upgrade — nothing was annotated yet.
 */
export function upgrade(
  legacy: AnalysisResult,
  // Returns a frame filename per task in array order. TASK-60 (text-only revise)
  // passes back `undefined` for a task whose timestamp has no existing frame, so
  // that task simply carries no `screenshot` (renders "no preview") — the analyze
  // path always returns a name for every task, so this is byte-identical there.
  deriveNames: (tasks: VellumTask[]) => (string | undefined)[],
): StoredAnalysisResult {
  const names = deriveNames(legacy.tasks);

  const tasks: StoredVellumTask[] = legacy.tasks.map((task, i) => ({
    id: taskId(i),
    origin: "ai",
    screenshot: names[i],
    ...task,
  }));

  return {
    review_type: legacy.review_type,
    overview: legacy.overview,
    suggested_name: legacy.suggested_name,
    run: legacy.run,
    tasks,
  };
}
