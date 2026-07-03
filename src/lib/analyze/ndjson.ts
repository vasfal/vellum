// Incremental NDJSON line framing for the POST /api/analyze stream (ADR-014).
//
// The fetch reader hands us arbitrary byte chunks; a single "\n"-delimited JSON
// object can straddle two chunks (or two objects can arrive in one). splitLines
// pulls the COMPLETE lines out of a running buffer and returns the unfinished
// remainder to prepend to the next chunk. Kept pure — no fetch, no DOM — so the
// framing logic is unit-testable on its own (see scripts/ smoke check).

/**
 * Split a decoded buffer into complete, non-empty lines plus the trailing
 * remainder. The remainder is whatever follows the last "\n" (a partial line
 * still in flight), which the caller carries into the next read. Blank lines
 * are dropped — the stream is one JSON object per line, nothing in between.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const segments = buffer.split("\n");
  // The final segment has no trailing "\n" yet, so it may be an incomplete line.
  const rest = segments.pop() ?? "";
  const lines = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  return { lines, rest };
}
