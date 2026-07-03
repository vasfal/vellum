"use client";

import { useEffect, useState } from "react";
import { Check, LifeBuoy, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import {
  recoverSession,
  scanRecoverables,
  type RecoverableSession,
} from "@/lib/filesystem/recovery";

// TASK-24 — surfaces folders with an orphaned recording.webm.crswap (a
// recording interrupted by a crash) and offers one-click recovery.
//
// This scans independently of the sidebar session list (TASK-14): a crashed
// recording has no tasks.json marker, so it never appears there. Data-loss
// recovery is "fail loud, never lose data" (ARCHITECTURE §Error handling), so
// it's a prominent card in the main area — not a quiet sidebar badge, and not a
// modal (modals interrupt; the user may want to record first and recover later).

type Scan =
  | { status: "loading" }
  | { status: "ready"; rows: RecoverableSession[] };

export function RecoveryPrompt() {
  const { handle } = useWorkspace();
  const [scan, setScan] = useState<Scan>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    scanRecoverables(handle)
      .then((rows) => {
        if (!cancelled) setScan({ status: "ready", rows });
      })
      .catch(() => {
        // Best-effort surface: if the recovery scan fails, don't block the app
        // or show a scary error — the main session flow is unaffected. Treat it
        // as "nothing to recover" and move on.
        if (!cancelled) setScan({ status: "ready", rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  if (scan.status === "loading" || scan.rows.length === 0) return null;

  return (
    <div className="animate-in fade-in-0 zoom-in-95 duration-200 ease-out rounded-lg border border-border bg-card p-4">
      <div className="flex gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          <LifeBuoy className="size-5" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium tracking-tight">
            {scan.rows.length === 1
              ? "An interrupted recording can be recovered"
              : `${scan.rows.length} interrupted recordings can be recovered`}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            These recordings were cut off before they finished saving — a crash
            or forced quit left the video in a temporary file. Recovering
            restores the partial recording; it plays back up to where it stopped.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {scan.rows.map((row) => (
              <RecoverableRow key={row.name} row={row} handle={handle} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

type RowState =
  | { kind: "idle" }
  | { kind: "recovering" }
  | { kind: "recovered" }
  | { kind: "failed" };

function RecoverableRow({
  row,
  handle,
}: {
  row: RecoverableSession;
  handle: FileSystemDirectoryHandle;
}) {
  const [state, setState] = useState<RowState>({ kind: "idle" });

  async function recover() {
    setState({ kind: "recovering" });
    try {
      await recoverSession(handle, row.name);
      setState({ kind: "recovered" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-foreground">
          {row.name}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {state.kind === "failed"
            ? "Couldn’t recover — try again"
            : `${formatMB(row.swapBytes)} recoverable`}
        </span>
      </div>

      {state.kind === "recovered" ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3.5" strokeWidth={2} />
          Recovered
        </span>
      ) : (
        <Button
          size="sm"
          variant={state.kind === "failed" ? "outline" : "secondary"}
          className="shrink-0"
          onClick={recover}
          disabled={state.kind === "recovering"}
        >
          <RotateCcw className={state.kind === "recovering" ? "animate-spin" : ""} />
          {state.kind === "recovering"
            ? "Recovering…"
            : state.kind === "failed"
              ? "Retry"
              : "Recover"}
        </Button>
      )}
    </li>
  );
}

/** "16.3 MB" — one decimal, base-1000 to match how the OS reports file sizes. */
function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
