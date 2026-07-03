"use client";

// TASK-39 / TASK-40 — the nothing-selected home screen. Vellum opens here with no
// session chosen, so this is the app's first impression: explain the two ways in
// and offer them directly. The buttons fire the SAME shared record/import flow as
// the sidebar (SessionActionsProvider) — one recorder, one import dialog (AC#1).
//
// TASK-65.3 — this same screen is also the first-run SOFT gate. When there's no
// Gemini key yet (useKeyStatus → ready & !present) it rebuilds into a single
// "add your key first" step instead of showing a second, competing empty state:
// one VellumMark, one heading, one primary CTA to /settings/key. Record/Import
// aren't offered here — they'd compete with the one thing the first run needs,
// and they still live in the sidebar, so the app stays navigable (soft gate;
// analyze itself already routes to the same setup screen on a missing key).
// Loading and error fall through to the normal "Start a review" so a slow or
// failed status check never flashes onboarding or blocks the user.
//
// It's "use client" for the two triggers, the recording-active flag, and the
// live key read; the motion is pure CSS (see globals.css: vellum-breathe /
// vellum-echo) — no animation dependency, monochrome, stilled under
// prefers-reduced-motion.

import Link from "next/link";
import { Import, KeyRound, Loader2, Video } from "lucide-react";

import { useSessionActions } from "@/components/recording/session-actions";
import { Button } from "@/components/ui/button";
import { useKeyStatus } from "@/lib/key-status/use-key-status";

export function SessionsEmptyState() {
  const key = useKeyStatus();

  // Only a confirmed "no key" flips to onboarding. loading (don't know yet) and
  // error (status check failed) both fall through to the normal empty state, so
  // we never flash the gate or lock the user out over a status blip.
  if (key.status === "ready" && !key.present) {
    return <NoKeyOnboarding />;
  }

  return <StartAReview />;
}

// The normal home: two ways in, wired to the shared record/import flow.
function StartAReview() {
  const { startRecording, recordingActive, startImport, importing } =
    useSessionActions();

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <VellumMark />

      <h2 className="mt-8 text-base font-medium text-foreground">
        Start a review
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Record a new walkthrough or import an existing video. Vellum analyzes it
        and turns the feedback into a task list you can act on.
      </p>

      <div className="mt-6 flex items-center gap-2.5">
        {/* Primary CTA — same component/style as the sidebar idle button and the
            Analyze CTA. Hidden while a recording is in progress (there's already
            one recorder; the live controls live in the sidebar). */}
        {!recordingActive && (
          <Button onClick={startRecording}>
            <Video strokeWidth={1.5} />
            New recording
          </Button>
        )}
        <Button
          variant="outline"
          onClick={startImport}
          disabled={importing}
          className="bg-background dark:bg-background"
        >
          {importing ? (
            <Loader2 className="animate-spin" strokeWidth={1.5} />
          ) : (
            <Import strokeWidth={1.5} />
          )}
          Import video
        </Button>
      </div>
    </div>
  );
}

// First-run soft gate (TASK-65.3): the same empty state, rebuilt around the one
// step a keyless install actually needs. A single primary CTA to /settings/key —
// no record/import here, so the next step is unambiguous. Disappears the moment
// a key exists, because useKeyStatus flips this whole component back to
// StartAReview on the vellum:key-changed broadcast (no reload).
function NoKeyOnboarding() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <VellumMark />

      <h2 className="mt-8 text-base font-medium text-foreground">
        Add your Gemini key to begin
      </h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Vellum analyzes your recordings with Google Gemini under your own key.
        It&apos;s stored locally on this machine (
        <code className="font-mono text-[13px]">~/.vellum/.env</code>) and never
        leaves it.
      </p>

      <div className="mt-6">
        {/* Same primary Button as New recording, rendered as the link into the
            setup screen — the one, unambiguous next step. nativeButton={false}
            because the rendered element is an <a>, not a <button>. */}
        <Button nativeButton={false} render={<Link href="/settings/key" />}>
          <KeyRound strokeWidth={1.5} />
          Add API key
        </Button>
      </div>
    </div>
  );
}

// The Vellum mark (the wordmark's leading glyph) breathing inside two echoing
// square rings — an ambient "capture" motif kept strictly monochrome.
function VellumMark() {
  return (
    <div
      aria-hidden
      className="grid place-items-center [&>*]:[grid-area:1/1]"
    >
      <span className="vellum-echo size-16 rounded-2xl border border-foreground/25" />
      <span
        className="vellum-echo size-16 rounded-2xl border border-foreground/25"
        style={{ animationDelay: "1.8s" }}
      />
      <svg
        viewBox="0 0 16 16"
        className="vellum-breathe size-9 text-foreground"
        fill="currentColor"
        role="img"
        aria-label="Vellum"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M6.50391 3.5H9.50391V1H12.5039V3.5H15.0039V6.5H12.5039V9.5H15.0039V12.5H12.5039V15H9.50391V12.5H6.50391V15H3.50391V12.5H1.00391V9.5H3.50391V6.5H1.00391V3.5H3.50391V1H6.50391V3.5ZM6.50391 9.5H9.50391V6.5H6.50391V9.5Z" />
      </svg>
    </div>
  );
}
