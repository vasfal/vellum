"use client";

// TASK-40 — the app-level home for the two ways INTO a session: record (S2) and
// import (S13). Both used to live inside their sidebar buttons, so they could
// only be triggered from there. This provider lifts the *triggers* (and the
// state they drive) up to (app)/layout, so the sidebar AND the empty state can
// start a recording or an import from the same single flow.
//
// What renders where (AC#1 — exactly one of each):
//   • The recorder state machine (useNewRecording) + the PiP lifecycle live here.
//   • The in-page recording CONTROLS render once, in the sidebar, by reading this
//     context (NewRecording). The PiP floating widget renders from here through a
//     portal so it drives the same recorder regardless of where the controls are.
//   • The import DIALOG renders here (app-level), so startImport works from any
//     trigger; the import trigger buttons just call startImport.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAnalysis } from "@/components/analysis/analysis-provider";
import { PipRecorderControls } from "@/components/recording/pip-recorder-controls";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { useDocumentPip } from "@/hooks/useDocumentPip";
import { useNewRecording } from "@/hooks/useNewRecording";
import {
  ImportError,
  importVideoToWorkspace,
  pickVideoToImport,
  type ImportedSession,
} from "@/lib/filesystem/import-video";
import type { RecorderState } from "@/lib/recording/recorder";

// The live recording controls the sidebar renders (NewRecording → InPageControls
// and the PiP widget both consume these). Exactly one recorder backs them.
export interface RecordingControls {
  phase: RecorderState;
  elapsedMs: number;
  micEnabled: boolean;
  /** PiP is available and not already open — show the pop-out affordance. */
  canPopOut: boolean;
  pauseResume: () => void;
  toggleMic: () => void;
  /** Stop the recording AND close the floating widget (the composed action). */
  stop: () => void;
  popOut: () => void;
}

interface SessionActionsContextValue {
  /** Begin a new screen recording (S2). No-op if one is already running. */
  startRecording: () => void;
  /** True while a recording is in progress (idle button ↔ live controls). */
  recordingActive: boolean;
  recording: RecordingControls;
  /** Open the file picker and run the import → analyze flow (S13). */
  startImport: () => void;
  /** True only while a picked video is being copied into the workspace. The
   *  analyze that follows runs in the app-level controller and is visible in the
   *  session view (like a recording) — this covers just the brief copy step. */
  importing: boolean;
}

const SessionActionsContext =
  createContext<SessionActionsContextValue | null>(null);

/** Read the shared record/import triggers. Valid inside SessionActionsProvider. */
export function useSessionActions(): SessionActionsContextValue {
  const value = useContext(SessionActionsContext);
  if (!value) {
    throw new Error(
      "useSessionActions must be used within a SessionActionsProvider",
    );
  }
  return value;
}

type ImportUiState =
  | { status: "idle" }
  /** Copying the picked file into the workspace (a brief pre-step before the
   *  session exists). Surfaced as a spinner on the Import trigger, not a modal. */
  | { status: "copying"; fileName: string }
  /** Picker rejected the file (unsupported) or the copy failed — terminal. */
  | { status: "rejected"; message: string };

export function SessionActionsProvider({ children }: { children: ReactNode }) {
  const { handle, refreshSessions } = useWorkspace();
  const router = useRouter();
  const { analyze } = useAnalysis();

  // ── Recording (the one recorder for the whole app) ───────────────────────
  // On Stop we save into the adopted workspace, kick off analysis right away
  // (it runs in the background and is cancellable now — TASK-42), and navigate to
  // the new session so its progress is visible.
  const onSaved = useCallback(
    (name: string) => {
      // A fresh folder has no tasks.json yet, so the scan won't list it until it's
      // analyzed (ADR-008) — refreshing is harmless and keeps the list honest.
      refreshSessions();
      analyze(name);
      router.push(`/session/${encodeURIComponent(name)}`);
    },
    [refreshSessions, analyze, router],
  );

  const { phase, micEnabled, elapsedMs, start, pauseResume, toggleMic, stop } =
    useNewRecording({ workspace: handle, onSaved });
  const pip = useDocumentPip();

  const recordingActive = phase !== "inactive";

  const popOut = useCallback(async () => {
    try {
      // A compact single-row pill. Chromium may restore the user's last size; the
      // widget centers gracefully at any height (TASK-16).
      await pip.open({ width: 320, height: 72 });
    } catch {
      // PiP unavailable/blocked → the in-page controls stay the surface.
    }
  }, [pip]);

  // Stopping the recording also closes the floating widget.
  const onStop = useCallback(() => {
    pip.close();
    void stop();
  }, [pip, stop]);

  const startRecording = useCallback(() => void start(), [start]);

  // ── Import flow (S13) ─────────────────────────────────────────────────────
  // Same UX as a recording: pick a video, copy it into the workspace, then
  // navigate to the new session and analyze in the background (visible in the
  // header + sidebar). The only import-specific step is the copy — surfaced as a
  // spinner on the Import trigger, not a progress modal. A modal shows ONLY on a
  // terminal pick/copy error; analysis errors live in the session view (Retry
  // there), exactly like a recording.
  const [importState, setImportState] = useState<ImportUiState>({
    status: "idle",
  });
  // Bumped so a second Import supersedes a slow copy still in flight (its late
  // navigate/analyze is dropped).
  const runToken = useRef(0);

  const runImport = useCallback(async () => {
    const token = ++runToken.current;

    let pick;
    try {
      pick = await pickVideoToImport();
    } catch (err) {
      const message =
        err instanceof ImportError ? err.message : "Couldn't open the file picker.";
      setImportState({ status: "rejected", message });
      return;
    }
    if (!pick || runToken.current !== token) return; // cancelled picker / superseded

    setImportState({ status: "copying", fileName: pick.file.name });
    let created: ImportedSession;
    try {
      created = await importVideoToWorkspace(handle, pick, new Date());
    } catch (err) {
      if (runToken.current !== token) return;
      const message =
        err instanceof ImportError
          ? err.message
          : "Couldn't copy the video into the workspace.";
      setImportState({ status: "rejected", message });
      return;
    }
    if (runToken.current !== token) return;

    // Copied in — from here it's identical to a finished recording (onSaved):
    // drop the copy state, re-scan the sidebar, navigate, and analyze.
    setImportState({ status: "idle" });
    refreshSessions();
    analyze(created.name);
    router.push(`/session/${encodeURIComponent(created.name)}`);
  }, [handle, refreshSessions, analyze, router]);

  const startImport = useCallback(() => void runImport(), [runImport]);

  const importing = importState.status === "copying";

  const closeImport = useCallback(() => setImportState({ status: "idle" }), []);

  const recording: RecordingControls = {
    phase,
    elapsedMs,
    micEnabled,
    canPopOut: pip.isSupported && pip.pipWindow === null,
    pauseResume,
    toggleMic,
    stop: onStop,
    popOut: () => void popOut(),
  };

  return (
    <SessionActionsContext.Provider
      value={{
        startRecording,
        recordingActive,
        recording,
        startImport,
        importing,
      }}
    >
      {children}

      {/* Error-only modal (app-level so it works from any trigger): a terminal
          pick/copy failure. The happy path shows no modal — the copy is a
          spinner on the trigger, and the analysis that follows lives in the
          session view like a recording's. */}
      <Dialog
        open={importState.status === "rejected"}
        onOpenChange={(open) => {
          if (!open) closeImport();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import video</DialogTitle>
            <DialogDescription>This file can’t be imported.</DialogDescription>
          </DialogHeader>

          {importState.status === "rejected" && (
            <div className="flex items-start gap-2.5 py-1">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                strokeWidth={1.5}
              />
              <p className="text-xs whitespace-pre-line text-muted-foreground">
                {importState.message}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeImport}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The floating widget lives in the PiP document but stays in this React
          tree, so it reads the same recorder state and drives the same handlers
          as the in-page controls (TASK-16, AC#1). */}
      {pip.pipWindow &&
        createPortal(
          <PipRecorderControls
            recState={phase}
            elapsedMs={elapsedMs}
            micEnabled={micEnabled}
            onPauseResume={pauseResume}
            onStop={onStop}
            onToggleMic={toggleMic}
          />,
          pip.pipWindow.document.body,
        )}
    </SessionActionsContext.Provider>
  );
}
