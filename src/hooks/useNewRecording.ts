"use client";

// TASK-25 — the PRODUCT recording lifecycle (S2). Reuses the Phase 2 primitives
// (getDisplayMedia+getUserMedia capture — TASK-10, MediaRecorder — TASK-11,
// createRecordingSink — TASK-12, useRecordingElapsed — TASK-13) but, unlike the
// /record-test page, it streams into the ADOPTED workspace handle (TASK-15) — no
// fresh folder picker — and hands the created session name back on Stop so the
// caller can navigate to it (ARCHITECTURE §Data flow steps 2-4).
//
// PiP floating controls (TASK-16 / ADR-007) are NOT owned here: the component
// wires them, because the widget renders through a portal from React JSX. This
// hook is the recorder + disk + timer state machine only.

import { useCallback, useRef, useState } from "react";

import {
  createRecorder,
  type RecorderHandle,
  type RecorderState,
} from "@/lib/recording/recorder";
import {
  createRecordingSink,
  type RecordingSink,
} from "@/lib/filesystem/recording-sink";
import { useRecordingElapsed } from "@/hooks/useRecordingElapsed";

// QHD-class cap. ARCHITECTURE §Recording defaults: "native resolution, capped at
// 1440p on the long side". Chrome downscales the display surface to satisfy the
// max constraints. Same values the record-test page proved out (TASK-10).
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1440;

interface UseNewRecordingArgs {
  /** The adopted, ready workspace root (TASK-15). The session folder lands here. */
  workspace: FileSystemDirectoryHandle;
  /** Fired after Stop, once recording.webm is committed. `name` = session folder. */
  onSaved: (sessionName: string) => void;
}

export interface NewRecordingHandle {
  /** Recorder state, drives the controls: inactive / recording / paused. */
  phase: RecorderState;
  micEnabled: boolean;
  /** Active recording time in ms (paused-aware — TASK-13). */
  elapsedMs: number;
  /** A real failure to surface (fail loud). Cleared on the next start(). */
  error: string | null;
  /** Begin capture + recording. Resolves true once recording is running. A
   *  cancelled screen picker resolves false (a no-op, not an error). */
  start: () => Promise<boolean>;
  pauseResume: () => void;
  toggleMic: () => void;
  /** Stop, commit the file, and call onSaved with the new session name. */
  stop: () => Promise<void>;
}

export function useNewRecording({
  workspace,
  onSaved,
}: UseNewRecordingArgs): NewRecordingHandle {
  const [phase, setPhase] = useState<RecorderState>("inactive");
  const [micEnabled, setMicEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { elapsedMs, setState: markElapsed } = useRecordingElapsed();

  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const sinkRef = useRef<RecordingSink | null>(null);

  const cleanupCapture = useCallback(() => {
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current = null;
  }, []);

  // Stop the recorder, commit the streamed swap file to recording.webm, then hand
  // the session name to the caller. Guarded on recorderRef so a double stop (the
  // Stop button AND the native "Stop sharing" both firing) commits exactly once.
  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;

    await recorder.stop(); // resolves once the final chunk has flushed
    setPhase("inactive");
    markElapsed("inactive"); // freeze the final duration on screen
    cleanupCapture();

    const sink = sinkRef.current;
    sinkRef.current = null;
    if (!sink) return;
    try {
      await sink.close(); // drain the queue, commit swap → recording.webm
      onSaved(sink.sessionDirName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [markElapsed, cleanupCapture, onSaved]);

  const start = useCallback(async (): Promise<boolean> => {
    if (recorderRef.current) return false; // already recording
    setError(null);

    // Screen first. A cancelled picker (NotAllowedError) is a no-op, not a failure.
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: MAX_WIDTH },
          height: { max: MAX_HEIGHT },
          frameRate: { ideal: 30, max: 30 },
        },
        // audio:false → no system-audio checkbox; system audio is out of scope (ADR-003).
        audio: false,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") return false;
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
    displayStreamRef.current = display;

    // Mic on by default. If it's denied or absent, record video-only rather than
    // throwing away the whole session — reflect that by flipping the toggle off.
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const micTrack = mic.getAudioTracks()[0];
      if (micTrack) micTrack.enabled = micEnabled;
    } catch {
      mic = new MediaStream();
      setMicEnabled(false);
    }
    micStreamRef.current = mic;

    // The single combined stream MediaRecorder (TASK-11) consumes.
    const combined = new MediaStream([
      ...display.getVideoTracks(),
      ...mic.getAudioTracks(),
    ]);

    // The browser's own "Stop sharing" ends the display track — treat that as a
    // Stop so the file is committed and the caller navigates, same as the button.
    display.getVideoTracks()[0]?.addEventListener("ended", () => void stop());

    // Open the disk sink BEFORE start() so the very first chunk streams straight
    // to disk (crash-safety via .crswap — AC#4; ARCHITECTURE §Error handling).
    try {
      const sink = await createRecordingSink(workspace, new Date());
      sinkRef.current = sink;
    } catch (err) {
      cleanupCapture();
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }

    try {
      const recorder = createRecorder({
        stream: combined,
        onChunk: (chunk) => {
          // Stream each timeslice chunk to disk as it arrives (TASK-12). Writes
          // are serialized inside the sink; a write failure surfaces, not throws.
          void sinkRef.current?.write(chunk).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        },
        onError: (err) => setError(`${err.name} — ${err.message}`),
      });
      recorderRef.current = recorder;
      recorder.start();
      setPhase("recording");
      markElapsed("recording"); // fresh recording → timer resets to 0 and runs
      return true;
    } catch (err) {
      // Recorder failed to start: tear down capture and discard the empty swap.
      cleanupCapture();
      const orphan = sinkRef.current;
      sinkRef.current = null;
      void orphan?.close().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [workspace, micEnabled, markElapsed, cleanupCapture, stop]);

  const pauseResume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state() === "recording") {
      recorder.pause();
      setPhase("paused");
      markElapsed("paused"); // capture stops → timer freezes (pause adds no time)
    } else if (recorder.state() === "paused") {
      recorder.resume();
      setPhase("recording");
      markElapsed("recording"); // capture resumes → timer continues
    }
  }, [markElapsed]);

  const toggleMic = useCallback(() => {
    // Flip the live track, don't stop it — toggling off then on must not re-prompt.
    const next = !micEnabled;
    const micTrack = micStreamRef.current?.getAudioTracks()[0];
    if (micTrack) micTrack.enabled = next;
    setMicEnabled(next);
  }, [micEnabled]);

  return { phase, micEnabled, elapsedMs, error, start, pauseResume, toggleMic, stop };
}
