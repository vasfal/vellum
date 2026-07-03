// Create a fresh <timestamp> session folder in the workspace.
//
// Extracted from recording-sink.ts (TASK-12) so both entry points to a session
// share ONE implementation: recording new (TASK-25) and importing an existing
// video (TASK-30). The naming rule is ARCHITECTURE §Local storage layout: a
// minute-grained, local-time folder (`2026-06-30-14-30`), suffixed `-2`, `-3`, …
// on a same-minute collision.
//
// `now` is injected (not read from the clock here) so the folder name is
// deterministic and testable.

export interface CreatedSessionDir {
  dir: FileSystemDirectoryHandle;
  /** The folder name actually created (post-collision suffix). */
  name: string;
}

/**
 * Create the session folder, suffixing -2, -3, … if a folder of that name
 * already exists (two sessions started in the same minute). Probes existence
 * with a no-create getDirectoryHandle, which throws NotFoundError when the name
 * is free — that's our signal to claim it.
 */
export async function createSessionDir(
  workspace: FileSystemDirectoryHandle,
  now: Date,
): Promise<CreatedSessionDir> {
  const baseName = formatSessionTimestamp(now);
  let name = baseName;
  let suffix = 1;

  // Bounded loop — a runaway here would mean thousands of same-minute folders.
  while (suffix < 1000) {
    try {
      await workspace.getDirectoryHandle(name); // exists? → collision, try next
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        const dir = await workspace.getDirectoryHandle(name, { create: true });
        return { dir, name };
      }
      throw err; // anything else (e.g. permission) is a real failure — fail loud
    }
    suffix += 1;
    name = `${baseName}-${suffix}`;
  }

  throw new Error(`Could not create a unique session folder for "${baseName}"`);
}

/** "2026-06-30-14-30" — minute-grained, local time, per ARCHITECTURE §Local storage layout. */
function formatSessionTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}`
  );
}
