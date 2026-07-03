"use client";

// TASK-25 / TASK-40 — the product "New recording" surface in the sidebar. The
// recorder itself (state, disk, PiP) lives in SessionActionsProvider now so it
// can be started from the empty state too; this component only renders the
// sidebar's view of it:
//
// Idle: the primary sidebar button (the ETALON primary style — see empty state
// and the Analyze CTA, which match it). Recording: a compact in-page control
// block (REC + timer + mic / pause / stop / pop-out). The PiP floating widget is
// rendered by the provider, not here — it drives the SAME recorder either way.

import {
  Mic,
  MicOff,
  Pause,
  PictureInPicture2,
  Play,
  Square,
  Video,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSessionActions } from "@/components/recording/session-actions";
import { formatElapsed } from "@/hooks/useRecordingElapsed";
import type { RecorderState } from "@/lib/recording/recorder";
import { cn } from "@/lib/utils";

export function NewRecording() {
  const { startRecording, recordingActive, recording } = useSessionActions();

  if (!recordingActive) {
    // Same Button component as the empty-state CTA (guaranteed identical size),
    // full-width to fill the sidebar row.
    return (
      <Button onClick={startRecording} className="w-full">
        <Video strokeWidth={1.5} />
        New recording
      </Button>
    );
  }

  return (
    <InPageControls
      phase={recording.phase}
      elapsedMs={recording.elapsedMs}
      micEnabled={recording.micEnabled}
      canPopOut={recording.canPopOut}
      onPauseResume={recording.pauseResume}
      onStop={recording.stop}
      onToggleMic={recording.toggleMic}
      onPopOut={recording.popOut}
    />
  );
}

// The in-page recording surface: a dense, monochrome block (ADR-004) that fits
// the sidebar's width. REC/timer up top; mic / pause / pop-out / Stop below.
function InPageControls({
  phase,
  elapsedMs,
  micEnabled,
  canPopOut,
  onPauseResume,
  onStop,
  onToggleMic,
  onPopOut,
}: {
  phase: RecorderState;
  elapsedMs: number;
  micEnabled: boolean;
  canPopOut: boolean;
  onPauseResume: () => void;
  onStop: () => void;
  onToggleMic: () => void;
  onPopOut: () => void;
}) {
  const isRecording = phase === "recording";
  const isPaused = phase === "paused";

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <RecDot isRecording={isRecording} isPaused={isPaused} />
        <span className="font-mono text-[11px] font-semibold tracking-wider text-foreground">
          {isRecording ? "REC" : "PAUSED"}
        </span>
        <span className="ml-auto font-mono text-xs tabular-nums text-foreground">
          {formatElapsed(elapsedMs)}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onToggleMic}
          aria-label={micEnabled ? "Mute microphone" : "Unmute microphone"}
          className={cn(!micEnabled && "text-muted-foreground")}
        >
          {micEnabled ? (
            <Mic strokeWidth={1.5} />
          ) : (
            <MicOff strokeWidth={1.5} />
          )}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onPauseResume}
          aria-label={isPaused ? "Resume recording" : "Pause recording"}
        >
          {isPaused ? <Play strokeWidth={1.5} /> : <Pause strokeWidth={1.5} />}
        </Button>
        {canPopOut && (
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onPopOut}
            aria-label="Pop out floating controls"
          >
            <PictureInPicture2 strokeWidth={1.5} />
          </Button>
        )}
        <Button size="sm" onClick={onStop} className="ml-auto">
          <Square fill="currentColor" strokeWidth={2} />
          Stop
        </Button>
      </div>
    </div>
  );
}

// Mirrors the RecIndicator dot (record-test / PiP widget): a solid pulsing dot
// while recording, a hollow ring when paused. Monochrome (ADR-004); the pulse is
// a calm ~1.6s breathe animating only opacity+transform (ADR-005). The keyframe
// is scoped and self-contained so this block needs no shared-CSS change.
function RecDot({
  isRecording,
  isPaused,
}: {
  isRecording: boolean;
  isPaused: boolean;
}) {
  return (
    <>
      <style>{`@keyframes vellum-rec-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}.vellum-rec-dot{animation:vellum-rec-pulse 1.6s ease-in-out infinite}`}</style>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          isRecording && "vellum-rec-dot bg-foreground",
          isPaused && "border-[1.5px] border-foreground",
        )}
      />
    </>
  );
}
