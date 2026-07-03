// TASK-13 — elapsed *recording* time, paused-aware.
//
// Shows ACTIVE recording time, not wall-clock: MediaRecorder.pause() stops
// capturing, so a pause must not add time — otherwise the timer drifts away
// from the real duration of the WebM (ARCHITECTURE §Recording defaults).
//
// Segment-accumulator model (the accurate one): we sum completed active
// segments into `accumulatedRef` and, while recording, add the live tail
// (now - segmentStart). Segment boundaries are captured with performance.now()
// at the exact moment the recorder state changes — the caller drives that by
// calling `setState` right where it flips MediaRecorder, so the boundary is
// precise rather than rounded to the render tick.
//
// The recorder's own state ('recording'/'paused'/'inactive') is the source of
// truth; `setState` mirrors each transition:
//   inactive → recording : fresh recording, reset to 0, open a segment
//   paused   → recording : resume, open a new segment (keep accumulated)
//   recording→ paused     : close the segment (freeze; pause adds no time)
//   *        → inactive   : stop, close any open segment, freeze final value
// A new recording (inactive → recording) is the only thing that resets to 0,
// so the final duration stays on screen after Stop until the next Record.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecorderState } from "@/lib/recording/recorder";

// 200ms keeps the seconds digit honest without busy-looping; the displayed
// value is always recomputed from timestamps, so the interval only paces
// repaints — it never accumulates its own rounding error (that was approach B).
const TICK_MS = 200;

export interface RecordingElapsed {
  /** Active recording time in ms. Re-renders while recording; frozen otherwise. */
  elapsedMs: number;
  /** Mirror every recorder transition here, alongside the MediaRecorder call. */
  setState: (next: RecorderState) => void;
}

export function useRecordingElapsed(): RecordingElapsed {
  const accumulatedRef = useRef(0); // sum of completed active segments
  const segmentStartRef = useRef<number | null>(null); // performance.now() of open segment, or null
  const statusRef = useRef<RecorderState>("inactive");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [running, setRunning] = useState(false);

  const compute = useCallback(
    () =>
      accumulatedRef.current +
      (segmentStartRef.current !== null ? performance.now() - segmentStartRef.current : 0),
    [],
  );

  const setState = useCallback(
    (next: RecorderState) => {
      const prev = statusRef.current;
      if (next === prev) return; // idempotent — safe to call freely
      const now = performance.now();

      if (next === "recording") {
        if (prev === "inactive") accumulatedRef.current = 0; // fresh recording resets
        segmentStartRef.current = now; // start or resume opens a segment
      } else if (segmentStartRef.current !== null) {
        // pause or stop closes the open segment; the tail counts up to NOW only
        accumulatedRef.current += now - segmentStartRef.current;
        segmentStartRef.current = null;
      }

      statusRef.current = next;
      setElapsedMs(compute());
      setRunning(next === "recording");
    },
    [compute],
  );

  // Repaint while recording. Cleared on pause/stop, so a paused timer truly
  // stands still rather than re-rendering the same number.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsedMs(compute()), TICK_MS);
    return () => window.clearInterval(id);
  }, [running, compute]);

  return { elapsedMs, setState };
}

/** Format active ms as m:ss, widening to h:mm:ss past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
