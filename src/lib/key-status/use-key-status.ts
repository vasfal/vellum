"use client";

import { useEffect, useState } from "react";

import type { KeyStatus } from "@/app/api/key-status/route";

// Shared client-side reader for the Gemini key status (TASK-65.2). One place
// owns the fetch + refresh contract so every surface that cares — the sidebar
// status row, the first-run onboarding gate (TASK-65.3) — reflects the same
// live truth without each re-implementing polling.
//
// Refresh is EVENT-DRIVEN, not polled: whoever changes the key (the setup form
// on save, the sidebar's Remove) calls `notifyKeyChanged()`, which broadcasts a
// window event this hook listens for and refetches on. A refetch on window
// focus is a cheap secondary — covers a key edited in another tab or via the
// CLI. There is deliberately NO setInterval loop.

/** Window event broadcast whenever the stored key changes (save or removal). */
const KEY_CHANGED_EVENT = "vellum:key-changed";

/**
 * Tell every live `useKeyStatus()` consumer that the key changed, so their rows
 * refetch immediately instead of waiting for a reload. Call this right after a
 * successful POST /api/key or DELETE /api/key. No-ops on the server.
 */
export function notifyKeyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(KEY_CHANGED_EVENT));
}

/**
 * The status as the client sees it. `present`/`source` mirror the KeyStatus
 * wire shape (TASK-65.1) once loaded; loading/error stay quiet status states.
 */
export type KeyStatusState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; present: boolean; source: KeyStatus["source"] };

/**
 * Live, event-driven read of /api/key-status. Fetches once on mount, then
 * refetches whenever `notifyKeyChanged()` fires or the window regains focus.
 * Response is boolean + source only — no key material ever reaches the client.
 */
export function useKeyStatus(): KeyStatusState {
  const [state, setState] = useState<KeyStatusState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/key-status", { cache: "no-store" });
        if (!res.ok) throw new Error(`key-status ${res.status}`);
        const data = (await res.json()) as KeyStatus;
        // A refetch keeps showing the prior state until this resolves, so the
        // row never flickers back through "loading" on a live update.
        if (!cancelled) {
          setState({ status: "ready", present: data.present, source: data.source });
        }
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    }

    load();
    window.addEventListener(KEY_CHANGED_EVENT, load);
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener(KEY_CHANGED_EVENT, load);
      window.removeEventListener("focus", load);
    };
  }, []);

  return state;
}
