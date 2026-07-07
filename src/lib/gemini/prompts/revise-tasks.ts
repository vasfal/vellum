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
export const REVISE_PROMPT_VERSION = "2026-07-02.revise-1";

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

/** Serialize the current tasks so Gemini can map comments to them by `[id]`. */
function renderTasks(tasks: StoredVellumTask[]): string {
  if (tasks.length === 0) return "(no tasks yet)";
  return tasks
    .map((t) => {
      const lines = [
        `- [${t.id}] (${t.category}, ${t.priority}) ${t.title}`,
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
 *  session). A group comment (`tasks`) names every task it spans so the model can
 *  act on them together — e.g. merge them (the actual merge behavior is TASK-68.3). */
function renderComments(comments: Comment[]): string {
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
        case "tasks":
          return `- [tasks ${t.taskIds.join(", ")}] ${c.body}`;
      }
    })
    .join("\n");
}

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
      "or on the whole session). Apply ALL of them:",
      renderComments(comments),
      "",
      "Produce a REVISED analysis. You MAY restructure freely to satisfy the",
      "comments: rewrite, merge, split, add, remove, or re-categorize tasks, and",
      "revise the overview. Leave untouched anything no comment concerns.",
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
      "  infer from the prior tasks; if none applies, reuse a nearby task's.",
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
    renderComments(comments),
  ].join("\n");
}
