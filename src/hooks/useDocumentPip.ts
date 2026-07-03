"use client";

// TASK-16 — Document Picture-in-Picture lifecycle for the floating recording
// controls (ADR-007). Opens an always-on-top OS window we render React controls
// into via a portal, then tears it down cleanly. Chromium-only: callers feature-
// detect with `isSupported` and fall back to the in-page controls (AC#5).
//
// Why a portal (not a separate React root or a moved DOM node): the controls
// stay part of the opener's React tree, so they read the same recorder ref and
// state — pause/stop/mic in the PiP window and in-page drive ONE recorder, and
// state stays in sync both ways for free (AC#3). Styles do NOT cross into the
// PiP document automatically, so we inject a small base stylesheet here; the
// widget itself is inline-styled with the TASK-2 tokens.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// The Document Picture-in-Picture API is not yet in TypeScript's bundled DOM
// lib, so we declare the minimal surface we use. (CLAUDE.md §6 — typed escape
// hatch, documented rather than `any`.)
interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}
declare global {
  interface Window {
    readonly documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export interface DocumentPipHandle {
  /** True only in browsers that expose the Document PiP API (Chromium). */
  isSupported: boolean;
  /** The open PiP window, or null when closed. Drives the React portal. */
  pipWindow: Window | null;
  /** Open the PiP window at the given size; resolves to it (or null on failure). */
  open: (size: { width: number; height: number }) => Promise<Window | null>;
  /** Close the PiP window if open (no-op otherwise). */
  close: () => void;
}

export interface UseDocumentPipOptions {
  /** Called when the window closes for ANY reason (user, our close(), nav). */
  onClose?: () => void;
}

export function useDocumentPip({ onClose }: UseDocumentPipOptions = {}): DocumentPipHandle {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  // Feature detection reads `window`, so it's SSR-safe via useSyncExternalStore:
  // the server snapshot is false; the client snapshot checks the real API. The
  // capability never changes after load, so the subscription is a no-op.
  const isSupported = useSyncExternalStore(
    () => () => {},
    () => "documentPictureInPicture" in window,
    () => false,
  );

  // Keep the latest onClose without re-binding the pagehide listener each render.
  // Written in an effect (not during render) per React's ref rules.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const open = useCallback(async ({ width, height }: { width: number; height: number }) => {
    const dpip = window.documentPictureInPicture;
    if (!dpip) return null;
    // requestWindow must be called from a user gesture (the caller is a click).
    const pip = await dpip.requestWindow({ width, height });

    // The PiP document starts blank — styles are NOT inherited from the opener.
    // Inject app background + the rec-dot keyframes; the widget supplies the rest
    // inline with the TASK-2 tokens.
    const style = pip.document.createElement("style");
    style.textContent = PIP_BASE_CSS;
    pip.document.head.appendChild(style);

    // Closing the window (browser control, Window.close(), or navigation) fires
    // pagehide on the PiP window. We clear our state and notify the caller — and
    // deliberately do NOT touch the recorder, so closing PiP never loses the
    // recording (AC#4: closing PiP ≠ stopping the recording).
    pip.addEventListener(
      "pagehide",
      () => {
        setPipWindow(null);
        onCloseRef.current?.();
      },
      { once: true },
    );

    setPipWindow(pip);
    return pip;
  }, []);

  const close = useCallback(() => {
    // Triggers the pagehide handler above, which clears state + calls onClose.
    pipWindow?.close();
  }, [pipWindow]);

  // Safety net: if the opener page unmounts while PiP is open, close it so we
  // never orphan a floating window. Unmount-only — reads the live window via a
  // ref kept current in an effect (per React's ref rules).
  const pipWindowRef = useRef<Window | null>(null);
  useEffect(() => {
    pipWindowRef.current = pipWindow;
  }, [pipWindow]);
  useEffect(() => () => pipWindowRef.current?.close(), []);

  return { isSupported, pipWindow, open, close };
}

// Lives in the PiP document only. Base look (dark app background, no body
// margin) + the rec-dot pulse and the shared button styles. Interaction states
// (:hover / :active) live here because inline styles can't express them — the
// widget references these classes (ADR-005: real :active feedback). Colors are
// the TASK-2 monochrome ramp values from globals.css.
const PIP_BASE_CSS = `
  :root { color-scheme: dark; }
  body {
    margin: 0;
    background: oklch(0.145 0 0);
    color: oklch(0.985 0 0);
    font-family: ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  @keyframes vellum-rec-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.82); }
  }
  .vellum-rec-dot { animation: vellum-rec-pulse 1.6s ease-in-out infinite; }

  .vellum-pip-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    background: oklch(0.205 0 0);
    color: oklch(0.985 0 0);
    border: 1px solid oklch(1 0 0 / 8%);
    border-radius: 7px;
    cursor: pointer;
    transition: background-color 150ms ease-out, transform 150ms ease-out;
  }
  .vellum-pip-btn:hover { background: oklch(0.245 0 0); }
  .vellum-pip-btn:active { transform: scale(0.95); }
  .vellum-pip-btn:disabled {
    background: oklch(0.205 0 0);
    color: oklch(0.47 0 0);
    cursor: not-allowed;
  }
  /* Stop = high-emphasis (inverted), the primary action of the widget. */
  .vellum-pip-btn[data-variant="stop"] {
    background: oklch(0.985 0 0);
    color: oklch(0.145 0 0);
    border-color: transparent;
  }
  .vellum-pip-btn[data-variant="stop"]:hover { background: oklch(0.9 0 0); }
`;
