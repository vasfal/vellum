"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";

import { pickWorkspaceDirectory } from "@/lib/filesystem/recording-sink";
import {
  loadWorkspaceHandle,
  saveWorkspaceHandle,
} from "@/lib/filesystem/workspace-store";
import {
  ensureWorkspaceMarker,
  isWorkspaceReachable,
  queryWorkspacePermission,
  requestWorkspacePermission,
} from "@/lib/filesystem/workspace";
import {
  WorkspaceLoading,
  WorkspaceOnboarding,
  WorkspaceRegrant,
  WorkspaceUnavailable,
} from "./workspace-screens";

// The first-run / restore gate for the app shell (TASK-15). Mounted in
// (app)/layout above the sidebar, so until a workspace is "ready" the user sees
// a full-screen gate instead of an empty, broken app. /styleguide and
// /record-test live outside the (app) group and are intentionally not gated.
//
// State machine:
//   loading           → reading the saved handle from IndexedDB on mount
//   onboarding        → nothing saved yet; pick a folder (first run)
//   needs-permission  → handle restored but the browser wants a re-grant click
//   unavailable       → saved folder is gone, or permission was denied
//   ready             → handle is granted + reachable; render the app

type Status =
  | { kind: "loading" }
  | { kind: "onboarding" }
  | { kind: "needs-permission"; handle: FileSystemDirectoryHandle }
  | { kind: "unavailable"; folderName?: string }
  | { kind: "ready"; handle: FileSystemDirectoryHandle };

interface WorkspaceContextValue {
  /** The granted, reachable workspace root. Available to children once ready. */
  handle: FileSystemDirectoryHandle;
  /** Bumped whenever the on-disk session set changes (import/record/re-analyze)
   *  so the sidebar list (useSessions) re-scans. The scan reads the workspace
   *  through the handle, so an in-app change is invisible until we re-scan. */
  sessionsNonce: number;
  /** Signal that a new session landed (or an existing one changed) — triggers a
   *  sidebar re-scan. Call after writing a session into the workspace. */
  refreshSessions: () => void;
  /** Open the native folder picker to switch workspaces (Settings re-pick,
   *  TASK-29). Reuses the same pick → adopt path as onboarding, so a new folder
   *  becomes the ready workspace and the app re-renders around it; dismissing
   *  the dialog leaves the current workspace untouched. */
  repickWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Read the active workspace. Only valid inside the ready app tree. */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useWorkspace must be used within a ready WorkspaceProvider");
  }
  return value;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  // Sidebar session list re-scan trigger. useSessions depends on this nonce, so
  // bumping it after an in-app write (import today; record/re-analyze next)
  // makes the new session appear without a full page reload.
  const [sessionsNonce, setSessionsNonce] = useState(0);
  const refreshSessions = useCallback(() => setSessionsNonce((n) => n + 1), []);

  // Promote a handle to "ready": confirm the folder is still there, write (or
  // keep) the marker, and persist the handle. A folder that vanished between
  // the permission grant and now falls back to "unavailable" rather than
  // throwing.
  const adopt = useCallback(async (handle: FileSystemDirectoryHandle) => {
    if (!(await isWorkspaceReachable(handle))) {
      setStatus({ kind: "unavailable", folderName: handle.name });
      return;
    }
    await ensureWorkspaceMarker(handle);
    await saveWorkspaceHandle(handle);
    setStatus({ kind: "ready", handle });
  }, []);

  // First run + restore. Runs once on mount; IndexedDB and File System Access
  // are client-only, so the server render is always "loading" (no mismatch).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadWorkspaceHandle();
      if (cancelled) return;
      if (!saved) {
        setStatus({ kind: "onboarding" });
        return;
      }
      const permission = await queryWorkspacePermission(saved);
      if (cancelled) return;
      if (permission === "granted") {
        await adopt(saved);
      } else if (permission === "prompt") {
        setStatus({ kind: "needs-permission", handle: saved });
      } else {
        // "denied" — the browser won't silently re-prompt; pick again.
        setStatus({ kind: "unavailable", folderName: saved.name });
      }
    })().catch(() => {
      // Unexpected restore failure → drop to onboarding rather than a dead app.
      if (!cancelled) setStatus({ kind: "onboarding" });
    });
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  // Native folder picker — used by onboarding and the unavailable screen. The
  // picker already requests readwrite upfront (recording-sink), so a successful
  // pick is granted. AbortError means the user dismissed the dialog: stay put.
  const pick = useCallback(async () => {
    try {
      const handle = await pickWorkspaceDirectory();
      await adopt(handle);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setStatus({ kind: "unavailable" });
    }
  }, [adopt]);

  // Soft re-grant. Runs inside the click gesture so requestPermission is
  // allowed to prompt; denial/closing the prompt routes to "unavailable".
  const confirmAccess = useCallback(
    async (handle: FileSystemDirectoryHandle) => {
      try {
        const permission = await requestWorkspacePermission(handle);
        if (permission === "granted") {
          await adopt(handle);
        } else {
          setStatus({ kind: "unavailable", folderName: handle.name });
        }
      } catch {
        setStatus({ kind: "unavailable", folderName: handle.name });
      }
    },
    [adopt],
  );

  switch (status.kind) {
    case "loading":
      return (
        <GateViewport>
          <WorkspaceLoading />
        </GateViewport>
      );
    case "onboarding":
      return (
        <GateViewport>
          <WorkspaceOnboarding onPick={pick} />
        </GateViewport>
      );
    case "needs-permission":
      return (
        <GateViewport>
          <WorkspaceRegrant
            folderName={status.handle.name}
            onConfirm={() => confirmAccess(status.handle)}
            onPickOther={pick}
          />
        </GateViewport>
      );
    case "unavailable":
      return (
        <GateViewport>
          <WorkspaceUnavailable folderName={status.folderName} onPick={pick} />
        </GateViewport>
      );
    case "ready":
      return (
        <WorkspaceContext.Provider
          value={{
            handle: status.handle,
            sessionsNonce,
            refreshSessions,
            repickWorkspace: pick,
          }}
        >
          {children}
        </WorkspaceContext.Provider>
      );
  }
}

// The gate owns the full viewport; the screens fill it (h-full).
function GateViewport({ children }: { children: ReactNode }) {
  return <div className="h-svh w-full">{children}</div>;
}
