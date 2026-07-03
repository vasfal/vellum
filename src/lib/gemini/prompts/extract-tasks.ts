/**
 * Prompts for the multi-step analysis pipeline (TASK-5), governed by ADR-006
 * (multi-step pipeline + two-axis task model).
 *
 * These are FIRST DRAFTS. Their wording is deliberately not tuned — task
 * *quality* on real recordings is iterated separately in TASK-21 (the
 * validation gate), which is run last. Do not "improve" these here.
 *
 * Versioning: bump PROMPT_VERSION on any wording change so a recorded
 * `tasks.json` can be traced back to the prompt that produced it. TASK-21 reads
 * this to know which draft generated which output.
 *
 * Language: the DEFAULT output is English, even when the spoken review is in
 * Ukrainian (ARCHITECTURE.md §Gemini prompt strategy). TASK-49 adds an opt-in
 * `language: "uk"` that appends UKRAINIAN_OUTPUT_INSTRUCTION below, flipping the
 * natural-language fields to clean Ukrainian. The English path is byte-identical
 * to before (the builders return the same string when language is "en").
 */
import {
  CATEGORIES,
  PRIORITIES,
  REVIEW_TYPES,
  type AnalysisLanguage,
  type ReviewType,
} from "../schema";

/** Bump on ANY change to the wording below. Recorded alongside output. */
export const PROMPT_VERSION = "2026-07-01.draft-2";

// Rendered into the prompts as plain comma lists so the model sees the exact
// allowed values; the schema enforces them, the prompt explains them.
const reviewTypeList = REVIEW_TYPES.join(", ");
const categoryList = CATEGORIES.join(", ");
const priorityList = PRIORITIES.join(", ");

/**
 * Ukrainian output (TASK-49), appended to any builder when `language` is "uk".
 * It deliberately OVERRIDES the "in English" wording above it: the base prompts
 * default to English, and this block flips the natural-language fields to clean
 * standard Ukrainian while NORMALIZING whatever was spoken (Ukrainian / Russian
 * / surzhyk) rather than preserving surzhyk or Russian. The fixed codes
 * (category / review_type / priority) and `suggested_name` are explicitly called
 * out to stay as-is — codes are schema values, not prose, and suggested_name is
 * a folder/URL id (TASK-22) that must remain kebab-ASCII, never transliterated.
 */
const UKRAINIAN_OUTPUT_INSTRUCTION = [
  "OUTPUT LANGUAGE — Ukrainian. This OVERRIDES every instruction above that says",
  "to write in English:",
  "Write ALL natural-language output (overview, task title, description,",
  "screen_context) in clean standard Ukrainian. The speech may be Ukrainian,",
  "Russian, or surzhyk — normalize it to correct Ukrainian; do NOT preserve",
  "Russian/surzhyk.",
  "Do NOT translate the fixed codes: `category`, `review_type`, and `priority`",
  "must stay their exact English enum values. `suggested_name` must stay",
  "kebab-case ASCII (lowercase a–z, digits, single hyphens) — do NOT",
  "transliterate it into Cyrillic.",
].join("\n");

/**
 * Append the output-language instruction to a base prompt. For "en" the base is
 * returned untouched, so the English path is byte-for-byte what it was before
 * TASK-49; "uk" adds the normalization override at the end.
 */
function withLanguage(prompt: string, language: AnalysisLanguage): string {
  return language === "uk" ? `${prompt}\n\n${UKRAINIAN_OUTPUT_INSTRUCTION}` : prompt;
}

/**
 * Step 1 — structural overview + review_type detection.
 *
 * The model watches the whole recording and commits to a `review_type` BEFORE
 * any task extraction, so step 2 can tune its attention to the kind of review.
 */
export function buildOverviewPrompt(language: AnalysisLanguage = "en"): string {
  return withLanguage([
    "You are analyzing a screen-recording of a design/product review. The reviewer",
    "narrates out loud (possibly in Ukrainian) while moving through screens.",
    "",
    "First, watch the entire recording and form a STRUCTURAL OVERVIEW — do not yet",
    "extract individual tasks.",
    "",
    "Produce three things:",
    "",
    "1. `overview` — a few sentences in ENGLISH describing what this recording is:",
    "   what is being reviewed, the overall context, and the reviewer's apparent",
    "   goal. This is orientation for the extraction step that follows.",
    "",
    `2. \`review_type\` — classify the session as exactly ONE of: ${reviewTypeList}.`,
    "   - ui_design: reviewing visual/interaction design of a UI (e.g. in Figma).",
    "   - dev_vs_design: comparing an implemented build against its design.",
    "   - documentation: checking whether docs/specs match current reality.",
    "   - mixed: clearly spans more than one of the above.",
    "   - other: none of the above fit.",
    "",
    "3. `suggested_name` — a concise, human-meaningful name for this session in",
    "   ENGLISH, kebab-case: lowercase words joined by single hyphens, no spaces,",
    "   punctuation, or file extension. Base it on WHAT is being reviewed, not on the",
    '   date. Aim for 2–5 words (e.g. "onboarding-step-2-review", "settings-page-polish",',
    '   "dashboard-empty-states"). This becomes the session\'s display name.',
    "",
    "Base all three on the whole recording, not just the opening moments.",
  ].join("\n"), language);
}

/**
 * Step 2 — task extraction (with screenshot timestamps), seeded with step 1's
 * overview + review_type so the model extracts in that established context.
 *
 * Per ADR-006 the `category` enum is the SAME for every recording; `review_type`
 * only tunes what the model pays attention to, it never changes the categories.
 * Per B2 (chosen for TASK-5) screenshot timestamps are produced here, in the
 * same pass as the rest of each task — not a separate model round-trip.
 */
export function buildTaskExtractionPrompt(
  overview: string,
  reviewType: ReviewType,
  language: AnalysisLanguage = "en",
): string {
  return withLanguage([
    "You are extracting actionable items from a screen-recording of a review.",
    "",
    "The recording has already been classified. Use this established context and",
    "reuse it verbatim in your output — do not re-derive it:",
    "",
    `  review_type: ${reviewType}`,
    `  overview: ${overview}`,
    "",
    `Because review_type is "${reviewType}", pay particular attention to the kinds`,
    "of findings that matter for that sort of review — but ALWAYS classify every",
    "item using the fixed category set below, regardless of review_type.",
    "",
    "Extract EVERY actionable item the reviewer raises, in the order discussed.",
    "For each item provide:",
    "",
    '- `timestamp` — when it was DISCUSSED, as "mm:ss".',
    '- `screenshot_timestamp` — the moment the item is best VISIBLE on screen, as',
    '  "mm:ss". This is often NOT the same as `timestamp`: pick the frame where the',
    "  thing being discussed is clearest, even if the reviewer talks about it before",
    "  or after that frame.",
    "- `title` — short, specific, actionable (English).",
    "- `description` — rich: what was on screen + what was said + why it matters",
    "  (English).",
    "- `screen_context` — what screen/view/state is shown at that moment.",
    `- \`category\` — exactly one of: ${categoryList}. This describes the NATURE of`,
    "  the item:",
    "    problem (something wrong), idea (a suggestion), question (an open",
    "    question), decision (a choice made), followup (a deferred action),",
    "    praise (something explicitly called out as good).",
    `- \`priority\` — one of: ${priorityList}.`,
    "",
    "Write all output in English even though the narration may be Ukrainian.",
    "If the recording contains no actionable items, return an empty task list.",
  ].join("\n"), language);
}

/**
 * Economy mode (TASK-46) — ONE combined pass. Asks for the overview step's
 * outputs (overview + review_type + suggested_name) AND the task extraction in a
 * single generateContent call, trading the two-pass quality of ADR-006 for ~half
 * the tokens/cost. The CONTENT of the instructions is deliberately the same as
 * the two prompts above (same fields, same enums, same rules) — only the framing
 * differs: everything is produced together instead of in two model passes.
 *
 * priorContext (long-video segments) is prepended by the caller via withContext,
 * exactly as in the two-pass path.
 */
export function buildCombinedPrompt(language: AnalysisLanguage = "en"): string {
  return withLanguage([
    "You are analyzing a screen-recording of a design/product review. The reviewer",
    "narrates out loud (possibly in Ukrainian) while moving through screens.",
    "",
    "Watch the ENTIRE recording, then produce ALL of the following in one response:",
    "",
    "1. `overview` — a few sentences in ENGLISH describing what this recording is:",
    "   what is being reviewed, the overall context, and the reviewer's apparent goal.",
    "",
    `2. \`review_type\` — classify the session as exactly ONE of: ${reviewTypeList}.`,
    "   - ui_design: reviewing visual/interaction design of a UI (e.g. in Figma).",
    "   - dev_vs_design: comparing an implemented build against its design.",
    "   - documentation: checking whether docs/specs match current reality.",
    "   - mixed: clearly spans more than one of the above.",
    "   - other: none of the above fit.",
    "",
    "3. `suggested_name` — a concise, human-meaningful name for this session in",
    "   ENGLISH, kebab-case: lowercase words joined by single hyphens, no spaces,",
    "   punctuation, or file extension. Base it on WHAT is being reviewed, not on the",
    '   date. Aim for 2–5 words (e.g. "onboarding-step-2-review", "settings-page-polish").',
    "",
    "4. `tasks` — EVERY actionable item the reviewer raises, in the order discussed.",
    "   Classify each item using the review_type you chose above to tune attention, but",
    "   ALWAYS use the fixed category set regardless of review_type. For each item:",
    '   - `timestamp` — when it was DISCUSSED, as "mm:ss".',
    '   - `screenshot_timestamp` — the moment the item is best VISIBLE on screen, as',
    '     "mm:ss". This is often NOT the same as `timestamp`: pick the frame where the',
    "     thing being discussed is clearest, even if spoken about before or after it.",
    "   - `title` — short, specific, actionable (English).",
    "   - `description` — rich: what was on screen + what was said + why it matters (English).",
    "   - `screen_context` — what screen/view/state is shown at that moment.",
    `   - \`category\` — exactly one of: ${categoryList}. The NATURE of the item:`,
    "       problem (something wrong), idea (a suggestion), question (an open question),",
    "       decision (a choice made), followup (a deferred action), praise (called out as good).",
    `   - \`priority\` — one of: ${priorityList}.`,
    "",
    "Base all of it on the whole recording, not just the opening moments. Write all",
    "output in English even though the narration may be Ukrainian. If the recording",
    "contains no actionable items, return an empty task list.",
  ].join("\n"), language);
}
