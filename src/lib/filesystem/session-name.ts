// TASK-22 — the manual session-rename sidecar (`name.txt`).
//
// A session's folder stays a timestamp forever (the File System Access API can't
// rename a directory), so the pretty display name is RESOLVED, not applied. When
// the user renames a session by hand, we persist that override in a separate
// `name.txt` plain-text file inside the session folder — deliberately NOT in
// tasks.json, so a re-analysis (which rewrites tasks.json) never touches or
// overwrites the user's chosen name. Precedence lives in render-report's
// resolveSessionName / sessionDisplayName: override (this file) > suggested_name
// (tasks.json) > folder name.
//
// Client-safe: File System Access handle I/O only, no Node built-ins.

import { kebabCase } from "@/lib/gemini/schema";

/** The manual-override sidecar filename inside a session folder. */
export const OVERRIDE_NAME_FILE = "name.txt";

/**
 * Read the manual override for a session, or null if there is none. Best-effort
 * by design: a missing file, an empty file, or any read failure resolves to null
 * so a display-name lookup never breaks the session list or view (ADR-008 spirit
 * — a session still shows even if this sidecar can't be read). Only the first
 * non-empty line is used, trimmed, so a stray trailing newline is harmless.
 */
export async function readOverrideName(
  dir: FileSystemDirectoryHandle,
): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle(OVERRIDE_NAME_FILE);
    const text = await (await handle.getFile()).text();
    const first = text.split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    // NotFoundError (no override) or anything else → fall back to the folder name.
    return null;
  }
}

/**
 * Persist a manual override (AC#5). Trims the input and writes it as a single
 * line. The caller is responsible for gating on a non-empty value — an empty or
 * whitespace-only rename should leave the current name alone, not clear it.
 */
export async function writeOverrideName(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  const handle = await dir.getFileHandle(OVERRIDE_NAME_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(trimmed + "\n");
  await writable.close();
}

// TASK-43 — the name SIDECAR (a separate concept from name.txt above).
//
// A session folder is a timestamp forever (ADR-017), so the pretty name never
// reaches the filesystem — the user can't tell folders apart in Finder. The
// sidecar fixes findability WITHOUT renaming the folder or copying the ~1 GB
// recording: we drop a 0-byte file named after the display name INSIDE the
// folder, so opening it in Finder reveals the session (e.g. "onboarding-review.txt").
//
// It is NOT a marker (ADR-008): the session scan keys only off tasks.json /
// recording, never off this file, and it holds no data. `name.txt` (the manual
// override, above) stays the source of truth for the resolved name — the sidecar
// is a derived, disposable breadcrumb, rewritten whenever the name changes.

const SIDECAR_EXT = ".txt";

/**
 * The sidecar filename for a display name, or null when there's nothing usable —
 * a bare timestamp folder (no override / suggestion) kebab-slugs to itself and
 * adds no findability, and we refuse a name that would collide with the override
 * `name.txt` (a 0-byte write there would wipe the user's chosen name).
 */
export function nameSidecarFileName(displayName: string): string | null {
  const slug = kebabCase(displayName);
  if (!slug) return null;
  const fileName = slug + SIDECAR_EXT;
  if (fileName === OVERRIDE_NAME_FILE) return null; // never clobber the override
  return fileName;
}

/**
 * Is this file one of OUR sidecars (so it's safe to prune)? Deliberately strict
 * to respect ADR-008 — we only ever delete a file that matches the exact shape we
 * write and could never be meaningful user content: a 0-byte file whose name is a
 * pure kebab slug + ".txt" and isn't the override. A foreign `notes.txt` (has
 * bytes) or a non-slug name is left untouched.
 */
async function isOwnSidecar(handle: FileSystemFileHandle): Promise<boolean> {
  const name = handle.name;
  if (name === OVERRIDE_NAME_FILE) return false;
  if (!name.endsWith(SIDECAR_EXT)) return false;
  const base = name.slice(0, -SIDECAR_EXT.length);
  if (kebabCase(base) !== base) return false; // not a slug we could have written
  try {
    return (await handle.getFile()).size === 0; // our sidecars are always empty
  } catch {
    return false;
  }
}

/**
 * Write (and reconcile) the name sidecar so the folder shows the session name in
 * Finder. Keeps EXACTLY one: any stale sidecar from a previous name is removed,
 * then the current one is created if missing. Entirely best-effort — a sidecar is
 * a convenience, so any failure (permission, a file vanishing mid-scan, clipboard
 * of the folder) is swallowed and never breaks a rename, a scan, or a load.
 */
export async function writeNameSidecar(
  dir: FileSystemDirectoryHandle,
  displayName: string,
): Promise<void> {
  try {
    const desired = nameSidecarFileName(displayName);
    if (!desired) return; // nothing meaningful to name it after

    // Prune stale sidecars (a previous name) so exactly one remains. Only files
    // matching our own shape are touched — never a foreign file (ADR-008).
    for await (const entry of dir.values()) {
      if (entry.kind !== "file") continue;
      if (entry.name === desired) continue; // keep the current one
      if (!(await isOwnSidecar(entry))) continue;
      try {
        await dir.removeEntry(entry.name);
      } catch {
        // vanished / locked — leaving a stray sidecar is harmless, so ignore.
      }
    }

    // Ensure the current sidecar exists. If a file with that exact name is
    // already present (ours from before, or a foreign file the user made) we
    // leave it as-is rather than truncate it.
    try {
      await dir.getFileHandle(desired);
      return; // already there
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotFoundError")) return;
    }
    const handle = await dir.getFileHandle(desired, { create: true });
    await (await handle.createWritable()).close(); // 0-byte file
  } catch {
    // Best-effort: the sidecar is never load-bearing.
  }
}
