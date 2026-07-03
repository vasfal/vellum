"use client";

import { useEffect, useState } from "react";

import { useWorkspace } from "@/components/workspace/workspace-provider";
import { scanSessions, type SessionRow } from "@/lib/filesystem/sessions";

// TASK-14 — read the workspace's sessions for the sidebar list. Scans against
// the live, ready workspace handle (useWorkspace, TASK-15), and re-scans when
// sessionsNonce bumps — i.e. after an in-app write (import/record/re-analyze),
// so a freshly created session appears without a full page reload (TASK-30).

type State =
  | { status: "loading" }
  | { status: "ready"; sessions: SessionRow[] }
  | { status: "error" };

export function useSessions(): State {
  const { handle, sessionsNonce } = useWorkspace();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    scanSessions(handle)
      .then((sessions) => {
        if (!cancelled) setState({ status: "ready", sessions });
      })
      .catch(() => {
        // The handle is granted + reachable when we get here, so a failure is
        // unexpected (e.g. permission revoked mid-session). Surface it rather
        // than render a misleading empty list.
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // Re-scan on handle change and whenever an in-app write bumps the nonce.
  }, [handle, sessionsNonce]);

  return state;
}
