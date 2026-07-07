// TASK-59 (ADR-024) — the comments.json sidecar read/write over the workspace
// File System Access directory handle. Mirrors the I/O of write-edits-browser.ts
// (createWritable / getFileHandle, NotFoundError → null); client-safe, no node:*.
//
// comments.json is the CURRENT version's annotation layer. TASK-60 will archive it
// alongside the run (like report-<stamp>.md); here we only read/write the live one.
//
// Reading a missing OR malformed comments.json returns [] (never throws) — the
// session view degrades to "no comments" rather than crashing, matching the
// ergonomics of session-data.ts and the AI-baseline reader.

import {
  CommentsFileSchema,
  CommentsWriteSchema,
  type Comment,
} from "@/lib/comments/comment";

const COMMENTS_NAME = "comments.json";

/**
 * Read a session's comments. Missing file → []. Unreadable / not JSON / wrong
 * shape → [] (best-effort; a corrupt sidecar must not take down the view).
 */
export async function readComments(
  sessionDir: FileSystemDirectoryHandle,
): Promise<Comment[]> {
  const handle = await getFileHandleOrNull(sessionDir, COMMENTS_NAME);
  if (!handle) return [];
  let text: string;
  try {
    text = await (await handle.getFile()).text();
  } catch {
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return []; // not JSON at all
  }
  const parsed = CommentsFileSchema.safeParse(json);
  return parsed.success ? parsed.data.comments : [];
}

/**
 * Write a session's comments (pretty-printed). Overwrites comments.json in place —
 * comments are per-current-version, never archived here (TASK-60). Fails loud on a
 * genuine write error so the caller's save chain can retry, but the shape is
 * validated first so a malformed array never reaches disk.
 */
export async function writeComments(
  sessionDir: FileSystemDirectoryHandle,
  comments: Comment[],
): Promise<void> {
  // Validate against the STRICT write schema (the read schema also accepts the
  // legacy shape; a write must only ever persist the current `target` shape).
  const validated = CommentsWriteSchema.parse({ comments });
  await writeTextFile(
    sessionDir,
    COMMENTS_NAME,
    JSON.stringify(validated, null, 2) + "\n",
  );
}

/** Write a UTF-8 text file under `dir`, creating/overwriting it. */
async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  contents: string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

/** getFileHandle, but NotFoundError → null instead of throwing (see sessions.ts). */
async function getFileHandleOrNull(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}
