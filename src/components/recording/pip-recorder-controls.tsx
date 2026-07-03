"use client";

// TASK-16 — the floating recording widget rendered into the Document PiP window
// (ADR-007). Compact, dark, monochrome (ADR-004) using the TASK-2 token values.
//
// It is a pure presentational component: every action calls a handler passed
// from the record page, which drives the SAME recorder as the in-page controls.
// Because it renders through a portal into the PiP document (see useDocumentPip),
// it stays in the opener's React tree — so `recState`/`elapsedMs`/`micEnabled`
// update here the instant they change in-page, and vice versa (AC#3).
//
// Inline styles only (plus the .vellum-* classes injected into the PiP document
// by useDocumentPip): the PiP document has none of the app's CSS variables, so
// the TASK-2 ramp is referenced here as literal oklch values.

import { Mic, MicOff, Pause, Play, Square } from "lucide-react";
import type { RecorderState } from "@/lib/recording/recorder";
import { formatElapsed } from "@/hooks/useRecordingElapsed";

// TASK-2 monochrome ramp (globals.css), as literals because the PiP document
// doesn't load globals.css and so has no var(--gray-*) to resolve.
const TOKEN = {
  fg: "oklch(0.985 0 0)", // --gray-12 foreground
  muted: "oklch(0.708 0 0)", // --gray-11 muted foreground
  dim: "oklch(0.47 0 0)", // --gray-8 disabled foreground
  ring: "oklch(0.34 0 0)", // --gray-6 hollow-ring border (paused dot)
  border: "oklch(1 0 0 / 8%)", // --border hairline
} as const;

export interface PipRecorderControlsProps {
  recState: RecorderState;
  elapsedMs: number;
  micEnabled: boolean;
  onPauseResume: () => void;
  onStop: () => void;
  onToggleMic: () => void;
}

export function PipRecorderControls({
  recState,
  elapsedMs,
  micEnabled,
  onPauseResume,
  onStop,
  onToggleMic,
}: PipRecorderControlsProps) {
  const isRecording = recState === "recording";
  const isPaused = recState === "paused";
  const isActive = isRecording || isPaused; // a recording exists (not stopped)

  // Mirrors the in-page RecIndicator: bright pulsing dot while recording,
  // hollow ring when paused, dim when idle. Monochrome (ADR-004).
  const dotColor = isRecording ? TOKEN.fg : isPaused ? "transparent" : TOKEN.dim;
  const dotBorder = isPaused ? `1.5px solid ${TOKEN.fg}` : "none";
  const label = isRecording ? "REC" : isPaused ? "PAUSED" : "IDLE";
  const fg = isActive ? TOKEN.fg : TOKEN.muted;

  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100vh",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "0 14px",
      }}
    >
      {/* Indicator + elapsed timer */}
      <div style={{ display: "flex", alignItems: "center", gap: "9px", minWidth: 0 }}>
        <span
          className={isRecording ? "vellum-rec-dot" : undefined}
          style={{
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            background: dotColor,
            border: dotBorder,
            boxSizing: "border-box",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.1,
          }}
        >
          <span
            style={{
              fontSize: "9px",
              fontWeight: 600,
              letterSpacing: "0.1em",
              color: fg,
              fontFamily: "ui-monospace, 'Geist Mono', monospace",
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: "19px",
              fontVariantNumeric: "tabular-nums",
              fontFamily: "ui-monospace, 'Geist Mono', monospace",
              letterSpacing: "0.02em",
              color: fg,
            }}
          >
            {formatElapsed(elapsedMs)}
          </span>
        </span>
      </div>

      <span style={{ flex: 1 }} />

      {/* Controls — same handlers as the in-page buttons (AC#3) */}
      <button
        type="button"
        className="vellum-pip-btn"
        onClick={onToggleMic}
        aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
        title={micEnabled ? "Mic on" : "Mic off"}
        style={!micEnabled ? { color: TOKEN.muted } : undefined}
      >
        {micEnabled ? <Mic size={16} strokeWidth={1.75} /> : <MicOff size={16} strokeWidth={1.75} />}
      </button>

      <button
        type="button"
        className="vellum-pip-btn"
        onClick={onPauseResume}
        disabled={!isActive}
        aria-label={isPaused ? "Resume recording" : "Pause recording"}
        title={isPaused ? "Resume" : "Pause"}
      >
        {isPaused ? <Play size={16} strokeWidth={1.75} /> : <Pause size={16} strokeWidth={1.75} />}
      </button>

      <button
        type="button"
        className="vellum-pip-btn"
        data-variant="stop"
        onClick={onStop}
        disabled={!isActive}
        aria-label="Stop recording"
        title="Stop"
      >
        <Square size={15} strokeWidth={2} fill="currentColor" />
      </button>
    </div>
  );
}
