/**
 * Comment model (TASK-59 → TASK-68.2, ADR-024) — the plannotator ANNOTATION layer
 * stored in a per-version `comments.json` sidecar beside tasks.json/report.md.
 *
 * Comments are a SEPARATE sidecar from the analysis contract: commenting never
 * touches tasks.json / report.md (that's inline editing's job). A comment carries a
 * `body` and a `target` describing WHAT it annotates. TASK-68.2 widens the target
 * from "a text range OR the whole session" to FIVE kinds so Google-Docs-style
 * commenting can address the document at any granularity:
 *
 *   • field    — a text RANGE inside one task field (title/description/screen_context)
 *   • overview — a text RANGE inside the session overview
 *   • task     — a WHOLE task (title + description + screen_context + timecodes)
 *   • tasks    — a GROUP of tasks (e.g. "merge these into one")
 *   • global   — the whole session (no anchor)
 *
 * Anchoring for the two RANGE kinds stays QUOTE-BASED (ADR-024 — no character
 * offsets): we store the selected substring, its task id, and the field. Robust
 * enough to highlight and survives most edits; when the quoted text no longer
 * appears the comment DEGRADES rather than being lost (see resolveCommentAnchor).
 * The task / tasks kinds anchor by id, so they degrade only when a target task is
 * deleted.
 *
 * Back-compat: comments written before TASK-68.2 used a FLAT shape
 * ({ kind, taskId?, field?, quote? }). readComments upgrades them on load via the
 * lenient CommentsFileSchema below; writeComments always persists the new `target`
 * shape, so an old sidecar migrates the first time it's saved.
 *
 * Client-safe: pure Zod + string logic, no node:* / DOM.
 */
import { z } from "zod";

/** The task text fields a RANGE comment can anchor to (the overview is its own
 *  target kind — it's session-level, with no task id). */
export const COMMENT_TASK_FIELDS = [
  "title",
  "description",
  "screen_context",
] as const;
export type CommentTaskField = (typeof COMMENT_TASK_FIELDS)[number];

// ---- the target: a clean discriminated union on `type` ---------------------

/** A text range inside one task field (quote-based, ADR-024). */
const FieldTargetSchema = z.object({
  type: z.literal("field"),
  taskId: z.string().min(1),
  field: z.enum(COMMENT_TASK_FIELDS),
  quote: z.string().min(1),
});
/** A text range inside the session overview. */
const OverviewTargetSchema = z.object({
  type: z.literal("overview"),
  quote: z.string().min(1),
});
/** A whole task, addressed by id (title + description + context + timecodes). */
const TaskTargetSchema = z.object({
  type: z.literal("task"),
  taskId: z.string().min(1),
});
/** A group of tasks, addressed by id (e.g. "merge these"). */
const TasksTargetSchema = z.object({
  type: z.literal("tasks"),
  taskIds: z.array(z.string().min(1)).min(1),
});
/** The whole session (no anchor). */
const GlobalTargetSchema = z.object({ type: z.literal("global") });

export const CommentTargetSchema = z.discriminatedUnion("type", [
  FieldTargetSchema,
  OverviewTargetSchema,
  TaskTargetSchema,
  TasksTargetSchema,
  GlobalTargetSchema,
]);
export type CommentTarget = z.infer<typeof CommentTargetSchema>;

export const CommentSchema = z.object({
  id: z.string().min(1),
  target: CommentTargetSchema,
  // The comment text itself — always required.
  body: z.string().min(1),
  createdAt: z.string().min(1),
});

export type Comment = z.infer<typeof CommentSchema>;

// ---- back-compat: upgrade the pre-68.2 flat shape on read ------------------

/** The flat comment shape used before TASK-68.2 — kept ONLY to migrate old
 *  sidecars. `kind: "anchor"` carried an optional taskId/field/quote; "global"
 *  carried none. The `overview` field value was session-level (no taskId). */
const LegacyCommentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["anchor", "global"]),
  taskId: z.string().min(1).optional(),
  field: z.enum(["title", "description", "screen_context", "overview"]).optional(),
  quote: z.string().min(1).optional(),
  body: z.string().min(1),
  createdAt: z.string().min(1),
});

/** Map a legacy comment onto a new target. A partial/ambiguous legacy anchor
 *  degrades to the coarsest still-valid target rather than being dropped. */
function legacyTarget(c: z.infer<typeof LegacyCommentSchema>): CommentTarget {
  if (c.kind === "global") return { type: "global" };
  if (c.field === "overview") {
    return c.quote ? { type: "overview", quote: c.quote } : { type: "global" };
  }
  if (c.taskId && c.field && c.quote) {
    return { type: "field", taskId: c.taskId, field: c.field, quote: c.quote };
  }
  if (c.taskId) return { type: "task", taskId: c.taskId };
  return { type: "global" };
}

/** One stored comment, accepting EITHER the new `target` shape or a legacy flat one
 *  (upgraded to the new shape). Used only for READING — writes go through the strict
 *  CommentSchema so a malformed comment never reaches disk. */
const StoredCommentSchema: z.ZodType<Comment> = z.union([
  CommentSchema,
  LegacyCommentSchema.transform(
    (c): Comment => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      target: legacyTarget(c),
    }),
  ),
]);

/** The on-disk shape of comments.json (lenient — upgrades legacy comments). */
export const CommentsFileSchema = z.object({
  comments: z.array(StoredCommentSchema),
});

export type CommentsFile = z.infer<typeof CommentsFileSchema>;

/** Strict validator for WRITING — guarantees only the new shape is persisted. */
export const CommentsWriteSchema = z.object({
  comments: z.array(CommentSchema),
});

/**
 * Mint a collision-free id for a new comment. Mirrors mintTaskId (stored.ts): take
 * one past the largest numeric suffix among existing ids so deleting then re-adding
 * never reuses a still-live id. `c`-prefixed to keep it distinct from task ids.
 * Deterministic (no clock / randomness) so it's trivially testable.
 */
export function mintCommentId(existing: Comment[]): string {
  let max = 0;
  for (const c of existing) {
    const match = /(\d+)$/.exec(c.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `c${max + 1}`;
}

/**
 * How an anchor resolves against the CURRENT tasks (ADR-024 degraded-anchor).
 *   - "anchored" — the target is fully present: a range still occurs, or every
 *                  referenced task still exists.
 *   - "degraded" — the target partly survives: a range's task exists but its quote
 *                  no longer occurs (a later edit changed it), or SOME of a group's
 *                  tasks are gone. Keep the comment; don't highlight the lost part.
 *   - "orphan"   — nothing to anchor to: the target task is gone, every group task
 *                  is gone, or the comment is global/session-level.
 */
export type CommentAnchorStatus = "anchored" | "degraded" | "orphan";

/** The minimum a task must expose for anchor resolution (a StoredVellumTask
 *  subset — kept structural so this module stays free of the stored schema). */
export interface AnchorTarget {
  id: string;
  title: string;
  description: string;
  screen_context?: string;
}

/**
 * Resolve a comment's anchor against the current tasks + overview. Pure and
 * side-effect free — the UI renders each comment's status from this.
 */
export function resolveCommentAnchor(
  comment: Comment,
  tasks: AnchorTarget[],
  overview: string,
): CommentAnchorStatus {
  const t = comment.target;
  switch (t.type) {
    case "global":
      return "orphan"; // session-level; nothing to anchor to
    case "overview":
      return overview.includes(t.quote) ? "anchored" : "degraded";
    case "field": {
      const task = tasks.find((x) => x.id === t.taskId);
      if (!task) return "orphan"; // the anchored task was deleted
      const haystack =
        t.field === "title"
          ? task.title
          : t.field === "description"
            ? task.description
            : task.screen_context ?? "";
      return haystack.includes(t.quote) ? "anchored" : "degraded";
    }
    case "task":
      return tasks.some((x) => x.id === t.taskId) ? "anchored" : "orphan";
    case "tasks": {
      const present = t.taskIds.filter((id) => tasks.some((x) => x.id === id));
      if (present.length === 0) return "orphan"; // every grouped task is gone
      return present.length === t.taskIds.length ? "anchored" : "degraded";
    }
  }
}

/** The quote a RANGE comment highlights, or undefined for a non-range target. */
export function commentQuote(comment: Comment): string | undefined {
  const t = comment.target;
  return t.type === "field" || t.type === "overview" ? t.quote : undefined;
}
