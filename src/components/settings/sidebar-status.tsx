"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, Folder, KeyRound } from "lucide-react";

import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  notifyKeyChanged,
  useKeyStatus,
  type KeyStatusState,
} from "@/lib/key-status/use-key-status";

// Compact status block in the sidebar footer (TASK-38). It surfaces the two
// facts the app can't infer from the UI alone: whether a Gemini key is
// configured (server-side, via /api/key-status) and which folder is the active
// workspace (from the ready WorkspaceProvider), with a re-pick action.
//
// The key row is a LIVE, manageable surface (TASK-65.2): it refetches without a
// reload when the key changes (useKeyStatus), and when a key saved to
// ~/.vellum/.env is present it offers change (→ /settings/key) and a
// confirm-guarded remove. A key coming from an env var is shown as configured
// but isn't removable from here — deleting the file wouldn't clear it.
//
// This replaces the standalone Settings page (TASK-29): the step-by-step key
// screen still lives at /settings/key, linked from the key row here and from the
// analyze missing-key error. Deliberately a status surface, not a panel.

export function SidebarStatus() {
  const { handle, repickWorkspace } = useWorkspace();
  const key = useKeyStatus();

  return (
    <div className="flex flex-col gap-0.5">
      {/* Key status row owns the full width now — the theme toggle moved up to
          the logo band (ADR-019). */}
      <KeyRow state={key} />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={repickWorkspace}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            />
          }
        >
          <Folder className="size-4 shrink-0" strokeWidth={1.5} />
          <span className="flex-1 truncate">{handle.name}</span>
          <span className="shrink-0 pr-0.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
            Change
          </span>
        </TooltipTrigger>
        <TooltipContent>Change workspace folder</TooltipContent>
      </Tooltip>
    </div>
  );
}

const ROW = "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm";

function KeyRow({ state }: { state: KeyStatusState }) {
  // No key → the row is the CTA to the setup screen.
  if (state.status === "ready" && !state.present) {
    return (
      <Link
        href="/settings/key"
        className={`${ROW} text-foreground transition-colors hover:bg-sidebar-accent`}
      >
        <KeyRound
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.5}
        />
        <span className="truncate">No key — set up</span>
      </Link>
    );
  }

  // Present → a live status; interactive only when the key is file-sourced
  // (removable). An env-sourced key is configured but managed elsewhere.
  if (state.status === "ready" && state.present) {
    return state.source === "file" ? <FileKeyRow /> : <EnvKeyRow />;
  }

  // Error → a degraded status line with a muted alert where the Check would sit
  // and a tooltip explaining why (the server couldn't be reached).
  if (state.status === "error") {
    return <ErrorKeyRow />;
  }

  // Loading stays a quiet, non-interactive status line.
  return (
    <div className={`${ROW} text-muted-foreground`}>
      <KeyRound className="size-4 shrink-0" strokeWidth={1.5} />
      <span className="truncate">Checking key…</span>
    </div>
  );
}

// The status check failed (server unreachable or the route errored). Mirrors the
// configured rows, but the green Check is replaced by a muted alert icon and a
// tooltip explains it's a transient, self-clearing state — not "no key".
function ErrorKeyRow() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            className={`${ROW} text-muted-foreground outline-none`}
          />
        }
      >
        <KeyRound className="size-4 shrink-0" strokeWidth={1.5} />
        <span className="truncate">Key status unavailable</span>
        <CircleAlert
          className="size-4 shrink-0 text-muted-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent>
        Couldn&apos;t reach the local server to check the key. It may be starting
        up — this clears once it responds.
      </TooltipContent>
    </Tooltip>
  );
}

// Present + saved in ~/.vellum/.env: interactive. Clicking the label opens
// /settings/key to change the key; a hover-revealed Remove opens a confirm modal
// before deleting (so a stray click can't clear the key).
function FileKeyRow() {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    try {
      const res = await fetch("/api/key", { method: "DELETE" });
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      // Deletion failed — the key is still there. Close the dialog quietly; the
      // status row keeps reading "configured".
      setDeleting(false);
      setOpen(false);
      return;
    }
    // Flip every live consumer to the no-key state; this row unmounts as the
    // parent re-renders the CTA, so there's no local state left to reset.
    notifyKeyChanged();
  }

  return (
    <>
      <div className={`${ROW} group text-muted-foreground transition-colors hover:bg-sidebar-accent`}>
        {/* Primary action: change the key. The label + status Check is the
            target, mirroring the workspace row below. Not flex-1 — the Check
            sits immediately after the text, not floated to the row edge. */}
        <Link
          href="/settings/key"
          className="flex min-w-0 items-center gap-2 transition-colors group-hover:text-foreground"
        >
          <KeyRound className="size-4 shrink-0" strokeWidth={1.5} />
          <span className="truncate">Key configured</span>
          {/* Green is a functional status affirmation (like --destructive for
              errors), not a brand accent — the one nod to color ADR-004 allows. */}
          <Check
            className="size-4 shrink-0 text-green-500"
            strokeWidth={2.5}
            aria-hidden
          />
        </Link>
        {/* Remove is pinned to the right edge and revealed on row hover, so the
            resting row stays a calm status line. Same muted-xs treatment as the
            workspace "Change"; the confirm modal guards an accidental click. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-auto shrink-0 pr-0.5 text-xs text-muted-foreground opacity-0 transition-[color,opacity] duration-150 ease-out group-hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          Remove
        </button>
      </div>

      <Dialog open={open} onOpenChange={(next) => !deleting && setOpen(next)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove API key?</DialogTitle>
            <DialogDescription>
              This clears the key saved in <code>~/.vellum/.env</code>. Analysis
              won&apos;t run until you add one again. You can set a new key any
              time from the sidebar.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={deleting} />}
            >
              Cancel
            </DialogClose>
            <Button onClick={remove} disabled={deleting}>
              {deleting ? "Removing…" : "Remove key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Present + provided by an env var / .env.local: configured, but not removable
// from here (deleting the file wouldn't clear it — bin/vellum.mjs precedence).
// A tooltip explains why there's no Remove; no change action, since a POST
// wouldn't override the env var either.
function EnvKeyRow() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            className={`${ROW} text-muted-foreground outline-none`}
          />
        }
      >
        <KeyRound className="size-4 shrink-0" strokeWidth={1.5} />
        <span className="truncate">Key configured</span>
        <Check
          className="size-4 shrink-0 text-green-500"
          strokeWidth={2.5}
          aria-hidden
        />
      </TooltipTrigger>
      <TooltipContent>
        Set via an environment variable — remove it where it&apos;s defined.
      </TooltipContent>
    </Tooltip>
  );
}
