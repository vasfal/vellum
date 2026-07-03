import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * GET /api/key-status — a light, read-only check of whether a Gemini key is
 * configured and WHERE it comes from, so the app can steer the user to setup
 * (TASK-29, S11) and decide whether the key is user-removable (TASK-65).
 *
 * Privacy stance (ARCHITECTURE §Privacy): GEMINI_API_KEY NEVER leaves the
 * server. This route reads it server-side and returns ONLY a boolean plus a
 * source label — the key value itself is never serialized into the response.
 *
 * We deliberately do NOT probe Gemini here: a live probe would be a paid call on
 * every Settings open, and it isn't needed for this signal. `present` means "a
 * key is set and looks plausible"; a syntactically-fine but revoked/wrong key
 * still reads as present and only fails loud at analyze time. (Validation now
 * happens at SAVE, in POST /api/key.)
 */
export const runtime = "nodejs";

const ENV_FILE = join(homedir(), ".vellum", ".env");

/**
 * The wire shape. NO key material, ever — only whether one is present and which
 * source it came from. This is a cross-task contract (TASK-65.2/65.3 build
 * against it): don't change the shape.
 *
 * `source` tells a removable saved key from an env-provided one:
 *   - "file" — the active key is the one saved in ~/.vellum/.env; the UI may
 *     offer "remove" (DELETE /api/key clears it).
 *   - "env"  — the active key comes from an exported env var or .env.local,
 *     which shadows the file (bin/vellum.mjs precedence). Not removable from
 *     the UI — deleting the file wouldn't clear it.
 *   - null   — no key present.
 */
export interface KeyStatus {
  present: boolean;
  source: "env" | "file" | null;
}

export async function GET(): Promise<NextResponse<KeyStatus>> {
  const effective = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!isPlausibleKey(effective)) {
    return NextResponse.json({ present: false, source: null });
  }

  // The effective key is present. If it byte-for-byte matches what's saved in
  // ~/.vellum/.env, treat it as file-sourced (removable); otherwise something
  // else (exported var / .env.local, or nothing in the file) is the source.
  const fileKey = await readFileKey();
  const source: KeyStatus["source"] = fileKey && effective === fileKey ? "file" : "env";

  return NextResponse.json({ present: true, source });
}

/**
 * Read the GEMINI_API_KEY value stored in ~/.vellum/.env, or null if the file
 * or line is absent. Parsing mirrors the launcher's loadHomeEnv (bin/vellum.mjs):
 * skip blanks/comments, split on the first '=', strip matching quotes.
 */
async function readFileKey(): Promise<string | null> {
  const raw = await readFile(ENV_FILE, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== "GEMINI_API_KEY") continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() || null;
  }
  return null;
}

/**
 * A cheap sanity gate, not validation: trim, require non-empty, and require a
 * non-trivial length so an empty value or an obvious placeholder ("...", "your
 * key here") reads as "no key". We don't hard-gate on the "AIza" prefix —
 * key formats drift, and a real invalid key is caught at save time now.
 */
function isPlausibleKey(raw: string | undefined): boolean {
  const key = raw?.trim() ?? "";
  return key.length >= 20;
}
