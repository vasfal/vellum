import type { ReactNode } from "react";
import { FolderOpen, FolderX, Loader2, Lock, ShieldCheck } from "lucide-react";

import { Logo } from "@/components/logo";

import { Button } from "@/components/ui/button";

// Presentational gate screens for workspace onboarding (TASK-15).
//
// These are pure and props-driven on purpose: no File System Access, IndexedDB,
// or permission logic lives here. That keeps them prototypable in /styleguide
// (rendered with no callbacks) and reusable from WorkspaceProvider (rendered
// with real handlers). Each screen fills its parent's height (`h-full`), so the
// caller controls the frame — full viewport in the gate, a fixed box in the
// styleguide.

function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      {/* Subtle ease-out enter; scale from 0.95, ~200ms (ADR-005 / emil-skill). */}
      <div className="w-full max-w-md animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
        {children}
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="mb-8 flex items-center">
      <Logo className="h-[21px]" />
    </div>
  );
}

function IconBadge({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
      {children}
    </div>
  );
}

// Plain text — no fancy markup — so the privacy stance reads as a promise, not
// a feature list (ARCHITECTURE §Privacy stance).
function PrivacyNote() {
  return (
    <div className="mt-8 flex gap-3 rounded-lg border border-border bg-card p-4">
      <ShieldCheck
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.5}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        Everything stays on your machine. Recordings and reports are written to
        this folder and never leave it. The only data sent out is the video
        itself — uploaded to the Google Gemini API under your own key for
        analysis. No backend, no telemetry, no account.
      </p>
    </div>
  );
}

/** First run: no workspace chosen yet. */
export function WorkspaceOnboarding({ onPick }: { onPick?: () => void }) {
  return (
    <GateShell>
      <Brand />
      <IconBadge>
        <FolderOpen className="size-5" strokeWidth={1.5} />
      </IconBadge>
      <h1 className="mt-4 text-lg font-medium tracking-tight">
        Choose a workspace folder
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Vellum keeps every recording, report, and screenshot inside one folder
        you choose. Pick an empty folder to start.
      </p>
      <Button className="mt-6 w-full" onClick={onPick}>
        <FolderOpen />
        Choose folder…
      </Button>
      <PrivacyNote />
    </GateShell>
  );
}

/**
 * Restart re-grant: the handle was restored from IndexedDB but the browser
 * wants a one-click confirmation before reopening it. This is a soft path, not
 * an error (ARCHITECTURE §Error handling — folder permission).
 */
export function WorkspaceRegrant({
  folderName,
  onConfirm,
  onPickOther,
}: {
  folderName?: string;
  onConfirm?: () => void;
  onPickOther?: () => void;
}) {
  return (
    <GateShell>
      <Brand />
      <IconBadge>
        <Lock className="size-5" strokeWidth={1.5} />
      </IconBadge>
      <h1 className="mt-4 text-lg font-medium tracking-tight">
        Confirm workspace access
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Your browser needs permission to reopen{" "}
        {folderName ? (
          <span className="font-medium text-foreground">{folderName}</span>
        ) : (
          "your workspace folder"
        )}
        . This is a routine confirmation after a restart — nothing has changed.
      </p>
      <Button className="mt-6 w-full" onClick={onConfirm}>
        Confirm access
      </Button>
      {onPickOther && (
        <Button
          variant="ghost"
          className="mt-2 w-full"
          onClick={onPickOther}
        >
          Choose a different folder…
        </Button>
      )}
    </GateShell>
  );
}

/** The saved folder was moved, renamed, or deleted — pick again, no crash. */
export function WorkspaceUnavailable({
  folderName,
  onPick,
}: {
  folderName?: string;
  onPick?: () => void;
}) {
  return (
    <GateShell>
      <Brand />
      <IconBadge>
        <FolderX className="size-5" strokeWidth={1.5} />
      </IconBadge>
      <h1 className="mt-4 text-lg font-medium tracking-tight">
        Workspace unavailable
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        We couldn’t find{" "}
        {folderName ? (
          <span className="font-medium text-foreground">{folderName}</span>
        ) : (
          "your workspace folder"
        )}
        . It may have been moved, renamed, or deleted. Choose a workspace folder
        to continue.
      </p>
      <Button className="mt-6 w-full" onClick={onPick}>
        <FolderOpen />
        Choose folder…
      </Button>
    </GateShell>
  );
}

/** Transient: reading the saved handle from IndexedDB on load. */
export function WorkspaceLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <Loader2 className="size-5 animate-spin text-muted-foreground" strokeWidth={1.5} />
    </div>
  );
}
