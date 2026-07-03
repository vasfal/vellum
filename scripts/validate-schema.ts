/**
 * Exercises the TASK-4 schema (src/lib/gemini/schema.ts) offline — no API key,
 * no network. Proves: the two representations agree, a valid sample parses, and
 * an invalid sample is rejected with useful errors.
 *
 *   npm run validate:schema
 */
import {
  AnalysisResultSchema,
  assertSchemasAgree,
  type AnalysisResult,
} from "../src/lib/gemini/schema";

// A representative result. Note `screenshot_timestamp` deliberately differs from
// `timestamp` on every task (ARCHITECTURE §Screenshot strategy / AC#5): the
// issue is best *visible* at a different moment than when it was *spoken about*.
const validSample: AnalysisResult = {
  review_type: "ui_design",
  overview:
    "A Figma walkthrough of the onboarding flow, focusing on the empty-state and the first-run checklist.",
  suggested_name: "onboarding-flow-review",
  tasks: [
    {
      timestamp: "01:12",
      screenshot_timestamp: "01:20",
      title: "Empty-state copy is generic",
      description:
        'On the dashboard empty state the heading reads "Nothing here yet" — Vasyl noted it should speak to the first action the user can take, not just state emptiness.',
      screen_context: "Dashboard, empty state with a centered illustration.",
      category: "problem",
      priority: "med",
    },
    {
      timestamp: "04:38",
      screenshot_timestamp: "05:02",
      title: "Consider a progress checklist on first run",
      description:
        "Idea raised while looking at the home screen: a 3-step checklist could orient new users. Mentioned as a maybe, not a decision.",
      screen_context: "Home screen after sign-in, before any session exists.",
      category: "idea",
      priority: "low",
    },
  ],
};

// Three independent defects: a non-kebab suggested_name, an out-of-enum category,
// and a malformed timestamp.
const invalidSample = {
  review_type: "ui_design",
  overview: "x",
  suggested_name: "Not Kebab Case!", // spaces + punctuation → fails SUGGESTED_NAME_PATTERN
  tasks: [
    {
      timestamp: "1:2", // not mm:ss
      screenshot_timestamp: "01:20",
      title: "t",
      description: "d",
      screen_context: "s",
      category: "blocker", // not in CATEGORIES
      priority: "med",
    },
  ],
};

function main(): void {
  let failures = 0;

  // 1. The two representations describe the same structure (AC#2).
  try {
    assertSchemasAgree();
    console.log("✓ Zod and Gemini responseSchema agree (fields + enums)");
  } catch (err) {
    failures++;
    console.error(`✗ Schemas disagree:\n${(err as Error).message}`);
  }

  // 2. Valid sample parses without errors (AC#1).
  const ok = AnalysisResultSchema.safeParse(validSample);
  if (ok.success) {
    console.log(`✓ Valid sample parsed: ${ok.data.tasks.length} tasks, review_type=${ok.data.review_type}`);
  } else {
    failures++;
    console.error("✗ Valid sample failed to parse:");
    console.error(JSON.stringify(ok.error.issues, null, 2));
  }

  // 3. Invalid sample is rejected — and we show the issues it caught.
  const bad = AnalysisResultSchema.safeParse(invalidSample);
  if (!bad.success) {
    const paths = bad.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    console.log(`✓ Invalid sample rejected with ${bad.error.issues.length} issue(s):`);
    for (const p of paths) console.log(`    - ${p}`);
  } else {
    failures++;
    console.error("✗ Invalid sample parsed but should have been rejected");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll schema checks passed.");
}

main();
