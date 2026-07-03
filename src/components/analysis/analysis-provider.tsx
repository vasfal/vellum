"use client";

// TASK-42 — the app-level analysis controller. Analysis used to live inside
// SessionView via useAnalyze, which aborted the run on unmount — so navigating
// to another session killed the analysis and there was no Cancel. This provider
// lifts that state ABOVE the router (mounted in (app)/layout, like
// SessionActionsProvider), so a run survives session-to-session navigation and
// its progress stays observable from both the session view and the sidebar row.
//
// Product decisions (Vasyl, TASK-42): one analysis at a time (no queue — the CTA
// on other sessions is blocked); Cancel asks for confirmation; a page reload
// aborts the run (nothing is persisted server-side — stateless server, ADR-014).
//
// The flow itself still lives in lib/analyze/run-analyze (reused verbatim); this
// controller only owns the React state, the AbortController, and the "one at a
// time" rule.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useWorkspace } from "@/components/workspace/workspace-provider";
import {
  AnalysisConfigDialog,
  type AnalysisConfig,
} from "@/components/analysis/analysis-config-dialog";
import {
  AnalyzeFlowError,
  runAnalyze,
  type AnalyzePhase,
} from "@/lib/analyze/run-analyze";

/** The single in-flight run, keyed by the session folder name. */
export interface ActiveAnalysis {
  name: string;
  phase: AnalyzePhase;
  /** `extracting` carries an n-of-m frame counter; other phases leave these unset. */
  n?: number;
  m?: number;
  status: "running";
}

/** A failed run, retained per session name so the view can offer Retry. */
export interface AnalysisError {
  kind: string;
  message: string;
}

interface AnalysisContextValue {
  /** The one active run, or null. Read by the session view AND each sidebar row. */
  analysis: ActiveAnalysis | null;
  /**
   * Open the pre-analysis config screen (TASK-47) for a session by folder name.
   * No-op if another run is active (one at a time). The real run only starts once
   * the user confirms the model/mode/language; cancelling writes nothing.
   */
  analyze: (name: string) => void;
  /** Abort the active run (client stream + server pipeline via req.signal). */
  cancelAnalyze: () => void;
  /** Last error per session name, so a session view can show it + a Retry. */
  errors: Record<string, AnalysisError>;
  /** Bumped per session name each time a run for it completes, so the open
   *  session view can reload in place with the freshly-written report. */
  completions: Record<string, number>;
}

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

/** Read the analysis controller. Valid inside AnalysisProvider (app shell). */
export function useAnalysis(): AnalysisContextValue {
  const value = useContext(AnalysisContext);
  if (!value) {
    throw new Error("useAnalysis must be used within an AnalysisProvider");
  }
  return value;
}

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const { handle, refreshSessions } = useWorkspace();

  const [analysis, setAnalysis] = useState<ActiveAnalysis | null>(null);
  const [errors, setErrors] = useState<Record<string, AnalysisError>>({});
  const [completions, setCompletions] = useState<Record<string, number>>({});
  // The session awaiting a config choice (TASK-47), or null when the config
  // screen is closed. Set by analyze(); cleared on confirm (→ beginRun) or cancel.
  const [pending, setPending] = useState<{ name: string } | null>(null);

  // The controller for the active run, and a token that invalidates a run's
  // late async callbacks after a Cancel or a superseding start (mirrors the
  // import flow's runToken guard in session-actions).
  const abortRef = useRef<AbortController | null>(null);
  const runTokenRef = useRef(0);
  // A ref mirror of "is a run active", read inside analyze() to enforce the
  // one-at-a-time rule without depending on (and re-creating with) `analysis`.
  const activeRef = useRef(false);

  // Opening the config screen is all analyze() does now (TASK-47) — the run
  // starts on confirm (beginRun). Still one at a time: if a run is live, ignore.
  const analyze = useCallback((name: string) => {
    if (activeRef.current) return; // one at a time — the UI also blocks this
    setPending({ name });
  }, []);

  // The real run, started once the user confirms the config screen. This is the
  // pre-TASK-47 analyze() body verbatim, plus threading {model, mode, language}
  // into runAnalyze (the picker's choice, TASK-46/49/50).
  const beginRun = useCallback(
    (name: string, config: AnalysisConfig) => {
      if (activeRef.current) return; // guard: a run raced in ahead of the confirm

      const token = ++runTokenRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      activeRef.current = true;

      // Clear any prior error for this session as the fresh run begins (Retry).
      setErrors((prev) => {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setAnalysis({ name, phase: "upload", status: "running" });

      void (async () => {
        try {
          const sessionDir = await handle.getDirectoryHandle(name);
          await runAnalyze({
            sessionDir,
            sessionName: name,
            model: config.model,
            mode: config.mode,
            language: config.language,
            signal: controller.signal,
            onProgress: (progress) => {
              if (runTokenRef.current !== token) return;
              setAnalysis({
                name,
                phase: progress.phase,
                n: progress.n,
                m: progress.m,
                status: "running",
              });
            },
          });
          if (runTokenRef.current !== token) return;
          activeRef.current = false;
          setAnalysis(null);
          // Signal the open session view to reload in place, and re-scan the
          // sidebar (an un-analyzed session now has its first tasks.json — ADR-008).
          setCompletions((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
          refreshSessions();
        } catch (err) {
          // AbortError only fires from a Cancel or reload, which already bumped
          // the token and cleared state — nothing to do.
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (runTokenRef.current !== token) return;
          activeRef.current = false;
          setAnalysis(null);
          const error: AnalysisError =
            err instanceof AnalyzeFlowError
              ? { kind: err.kind, message: err.message }
              : {
                  kind: "internal",
                  message: err instanceof Error ? err.message : String(err),
                };
          setErrors((prev) => ({ ...prev, [name]: error }));
        }
      })();
    },
    [handle, refreshSessions],
  );

  const cancelAnalyze = useCallback(() => {
    runTokenRef.current += 1; // invalidate the in-flight run's late callbacks
    activeRef.current = false;
    abortRef.current?.abort();
    // Cancel is clean: nothing was written (writeReportBrowser only runs on
    // success), so the session stays exactly as it was — no error, no partial.
    setAnalysis(null);
  }, []);

  // Confirm the config screen: close it and start the run for the pending
  // session with the chosen model/mode/language.
  const startPending = useCallback(
    (config: AnalysisConfig) => {
      if (!pending) return;
      const { name } = pending;
      setPending(null);
      beginRun(name, config);
    },
    [pending, beginRun],
  );

  return (
    <AnalysisContext.Provider
      value={{ analysis, analyze, cancelAnalyze, errors, completions }}
    >
      {children}

      {/* App-level config screen (TASK-47), so every trigger — record, import,
          re-analyze — opens it consistently, over the session view. Cancelling
          writes nothing: the session stays unanalyzed. */}
      <AnalysisConfigDialog
        sessionName={pending?.name ?? null}
        onStart={startPending}
        onClose={() => setPending(null)}
      />
    </AnalysisContext.Provider>
  );
}
