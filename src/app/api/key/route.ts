import { ApiError, GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * POST /api/key — validate then persist the user's Gemini API key so a
 * globally-installed Vellum (`npx vellum`) has one without hand-editing files
 * (TASK-64). DELETE /api/key removes it again (TASK-65.1).
 *
 * Two writes on save, on purpose:
 *   1. To ~/.vellum/.env (0600) — the launcher loads this at every boot
 *      (TASK-62), so the key survives restarts.
 *   2. To process.env of THIS running server — the analyze pipeline reads
 *      GEMINI_API_KEY at request time (lib/gemini/client.ts, upload.ts), so
 *      setting it here makes the key effective immediately, with no restart.
 *
 * Privacy (ARCHITECTURE §Privacy): the key is written to the user's own home
 * dir and set in-process. It is NEVER logged, and the response never echoes it
 * back — the client already has what it typed; the server returns a bare ok.
 */
export const runtime = "nodejs";

const ENV_DIR = join(homedir(), ".vellum");
const ENV_FILE = join(ENV_DIR, ".env");

export interface KeyWriteResult {
  ok: boolean;
  error?: string;
}

export async function POST(request: Request): Promise<NextResponse<KeyWriteResult>> {
  let key: unknown;
  try {
    ({ key } = (await request.json()) as { key?: unknown });
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed request." }, { status: 400 });
  }

  const trimmed = typeof key === "string" ? key.trim() : "";
  // A cheap sanity gate mirroring /api/key-status's isPlausibleKey — not
  // validation. A syntactically-fine but wrong key still fails loud at analyze.
  if (trimmed.length < 20) {
    return NextResponse.json(
      { ok: false, error: "That doesn't look like a key. Paste the full value from AI Studio." },
      { status: 400 },
    );
  }

  // Validate against Google BEFORE persisting, so a typo'd or revoked key is
  // caught here at setup instead of failing loud mid-upload at analyze time
  // (TASK-65 decision 2). The probe is a free metadata call — NEVER
  // generateContent, which bills.
  const verdict = await verifyKey(trimmed);
  if (verdict === "rejected") {
    return NextResponse.json(
      { ok: false, error: "That key was rejected by Google — check it's active in AI Studio." },
      { status: 400 },
    );
  }
  if (verdict === "unreachable") {
    return NextResponse.json(
      { ok: false, error: "Couldn't reach Google to verify the key — check your connection." },
      { status: 502 },
    );
  }

  try {
    await persistKey(trimmed);
  } catch {
    // Deliberately generic — never surface the key or a path with it embedded.
    return NextResponse.json(
      { ok: false, error: "Couldn't save the key to ~/.vellum/.env. Check folder permissions." },
      { status: 500 },
    );
  }

  // Make it effective for the current server without a restart.
  process.env.GEMINI_API_KEY = trimmed;

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/key — remove the stored key so the user can rotate or clear it
 * from the UI with no restart (TASK-65). Mirror of persistKey: drop only the
 * GEMINI_API_KEY line from ~/.vellum/.env, keep everything else (GEMINI_MODEL,
 * fallback overrides), then clear it from this process so it stops being
 * effective immediately.
 *
 * Note: if an exported env var or .env.local also set the key, it shadows the
 * file (bin/vellum.mjs precedence) and will still be present after this — the
 * status route reports that as source:"env", and the UI hides "remove" for it.
 * Never logs or echoes key material.
 */
export async function DELETE(): Promise<NextResponse<KeyWriteResult>> {
  try {
    await removeKey();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Couldn't update ~/.vellum/.env. Check folder permissions." },
      { status: 500 },
    );
  }

  delete process.env.GEMINI_API_KEY;

  return NextResponse.json({ ok: true });
}

type ProbeVerdict = "ok" | "rejected" | "unreachable";

/**
 * Probe a candidate key with a single free metadata call that requires auth.
 * Distinguishes a genuine auth rejection (bad/revoked key → don't save) from a
 * transient connectivity/timeout failure (→ don't permanently block the user).
 *
 * Uses a throwaway client built from the candidate — NOT getGemini(), which
 * caches a singleton off process.env and would both read the wrong key and
 * poison the cache with an unverified one.
 */
async function verifyKey(key: string): Promise<ProbeVerdict> {
  const controller = new AbortController();
  // Hard cap so a hung network doesn't leave the save request pending forever.
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    // models.get is a free GET that still requires a valid key; a bad key comes
    // back 400 (API_KEY_INVALID) or 403 (PERMISSION_DENIED). Never generateContent.
    await ai.models.get({ model: "gemini-2.5-flash", config: { abortSignal: controller.signal } });
    return "ok";
  } catch (err) {
    // Only an auth-class HTTP status means "this key is bad". Anything else
    // (network error, timeout/abort, 429, 5xx) is treated as unreachable so a
    // valid key isn't rejected over a blip.
    if (err instanceof ApiError && [400, 401, 403].includes(err.status)) {
      return "rejected";
    }
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write GEMINI_API_KEY into ~/.vellum/.env, preserving any other lines the user
 * may keep there (GEMINI_MODEL, segment overrides). Replaces an existing key
 * line rather than appending a duplicate.
 */
async function persistKey(key: string): Promise<void> {
  await mkdir(ENV_DIR, { recursive: true, mode: 0o700 });

  const existing = await readFile(ENV_FILE, "utf8").catch(() => "");
  const kept = existing
    .split("\n")
    .filter((line) => line.trim() && !/^\s*GEMINI_API_KEY\s*=/.test(line));

  const next = [...kept, `GEMINI_API_KEY=${key}`].join("\n") + "\n";

  await writeFile(ENV_FILE, next, { mode: 0o600 });
  // mode on writeFile only applies when the file is created; enforce it on
  // overwrite too so the key is never left world-readable.
  await chmod(ENV_FILE, 0o600);
}

/**
 * Remove the GEMINI_API_KEY line from ~/.vellum/.env, preserving any other
 * lines. If the file doesn't exist there's nothing to do. Mirror of persistKey.
 */
async function removeKey(): Promise<void> {
  const existing = await readFile(ENV_FILE, "utf8").catch(() => "");
  if (!existing) return;

  const kept = existing
    .split("\n")
    .filter((line) => line.trim() && !/^\s*GEMINI_API_KEY\s*=/.test(line));

  const next = kept.length ? kept.join("\n") + "\n" : "";

  await writeFile(ENV_FILE, next, { mode: 0o600 });
  await chmod(ENV_FILE, 0o600);
}
