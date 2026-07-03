import { NextResponse } from "next/server";
import { basePrice } from "@/lib/gemini/pricing";

/**
 * GET /api/models — the model list that feeds the pre-analysis picker (TASK-47).
 *
 * The server queries Gemini's models.list REST endpoint (NOT the SDK — this is a
 * plain list read) and returns the video-capable, generateContent-able models,
 * each labelled with a known price (pricing.ts) and a recommended/preview hint.
 *
 * Privacy stance (ARCHITECTURE §Privacy, mirrors key-status): GEMINI_API_KEY
 * lives in .env.local and NEVER leaves the server. It is read here to authorize
 * the upstream call and is never serialized into the response.
 *
 * Failure stance (ARCHITECTURE §Error handling): a missing key or an upstream
 * error returns a structured { error } with an honest status — never a 500 stack
 * trace — so the picker can show a clean "couldn't load models" state and fall
 * back to the built-in default.
 *
 * ADR-021 caveat: models.list can include a model that merely *appears* available
 * but is actually retired for generateContent (gemini-2.0-flash was). So we only
 * mark the LIVE-verified allowlist as `recommended`; everything else is returned
 * as-is for the picker to show with less prominence. We do NOT probe each model
 * here — that would be one paid call per model on every picker open.
 */
export const runtime = "nodejs";

/** One model as the picker consumes it. `id` has the "models/" prefix stripped. */
export interface ModelInfo {
  id: string;
  displayName: string;
  /** LIVE-verified, offer-first (the 2.5 pro/flash/flash-lite allowlist). */
  recommended: boolean;
  /** The id advertises itself as a preview ("preview" in the name). */
  preview: boolean;
  /** USD / 1M input tokens (lower tier for tiered models); omitted when unknown. */
  inputPrice?: number;
  /** USD / 1M output tokens (lower tier for tiered models); omitted when unknown. */
  outputPrice?: number;
}

/** The wire shape: models on success, a structured error otherwise. */
export type ModelsResponse = { models: ModelInfo[] } | { error: string };

/**
 * LIVE-verified against generateContent and offered first in the picker. Kept in
 * step with client.ts's MODEL + FALLBACK_MODELS (the tiers the pipeline trusts).
 */
const RECOMMENDED = new Set(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);

/**
 * Substrings that mark a model id as a NON-video / non-analysis modality we must
 * not offer as a primary analysis model: image generation, text-to-speech,
 * embeddings, the attributed-QA model, and Imagen. Matched case-insensitively
 * against the bare id.
 */
const EXCLUDE_ID_SUBSTRINGS = ["image", "tts", "embedding", "aqa", "imagen"];

/** The raw model shape from models.list — only the fields we read, all optional. */
interface RawModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

export async function GET(): Promise<NextResponse<ModelsResponse>> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "No Gemini API key is configured. Add GEMINI_API_KEY to .env.local." },
      { status: 400 },
    );
  }

  let raw: RawModel[];
  try {
    raw = await fetchAllModels(apiKey);
  } catch (err) {
    // Never leak the key or a stack: the key rides in the upstream URL, so we
    // return only a generic, actionable message (the real cause is logged).
    console.error("[models] failed to list Gemini models:", err);
    return NextResponse.json(
      { error: "Couldn't load the model list from Gemini. Check the API key and try again." },
      { status: 502 },
    );
  }

  const models = raw
    .filter(isAnalysisCapable)
    .map(toModelInfo)
    // toModelInfo needs a usable id; a nameless entry (shouldn't happen) is dropped.
    .filter((m): m is ModelInfo => m !== null);

  return NextResponse.json({ models });
}

/**
 * Page through models.list (pageSize 1000 returns everything in one call for the
 * current catalog, but we still follow nextPageToken defensively, bounded to a
 * few pages so a misbehaving upstream can't loop forever). Throws on a non-OK
 * response so GET() turns it into the structured 502.
 */
async function fetchAllModels(apiKey: string): Promise<RawModel[]> {
  const all: RawModel[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 5; page++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`models.list responded ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { models?: RawModel[]; nextPageToken?: string };
    if (body.models) all.push(...body.models);
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }

  return all;
}

/** Keep only models that can run generateContent and aren't an excluded modality. */
function isAnalysisCapable(model: RawModel): boolean {
  if (!model.supportedGenerationMethods?.includes("generateContent")) return false;
  const id = bareId(model.name);
  return !EXCLUDE_ID_SUBSTRINGS.some((bad) => id.includes(bad));
}

/** Shape one raw model into the picker's ModelInfo, or null if it has no id. */
function toModelInfo(model: RawModel): ModelInfo | null {
  const id = bareId(model.name);
  if (!id) return null;
  const price = basePrice(id);
  return {
    id,
    displayName: model.displayName?.trim() || id,
    recommended: RECOMMENDED.has(id),
    preview: id.includes("preview"),
    // Omit unknown prices entirely (a missing price is not $0 — mirrors costUsd).
    ...(price ? { inputPrice: price.input, outputPrice: price.output } : {}),
  };
}

/** The model id without the "models/" prefix, lowercased for matching. */
function bareId(name: string | undefined): string {
  return (name ?? "").replace(/^models\//, "").trim().toLowerCase();
}
