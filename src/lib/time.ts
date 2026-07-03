// TASK-32 — compact relative timestamps for the session chrome (sidebar rows +
// session-view header). Kept dependency-free and pure (an injectable `now`) so it
// can be unit-tested offline without mocking the clock.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Calendar-ish approximations — this is a glanceable label ("2mo ago"), not an
// exact duration, so an average month/year is close enough and never surprising.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * A short, glanceable "time since" label: `just now`, `3min ago`, `5h ago`,
 * `2d ago`, `3w ago`, `2mo ago`, `1y ago`. Anything under a minute — and any
 * future timestamp (clock skew) — reads as "just now" rather than a jittery
 * seconds counter. `now` is injectable purely so the unit test is deterministic;
 * callers pass a real `Date.now()` (allowed in the browser/Node, unlike workflow
 * scripts).
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}w ago`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo ago`;
  return `${Math.floor(diff / YEAR)}y ago`;
}

/**
 * Parse a Vellum session folder name into epoch ms, or null if it isn't that
 * shape. The stable folder identity (never renamed, ADR-017) is local-time and
 * MINUTE-grained for in-app record/import (`YYYY-MM-DD-HH-MM`, session-dir.ts);
 * the CLI adds seconds (`YYYY-MM-DD-HH-MM-SS`). So seconds are OPTIONAL here —
 * matching only the 6-part shape would reject every in-app folder. Used by the
 * header to show WHEN the session was captured, separate from the marker's
 * last-modified recency the sidebar sorts by. The round-trip check rejects
 * impossible dates (e.g. month 13) that `new Date` would silently roll over.
 */
export function parseSessionTimestamp(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:-(\d{2}))?$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const date = new Date(y, mo - 1, d, h, mi, s);
  const valid =
    date.getFullYear() === y &&
    date.getMonth() === mo - 1 &&
    date.getDate() === d &&
    date.getHours() === h &&
    date.getMinutes() === mi &&
    date.getSeconds() === s;
  return valid ? date.getTime() : null;
}
