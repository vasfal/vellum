/**
 * Prompt for the comment→AI-revise loop (TASK-60, ADR-024), the plannotator
 * essence: take a PRIOR analysis + the reviewer's comments and produce a REVISED
 * AnalysisResult. Two builders share the same instruction core:
 *
 *   • buildRevisePrompt        — the TEXT-ONLY revise (no video). The whole input
 *     (overview, review_type, every task, every comment) is serialized into the
 *     prompt; Gemini reasons over the text alone.
 *   • buildReviseVideoContext  — a compact CONTEXT block for the re-run-with-video
 *     path. It is prepended to the normal analysis prompts (via analyze()'s
 *     reviseContext / analyzeLong's, using withContext), so Gemini re-watches the
 *     recording WITH the prior tasks + comments in mind. It must NOT restate the
 *     output schema/fields — the analysis prompt it precedes already does.
 *
 * Versioning: bump REVISE_PROMPT_VERSION on any wording change (mirrors
 * PROMPT_VERSION in extract-tasks.ts) so a revised tasks.json traces to its prompt.
 *
 * Language: same policy as extract-tasks.ts — English by default; "uk" appends the
 * Ukrainian normalization override. The fixed codes (category / review_type /
 * priority) and suggested_name stay English/kebab-ASCII regardless.
 *
 * Client-safe: pure string building over schema enums + the Comment/stored types.
 */
import {
  CATEGORIES,
  PRIORITIES,
  REVIEW_TYPES,
  type AnalysisLanguage,
  type ReviewType,
} from "../schema";
import type { StoredVellumTask } from "../stored";
import type { Comment } from "@/lib/comments/comment";

/** Bump on ANY change to the wording below. Recorded alongside revised output. */
export const REVISE_PROMPT_VERSION = "2026-07-07.revise-2";

const reviewTypeList = REVIEW_TYPES.join(", ");
const categoryList = CATEGORIES.join(", ");
const priorityList = PRIORITIES.join(", ");

/**
 * Ukrainian override, identical in intent to extract-tasks.ts's — flips the
 * natural-language fields to clean standard Ukrainian, leaves codes + suggested_name
 * alone. Kept local so the two prompt files stay independent (a change to one must
 * not silently alter the other).
 */
const UKRAINIAN_OUTPUT_INSTRUCTION = [
  "OUTPUT LANGUAGE — Ukrainian. This OVERRIDES every instruction above that says",
  "to write in English:",
  "Write ALL natural-language output (overview, task title, description,",
  "screen_context) in clean standard Ukrainian. Normalize Russian/surzhyk to",
  "correct Ukrainian; do NOT preserve them.",
  "Do NOT translate the fixed codes: `category`, `review_type`, and `priority`",
  "must stay their exact English enum values. `suggested_name` must stay",
  "kebab-case ASCII.",
].join("\n");

function withLanguage(prompt: string, language: AnalysisLanguage): string {
  return language === "uk" ? `${prompt}\n\n${UKRAINIAN_OUTPUT_INSTRUCTION}` : prompt;
}

/** The prior analysis the revise operates on (a subset of StoredAnalysisResult). */
export interface ReviseSource {
  overview: string;
  review_type: ReviewType;
  tasks: StoredVellumTask[];
}

/**
 * A stable, unmistakable handle for one task: its 1-based POSITION, its title in
 * quotes, and its id — e.g. `#2 “Relabel the Save button” (t2)`. Group comments
 * (TASK-68.3) expand every id they reference through this so "merge these" names
 * EXACTLY which tasks to merge, by three independent cues the model can't confuse.
 */
function taskHandle(task: StoredVellumTask, index: number): string {
  return `#${index + 1} “${task.title}” (${task.id})`;
}

/** Serialize the current tasks so Gemini can map comments to them by position + `[id]`. */
function renderTasks(tasks: StoredVellumTask[]): string {
  if (tasks.length === 0) return "(no tasks yet)";
  return tasks
    .map((t, i) => {
      const lines = [
        `- #${i + 1} [${t.id}] (${t.category}, ${t.priority}) ${t.title}`,
        `    when: ${t.timestamp ?? "—"}  frame: ${t.screenshot_timestamp ?? "—"}`,
        `    description: ${t.description}`,
      ];
      if (t.screen_context) lines.push(`    screen: ${t.screen_context}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Serialize the reviewer's comments, each tagged with what it targets (TASK-68.2:
 *  a field range, an overview range, a whole task, a GROUP of tasks, or the whole
 *  session). A group comment (`tasks`) is expanded to the FULL handle of every task
 *  it spans — `#position “title” (id)` — so the model knows precisely which tasks to
 *  restructure (merge/split/reorder) per the GROUP_COMMENT_RUBRIC (TASK-68.3). The
 *  live `tasks` are passed in so ids resolve to their current position + title. */
function renderComments(comments: Comment[], tasks: StoredVellumTask[]): string {
  if (comments.length === 0) return "(no comments)";
  return comments
    .map((c) => {
      const t = c.target;
      switch (t.type) {
        case "global":
          return `- [session] ${c.body}`;
        case "overview":
          return `- [overview] re: “${t.quote}” ${c.body}`;
        case "field":
          return `- [task ${t.taskId} (${t.field})] re: “${t.quote}” ${c.body}`;
        case "task":
          return `- [task ${t.taskId}] ${c.body}`;
        case "tasks": {
          // Expand each referenced id to its handle so the group is unambiguous;
          // a since-deleted id degrades to a plain marker rather than vanishing.
          const handles = t.taskIds.map((id) => {
            const idx = tasks.findIndex((x) => x.id === id);
            return idx === -1 ? `(${id}, no longer present)` : taskHandle(tasks[idx], idx);
          });
          return `- [group of ${t.taskIds.length} tasks → ${handles.join("; ")}] ${c.body}`;
        }
      }
    })
    .join("\n");
}

/**
 * The structural rubric for GROUP comments (a comment whose target spans several
 * tasks — TASK-68.3). Without it, the model treats "merge these" as an in-place
 * text tweak; with it, a group comment restructures the task SET. Shared verbatim
 * by both revise paths (text-only + with-video) so the two behave identically.
 */
const GROUP_COMMENT_RUBRIC = [
  "GROUP COMMENTS — a comment addressed to SEVERAL tasks at once (shown as",
  '"[group of N tasks → …]") is a STRUCTURAL instruction: it changes the SHAPE of',
  "the task set, not just the wording of one task. Act on EXACTLY the tasks it",
  "names (each given as #position “title” (id)) and no others:",
  '  • MERGE ("merge these", "combine", "these are the same task", "dedupe") —',
  "    output a SINGLE task in place of all the named ones. Write one title +",
  "    description that covers everything they collectively raised. For its",
  "    timecodes: set `timestamp` to the EARLIEST `when` among the merged tasks",
  "    (the moment the topic was first discussed), and keep the",
  "    `screenshot_timestamp` of the single most representative task — default to",
  "    that same earliest task's frame. Carry over the highest `priority` among",
  "    them. Do NOT leave the originals behind: N tasks become exactly 1.",
  '  • SPLIT ("split this", "these are separate concerns", "break out") — output',
  "    SEVERAL tasks in place of the named one(s), one per distinct concern. Give",
  "    each new task the source task's `when`/frame unless the comment points at a",
  "    different moment.",
  '  • REORDER ("put X before Y", "reorder these", "this should come first") —',
  "    emit the named tasks in the requested order; leave each task's own text and",
  "    timecodes unchanged.",
  'A whole-task comment ("[task id]") or a field comment concerns only THAT one',
  "task — never merge or split on its account.",
].join("\n");

/**
 * TEXT-ONLY revise (the default "Process comments"). Gemini reasons over the
 * serialized prior analysis + comments and returns a fresh AnalysisResult using
 * ANALYSIS_RESPONSE_SCHEMA (the same structured schema analyze uses).
 */
export function buildRevisePrompt(
  source: ReviseSource,
  comments: Comment[],
  language: AnalysisLanguage = "en",
): string {
  return withLanguage(
    [
      "You are REVISING an existing analysis of a design/product review recording,",
      "based on a reviewer's comments. You do NOT have the recording this time —",
      "work from the prior analysis and the comments below.",
      "",
      "PRIOR ANALYSIS",
      `  review_type: ${source.review_type}`,
      `  overview: ${source.overview}`,
      "",
      "  tasks:",
      renderTasks(source.tasks),
      "",
      "REVIEWER COMMENTS (each is either on a specific task/field, on the overview,",
      "on a GROUP of tasks, or on the whole session). Apply ALL of them:",
      renderComments(comments, source.tasks),
      "",
      "Produce a REVISED analysis. You MAY restructure freely to satisfy the",
      "comments: rewrite, merge, split, add, remove, or re-categorize tasks, and",
      "revise the overview. Leave untouched anything no comment concerns.",
      "",
      GROUP_COMMENT_RUBRIC,
      "",
      "Rules:",
      `- \`review_type\` — one of: ${reviewTypeList}. Keep the prior one unless a`,
      "  comment clearly implies otherwise.",
      `- \`category\` — exactly one of: ${categoryList}.`,
      `- \`priority\` — one of: ${priorityList}.`,
      '- `timestamp` / `screenshot_timestamp` — "mm:ss". PRESERVE a retained task\'s',
      "  timestamps unchanged (the extracted screenshots are keyed to them); only",
      "  change a timestamp if a comment is specifically about WHICH moment a task",
      "  refers to. For a genuinely new task, use the most relevant moment you can",
      "  infer from the prior tasks; if none applies, reuse a nearby task's. When a",
      "  GROUP comment MERGES or SPLITS tasks, set the surviving task(s)' timecodes",
      "  by the GROUP COMMENTS rubric above (merge → earliest `when` + the most",
      "  representative frame), not by this preserve rule.",
      "- `title`, `description`, `screen_context` — English, specific, actionable.",
      "- `suggested_name` — keep it meaningful for the (possibly changed) task set;",
      "  kebab-case ASCII, lowercase words joined by single hyphens.",
      "",
      "Return the complete revised analysis (overview, review_type, suggested_name,",
      "and the full task list) — not a diff.",
    ].join("\n"),
    language,
  );
}

/**
 * Re-run-WITH-VIDEO context (TASK-60). A compact block prepended to the normal
 * analysis prompt so the model re-grounds on the recording while honoring the
 * reviewer's feedback. Deliberately does NOT restate the output fields/schema —
 * the analysis prompt it precedes owns that.
 */
export function buildReviseVideoContext(
  source: ReviseSource,
  comments: Comment[],
): string {
  return [
    "REVISION CONTEXT — you previously analyzed THIS recording. Below is that prior",
    "analysis and a reviewer's comments on it. Re-watch the recording and produce a",
    "REVISED analysis that incorporates the comments; use the recording to ground",
    "and correct the prior tasks (you may add, remove, rewrite, merge, split, or",
    "re-categorize them).",
    "",
    `Prior review_type: ${source.review_type}`,
    `Prior overview: ${source.overview}`,
    "",
    "Prior tasks:",
    renderTasks(source.tasks),
    "",
    "Reviewer comments (apply ALL):",
    renderComments(comments, source.tasks),
    "",
    GROUP_COMMENT_RUBRIC,
  ].join("\n");
}
