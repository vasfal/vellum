/**
 * Comment model (TASK-59, ADR-024) — the plannotator ANNOTATION layer stored in a
 * per-version `comments.json` sidecar beside the session's tasks.json/report.md.
 *
 * Comments are a SEPARATE sidecar from the analysis contract: Comment mode never
 * touches tasks.json / report.md (that is Edit mode's job, ADR-024). A comment is
 * either ANCHORED to a span of a task field / the overview (kind "anchor") or a
 * GLOBAL note on the whole session (kind "global").
 *
 * Anchoring is deliberately QUOTE-BASED (ADR-024 — "best-effort"): we store the
 * selected substring, its task id, and which field it came from, NOT character
 * offsets. This is robust enough for highlighting and survives most edits; when the
 * quoted text no longer appears (a later Edit changed it) the comment DEGRADES to
 * task-level rather than being lost (see `resolveCommentAnchor`).
 *
 * Client-safe: pure Zod + string logic, no node:* / DOM. TASK-60 ("Process
 * comments") reads this same shape to feed Gemini; it is not wired here.
 */
import { z } from "zod";

/** An anchored comment points at a span; a global one has no anchor. */
export const COMMENT_KINDS = ["anchor", "global"] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

/** The fields a comment can anchor to. `overview` is session-level (no taskId);
 *  the other three are per-task text fields (see report-document.tsx). */
export const COMMENT_FIELDS = [
  "title",
  "description",
  "screen_context",
  "overview",
] as const;
export type CommentField = (typeof COMMENT_FIELDS)[number];

export const CommentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(COMMENT_KINDS),
  // Present only for an anchor comment on a task field. Absent for a global
  // comment and for an overview anchor (which is session-level, no task).
  taskId: z.string().min(1).optional(),
  field: z.enum(COMMENT_FIELDS).optional(),
  // The selected substring the comment is anchored to (the quote). Absent for a
  // global comment.
  quote: z.string().min(1).optional(),
  // The comment text itself — always required.
  body: z.string().min(1),
  createdAt: z.string().min(1),
});

export type Comment = z.infer<typeof CommentSchema>;

/** The on-disk shape of comments.json. */
export const CommentsFileSchema = z.object({
  comments: z.array(CommentSchema),
});

export type CommentsFile = z.infer<typeof CommentsFileSchema>;

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
 *   - "anchored" — the quote still appears in its task/field; highlight the span.
 *   - "degraded" — the task still exists but its text no longer contains the quote
 *                  (a later Edit changed it); keep the comment, attach it at task
 *                  level, don't highlight.
 *   - "orphan"   — the task the comment pointed at is gone (deleted), OR the
 *                  comment is global; list it as a general/session comment.
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
 * side-effect free — this is the degraded-anchor logic the UI renders from and the
 * TASK-59 throwaway script exercises.
 *
 * - A global comment is always "orphan" (session-level; nothing to anchor to).
 * - An overview anchor checks the quote against `overview`.
 * - A task-field anchor looks the task up by id: gone → "orphan"; present and the
 *   quote still occurs in the field → "anchored"; present but the quote is missing
 *   → "degraded".
 */
export function resolveCommentAnchor(
  comment: Comment,
  tasks: AnchorTarget[],
  overview: string,
): CommentAnchorStatus {
  if (comment.kind === "global" || !comment.quote) return "orphan";

  if (comment.field === "overview" && comment.taskId === undefined) {
    return overview.includes(comment.quote) ? "anchored" : "degraded";
  }

  const task = comment.taskId
    ? tasks.find((t) => t.id === comment.taskId)
    : undefined;
  if (!task) return "orphan"; // the anchored task was deleted

  const haystack =
    comment.field === "title"
      ? task.title
      : comment.field === "description"
        ? task.description
        : comment.field === "screen_context"
          ? task.screen_context ?? ""
          : "";

  return haystack.includes(comment.quote) ? "anchored" : "degraded";
}
