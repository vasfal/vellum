// TASK-45 — per-model Gemini pricing, so a run's captured token usage can be
// turned into a dollar estimate for the info tab (TASK-48) and picker (TASK-47).
//
// Cost is an ESTIMATE, deliberately labelled as of a date: prices move, and the
// authoritative source is Google's page (see PRICES_AS_OF). An unknown model —
// or a run that used one — yields NO cost rather than a wrong one (callers omit
// the field). Prices can be overridden at runtime via the GEMINI_PRICING env var
// (JSON) without a code change, mirroring how MODEL/FALLBACK_MODELS are env-tunable.

/** prices as of 2026-07; verify at https://ai.google.dev/gemini-api/docs/pricing */
export const PRICES_AS_OF = "2026-07";

/**
 * A price in USD per 1,000,000 tokens. Either a flat rate, or a two-tier rate
 * that switches at a prompt-size `threshold` (gemini-2.5-pro charges more once a
 * single request's prompt exceeds 200k tokens — for both input and output).
 */
export type Rate = number | { threshold: number; below: number; above: number };

export interface ModelPricing {
  /** USD / 1M input (prompt) tokens. */
  input: Rate;
  /** USD / 1M output tokens — candidates PLUS thinking tokens, both billed here. */
  output: Rate;
}

/**
 * Built-in table (USD per 1M tokens). gemini-2.5-pro is tiered at 200k prompt
 * tokens; the flash tiers are flat. Keep in step with PRICES_AS_OF above.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-pro": {
    input: { threshold: 200_000, below: 1.25, above: 2.5 },
    output: { threshold: 200_000, below: 10.0, above: 15.0 },
  },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
};

/**
 * The active pricing table: the built-in defaults, with any entries from the
 * GEMINI_PRICING env var merged over the top (per-model replacement, not a deep
 * merge). Malformed JSON is ignored with a warning rather than crashing the
 * pipeline — a bad override must never take down analysis (fail soft, telemetry).
 */
function pricingTable(): Record<string, ModelPricing> {
  const raw = process.env.GEMINI_PRICING?.trim();
  if (!raw) return DEFAULT_PRICING;
  try {
    // Trusted-but-loose: the operator sets this, so we parse and shallow-merge
    // without validating every field. The `as` is the intentional escape hatch
    // (env-provided JSON has no compile-time type). A malformed shape simply
    // produces NaN costs downstream for that model, not a crash.
    const override = JSON.parse(raw) as Record<string, ModelPricing>;
    return { ...DEFAULT_PRICING, ...override };
  } catch {
    console.warn("[pricing] GEMINI_PRICING is not valid JSON — using built-in prices.");
    return DEFAULT_PRICING;
  }
}

/** Resolve a possibly-tiered rate for a given prompt size. */
function rateFor(rate: Rate, promptTokens: number): number {
  if (typeof rate === "number") return rate;
  return promptTokens > rate.threshold ? rate.above : rate.below;
}

/** The headline rate for display/comparison: a flat rate as-is, a tiered rate's
 * `below` (the price a typical sub-threshold run pays — gemini-2.5-pro's cheaper
 * tier). Not for costing a real call (use costUsd, which knows the prompt size). */
function baseRate(rate: Rate): number {
  return typeof rate === "number" ? rate : rate.below;
}

/**
 * The lower-tier (or flat) USD-per-1M input/output rates for a model, for the
 * model picker's price labels (TASK-47/50) and the fallback-chain "not pricier"
 * comparison (analyze.ts). Tiered models report their `below` rate. Returns
 * `undefined` for a model with no known price, so callers OMIT the field —
 * mirroring costUsd (a missing price is not a $0 price).
 */
export function basePrice(model: string): { input: number; output: number } | undefined {
  const pricing = pricingTable()[model];
  if (!pricing) return undefined;
  return { input: baseRate(pricing.input), output: baseRate(pricing.output) };
}

/**
 * Estimated USD cost of one Gemini call. `promptTokens` selects the pricing tier
 * for tiered models (gemini-2.5-pro splits at 200k); pass the call's own input
 * token count. Returns `undefined` when the model has no known price, so callers
 * OMIT cost rather than reporting $0 (a missing price ≠ free).
 *
 * Worked example (gemini-2.5-pro, a small run under the 200k tier):
 *   in 120_000, out 8_000  →  120_000/1e6 * 1.25 + 8_000/1e6 * 10.0
 *                          =  0.15 + 0.08  =  $0.23
 */
export function costUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  promptTokens: number,
): number | undefined {
  const pricing = pricingTable()[model];
  if (!pricing) return undefined;
  const inRate = rateFor(pricing.input, promptTokens);
  const outRate = rateFor(pricing.output, promptTokens);
  return (tokensIn / 1_000_000) * inRate + (tokensOut / 1_000_000) * outRate;
}
