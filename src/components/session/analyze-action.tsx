"use client";

import Link from "next/link";
import {
  Check,
  KeyRound,
  Loader2,
  Wand,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AnalyzePhase, AnalyzeProgress } from "@/lib/analyze/run-analyze";

// TASK-28 — the Analyze surface for the session view, split into two pieces that
// render from the app-level analysis controller (TASK-42):
//   AnalyzeButton — the header trigger (Analyze / Re-analyze / running label)
//   AnalyzeStatus — the strip under the header (granular progress + Cancel, or
//   error + Retry)
// Monochrome, Linear density (ADR-004); hierarchy from contrast + a mono step
// counter, not colour. The active step spins; done steps check; pending steps
// dim — informative, not one opaque spinner (ARCHITECTURE §Error handling).

// TASK-42 — a view-facing projection of the controller's per-session state. The
// controller owns the run (AnalysisProvider); the session view maps its slice of
// that into this shape so the strip + buttons stay presentational.
export type AnalyzeState =
  | { status: "idle" }
  | { status: "running"; progress: AnalyzeProgress }
  | { status: "error"; kind: string; message: string }
  | { status: "done" };

/** Header trigger. Disabled only while a run is in flight. */
export function AnalyzeButton({
  state,
  hasAnalysis,
  onStart,
}: {
  state: AnalyzeState;
  /** Existing analyzed session -> "Re-analyze"; otherwise a first "Analyze". */
  hasAnalysis: boolean;
  onStart: () => void;
}) {
  const running = state.status === "running";
  const Icon = hasAnalysis ? RefreshCw : Wand;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onStart}
      disabled={running}
      className="shrink-0"
    >
      {running ? (
        <Loader2 className="animate-spin" strokeWidth={1.5} />
      ) : (
        <Icon strokeWidth={1.5} />
      )}
      {running ? "Analyzing…" : hasAnalysis ? "Re-analyze" : "Analyze"}
    </Button>
  );
}

/** Full-width strip under the header. Renders only while running or on error. */
export function AnalyzeStatus({
  state,
  onRetry,
  onCancel,
}: {
  state: AnalyzeState;
  onRetry: () => void;
  /** Opens the Cancel-analysis confirmation (TASK-42). Shown only while running. */
  onCancel: () => void;
}) {
  if (state.status === "running")
    return <ProgressStrip progress={state.progress} onCancel={onCancel} />;
  if (state.status === "error")
    return (
      <ErrorStrip kind={state.kind} message={state.message} onRetry={onRetry} />
    );
  return null;
}

const PHASE_STEPS: { phase: AnalyzePhase; label: string }[] = [
  { phase: "upload", label: "Upload" },
  { phase: "analyzing", label: "Analyze" },
  { phase: "extracting", label: "Extract" },
  { phase: "writing", label: "Write" },
];

type StepStatus = "done" | "active" | "pending";

function ProgressStrip({
  progress,
  onCancel,
}: {
  progress: AnalyzeProgress;
  onCancel: () => void;
}) {
  return (
    <div className="relative flex items-center border-b border-border bg-card px-4 py-2.5">
      <span className="shrink-0 text-sm font-medium text-muted-foreground">
        Analyzing…
      </span>
      {/* Steps centered in the whole strip (not just the space between the label
          and Cancel) — absolutely placed so they don't shift with those widths. */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center">
        <AnalyzePhaseSteps progress={progress} />
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X strokeWidth={1.5} />
        Cancel
      </Button>
    </div>
  );
}

/**
 * The pipeline phase tracker: active step spins, done steps check, pending steps
 * dim. Shared by the session view's progress strip and the import dialog
 * (TASK-30) so both entry points show the identical analyze progress.
 */
export function AnalyzePhaseSteps({ progress }: { progress: AnalyzeProgress }) {
  const activeIndex = PHASE_STEPS.findIndex((s) => s.phase === progress.phase);

  return (
    <ol className="flex items-center">
      {PHASE_STEPS.map((step, i) => {
        const status: StepStatus =
          i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
        return (
          <li key={step.phase} className="flex items-center">
            <StepDot status={status} />
            <span
              className={cn(
                "ml-2 font-mono text-[13px] tracking-tight",
                status === "active" && "text-foreground",
                status === "done" && "text-muted-foreground",
                status === "pending" && "text-muted-foreground/50",
              )}
            >
              {stepLabel(step, status, progress)}
            </span>
            {i < PHASE_STEPS.length - 1 && (
              <span className="mx-3 h-px w-5 shrink-0 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepDot({ status }: { status: StepStatus }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      {status === "done" ? (
        <Check className="size-3.5 text-muted-foreground" strokeWidth={2} />
      ) : status === "active" ? (
        <Loader2 className="size-3.5 animate-spin text-foreground" strokeWidth={2} />
      ) : (
        <span className="size-1.5 rounded-full bg-border" aria-hidden />
      )}
    </span>
  );
}

function stepLabel(
  step: { phase: AnalyzePhase; label: string },
  status: StepStatus,
  progress: AnalyzeProgress,
): string {
  if (step.phase === "extracting" && status === "active" && progress.m) {
    return `${step.label} ${progress.n ?? 0}/${progress.m}`;
  }
  return step.label;
}

function ErrorStrip({
  kind,
  message,
  onRetry,
}: {
  kind: string;
  message: string;
  onRetry: () => void;
}) {
  // A missing/invalid GEMINI_API_KEY surfaces as an "upload" error. The inline
  // message already carries guidance; route to the dedicated step-by-step key
  // screen (TASK-29) for the full walkthrough, without blocking the Retry.
  const isKeyProblem = kind === "upload";

  return (
    <div className="flex items-start gap-3 border-b border-border bg-card px-4 py-3">
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        strokeWidth={1.5}
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">Analysis failed</p>
        <p className="mt-0.5 text-xs whitespace-pre-line text-muted-foreground">
          {message}
        </p>
        {isKeyProblem && (
          <Link
            href="/settings/key"
            className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
          >
            <KeyRound className="size-3 shrink-0" strokeWidth={1.5} />
            Set up your Gemini API key
          </Link>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="shrink-0"
      >
        <RefreshCw strokeWidth={1.5} />
        Retry
      </Button>
    </div>
  );
}
