"use client";

// TASK-10 + TASK-11 — minimal capture + record test page (not product UI).
//
// TASK-10 proved we can build ONE combined MediaStream of screen video + mic
// audio, capped at 1440p-class resolution, mic toggleable.
//
// TASK-11 wraps that stream in MediaRecorder (lib/recording/recorder.ts):
// VP9/Opus WebM, ~2.5 Mbps, chunked via timeslice. Chunks arrive through the
// `onChunk` seam (what TASK-12 will stream to disk); here we collect them only
// to assemble a Blob, play it back, and download it for ffprobe verification.

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createRecorder,
  VELLUM_MIME,
  VELLUM_TIMESLICE_MS,
  type RecorderHandle,
  type RecorderState,
} from "@/lib/recording/recorder";
import { useDocumentPip } from "@/hooks/useDocumentPip";
import { PipRecorderControls } from "@/components/recording/pip-recorder-controls";
import {
  createRecordingSink,
  pickWorkspaceDirectory,
  type RecordingSink,
} from "@/lib/filesystem/recording-sink";
import { useRecordingElapsed, formatElapsed } from "@/hooks/useRecordingElapsed";

// QHD-class cap. ARCHITECTURE §Recording defaults: "native resolution, capped at
// 1440p on the long side". Chrome downscales the display surface to satisfy these
// max constraints; we verify the real numbers from track.getSettings() at runtime.
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1440;

export default function RecordTestPage() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [recState, setRecState] = useState<RecorderState>("inactive");
  // Active recording time, paused-aware (TASK-13). `markElapsed` is driven off
  // the same state transitions as setRecState below — see each call site.
  const { elapsedMs, setState: markElapsed } = useRecordingElapsed();
  const [chunkCount, setChunkCount] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const combinedStreamRef = useRef<MediaStream | null>(null);

  const recorderRef = useRef<RecorderHandle | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // TASK-12: the chosen workspace folder and the open disk sink for this recording.
  const [workspaceDirName, setWorkspaceDirName] = useState<string | null>(null);
  const [sinkPath, setSinkPath] = useState<string | null>(null);
  const workspaceDirRef = useRef<FileSystemDirectoryHandle | null>(null);
  const sinkRef = useRef<RecordingSink | null>(null);

  const log = useCallback((message: string) => {
    // eslint-disable-next-line no-console -- console output is the verification evidence
    console.log(`[record-test] ${message}`);
    setLogs((prev) => [...prev, message]);
  }, []);

  // TASK-16 — floating controls in a Document PiP window (ADR-007). Closing the
  // window only tears down the widget; the recorder keeps running (AC#4).
  const pip = useDocumentPip({
    onClose: () => log("PiP controls closed — recording continues via in-page controls"),
  });

  const stopCapture = useCallback(() => {
    // Stop the recorder first so its final chunk flushes before tracks die.
    if (recorderRef.current && recorderRef.current.state() !== "inactive") {
      void recorderRef.current.stop();
      recorderRef.current = null;
      setRecState("inactive");
      markElapsed("inactive"); // native "Stop sharing" mid-record → freeze timer
    }
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current = null;
    combinedStreamRef.current = null;
    if (videoElRef.current) videoElRef.current.srcObject = null;
    setIsCapturing(false);
    pip.close(); // no capture → no controls to float
    log("capture stopped — all tracks ended");
  }, [log, markElapsed, pip]);

  const startCapture = useCallback(async () => {
    try {
      log("requesting screen via getDisplayMedia (native picker)…");
      // audio:false → no system-audio checkbox; system audio is out of scope (ADR-003).
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { max: MAX_WIDTH },
          height: { max: MAX_HEIGHT },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      displayStreamRef.current = display;

      const videoTrack = display.getVideoTracks()[0];
      const s = videoTrack.getSettings();
      const longSide = Math.max(s.width ?? 0, s.height ?? 0);
      const shortSide = Math.min(s.width ?? 0, s.height ?? 0);
      log(
        `screen track: ${s.width}×${s.height} @ ${s.frameRate}fps ` +
          `(long ${longSide}, short ${shortSide}) — cap ≤${MAX_WIDTH}×${MAX_HEIGHT}: ` +
          (longSide <= MAX_WIDTH && shortSide <= MAX_HEIGHT ? "OK" : "OVER CAP"),
      );

      log("requesting microphone via getUserMedia (on by default)…");
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = mic;
      const micTrack = mic.getAudioTracks()[0];
      micTrack.enabled = micEnabled; // honor current toggle state
      log(`mic track: "${micTrack.label}" enabled=${micTrack.enabled}`);

      // The single combined stream that MediaRecorder (TASK-11) consumes.
      const combined = new MediaStream([
        ...display.getVideoTracks(),
        ...mic.getAudioTracks(),
      ]);
      combinedStreamRef.current = combined;
      log(
        `combined stream: ${combined.getVideoTracks().length} video + ` +
          `${combined.getAudioTracks().length} audio track`,
      );

      log(`MediaRecorder.isTypeSupported("${VELLUM_MIME}") = ${MediaRecorder.isTypeSupported(VELLUM_MIME)}`);

      if (videoElRef.current) {
        videoElRef.current.srcObject = combined;
      }

      // User can stop sharing from the browser's native bar → clean up.
      videoTrack.addEventListener("ended", () => {
        log("screen track ended (native Stop sharing) — cleaning up");
        stopCapture();
      });

      setIsCapturing(true);
    } catch (err) {
      // NotAllowedError when the user cancels the picker — expected, not fatal.
      const name = err instanceof Error ? err.name : "Unknown";
      const msg = err instanceof Error ? err.message : String(err);
      log(`capture failed: ${name} — ${msg}`);
      stopCapture();
    }
  }, [log, micEnabled, stopCapture]);

  const toggleMic = useCallback(() => {
    // Keep side effects OUT of the setState updater: React StrictMode double-invokes
    // updaters in dev to surface impurity, which would double-fire the track flip + log.
    const next = !micEnabled;
    const micTrack = micStreamRef.current?.getAudioTracks()[0];
    if (micTrack) micTrack.enabled = next; // flip, don't stop — toggle without re-prompting
    log(`mic ${next ? "ON" : "OFF"}${micTrack ? ` (track.enabled=${next})` : " — no active track yet"}`);
    setMicEnabled(next);
  }, [log, micEnabled]);

  const chooseFolder = useCallback(async () => {
    try {
      const dir = await pickWorkspaceDirectory();
      workspaceDirRef.current = dir;
      setWorkspaceDirName(dir.name);
      log(`workspace folder chosen: "${dir.name}" (read+write granted)`);
    } catch (err) {
      const name = err instanceof Error ? err.name : "Unknown";
      // AbortError = user dismissed the picker; not a failure.
      if (name === "AbortError") {
        log("folder pick cancelled");
        return;
      }
      log(`folder pick failed: ${name}`);
    }
  }, [log]);

  const startRecording = useCallback(async () => {
    const stream = combinedStreamRef.current;
    if (!stream) {
      log("cannot record — no active capture");
      return;
    }

    // Fresh recording: drop any prior chunks and revoke the old playback URL.
    chunksRef.current = [];
    setChunkCount(0);
    setTotalBytes(0);
    setSinkPath(null);
    setRecordedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    // Open the disk sink BEFORE start() so the very first chunk can stream out.
    // No folder chosen → fall back to in-memory only (still a valid record test).
    const workspace = workspaceDirRef.current;
    if (workspace) {
      try {
        const sink = await createRecordingSink(workspace, new Date());
        sinkRef.current = sink;
        setSinkPath(sink.relativePath);
        log(`streaming to disk → ${sink.relativePath} (committed on Stop)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`failed to open disk sink: ${msg} — recording in-memory only`);
        sinkRef.current = null;
      }
    } else {
      sinkRef.current = null;
      log("no folder chosen — recording in-memory only (Choose folder to stream to disk)");
    }

    try {
      const recorder = createRecorder({
        stream,
        onChunk: (chunk) => {
          chunksRef.current.push(chunk);
          setChunkCount((n) => n + 1);
          setTotalBytes((b) => b + chunk.size);
          // The TASK-12 path: stream each chunk straight to disk as it arrives.
          // Writes are serialized inside the sink; we fire-and-log on failure.
          if (sinkRef.current) {
            void sinkRef.current.write(chunk).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log(`disk write failed: ${msg}`);
            });
          }
          log(`chunk #${chunksRef.current.length}: ${chunk.size} bytes${sinkRef.current ? " → disk" : ""}`);
        },
        onError: (err) => log(`recorder error: ${err.name} — ${err.message}`),
      });
      recorderRef.current = recorder;
      recorder.start();
      setRecState("recording");
      markElapsed("recording"); // fresh recording → timer resets to 0 and runs
      log(`recording started — mime=${VELLUM_MIME}, timeslice=${VELLUM_TIMESLICE_MS}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to start recorder: ${msg}`);
    }
  }, [log, markElapsed]);

  const pauseResume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state() === "recording") {
      recorder.pause();
      setRecState("paused");
      markElapsed("paused"); // capture stops → timer freezes (no time added)
      log("recording paused");
    } else if (recorder.state() === "paused") {
      recorder.resume();
      setRecState("recording");
      markElapsed("recording"); // capture resumes → timer continues
      log("recording resumed");
    }
  }, [log, markElapsed]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    await recorder.stop();
    recorderRef.current = null;
    setRecState("inactive");
    markElapsed("inactive"); // stop → close segment, freeze final duration on screen

    // Commit the streamed file: drain the write queue, then close the writable
    // so Chromium renames the swap file onto recording.webm.
    const sink = sinkRef.current;
    if (sink) {
      try {
        await sink.close();
        log(`disk file committed → ${sink.relativePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`failed to commit disk file: ${msg}`);
      }
      sinkRef.current = null;
    }

    // All chunks are in by the time stop() resolves — assemble the WebM for
    // in-page playback (test surface only; disk write above is independent).
    const blob = new Blob(chunksRef.current, { type: VELLUM_MIME });
    const url = URL.createObjectURL(blob);
    setRecordedUrl(url);
    log(
      `recording stopped — assembled ${chunksRef.current.length} chunks → ` +
        `${blob.size} bytes, type="${blob.type}"`,
    );

    // Stopping the recording closes the floating widget (AC#4).
    pip.close();
  }, [log, markElapsed, pip]);

  // Pop the controls out into the always-on-top PiP window. Must run from this
  // click (user gesture). The widget is rendered via a portal below.
  const popOutControls = useCallback(async () => {
    try {
      // A compact single-row pill. Chromium may override this with the window
      // size the user last left, so the widget is built to center gracefully at
      // any height (verified down to ~36px).
      await pip.open({ width: 320, height: 72 });
      log("PiP controls opened — floats above all windows, works when tab is unfocused");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to open PiP controls: ${msg} — use the in-page controls`);
    }
  }, [log, pip]);

  const canRecord = isCapturing && recState === "inactive";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#ededed",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: "32px",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        maxWidth: "880px",
        margin: "0 auto",
      }}
    >
      <header>
        <h1 style={{ fontSize: "15px", fontWeight: 600, margin: 0 }}>TASK-10 · TASK-11 · capture + record test</h1>
        <p style={{ fontSize: "13px", color: "#888", margin: "4px 0 0" }}>
          screen + mic → MediaStream → MediaRecorder (VP9/Opus, ~2.5 Mbps, chunked). Not product UI.
        </p>
      </header>

      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        {!isCapturing ? (
          <button onClick={startCapture} style={btnStyle}>
            Start capture
          </button>
        ) : (
          <button onClick={stopCapture} style={btnStyle}>
            Stop capture
          </button>
        )}
        <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", color: "#bbb" }}>
          <input type="checkbox" checked={micEnabled} onChange={toggleMic} />
          Microphone {micEnabled ? "on" : "off"}
        </label>

        <span style={{ width: "1px", height: "20px", background: "#2a2a2a" }} />

        <button onClick={chooseFolder} style={btnStyle}>
          Choose folder
        </button>
        <span style={{ fontSize: "12px", color: "#888", fontFamily: "ui-monospace, monospace" }}>
          {workspaceDirName ? `folder: ${workspaceDirName}` : "no folder — in-memory only"}
        </span>

        <span style={{ width: "1px", height: "20px", background: "#2a2a2a" }} />

        <button onClick={startRecording} disabled={!canRecord} style={canRecord ? btnStyle : btnDisabledStyle}>
          ● Record
        </button>
        <button
          onClick={pauseResume}
          disabled={recState === "inactive"}
          style={recState === "inactive" ? btnDisabledStyle : btnStyle}
        >
          {recState === "paused" ? "Resume" : "Pause"}
        </button>
        <button
          onClick={stopRecording}
          disabled={recState === "inactive"}
          style={recState === "inactive" ? btnDisabledStyle : btnStyle}
        >
          Stop recording
        </button>

        <span style={{ fontSize: "12px", color: "#888", fontFamily: "ui-monospace, monospace" }}>
          {chunkCount} chunks · {(totalBytes / 1024).toFixed(0)} KB
          {sinkPath ? ` · → ${sinkPath}` : ""}
        </span>
      </div>

      {/* TASK-16 — pop the controls into an always-on-top PiP window (ADR-007).
          Chromium-only; where unavailable, the in-page controls above still work
          (AC#5). Disabled until there's an active capture to control. */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        {pip.isSupported ? (
          <>
            <button
              onClick={popOutControls}
              disabled={!isCapturing || pip.pipWindow !== null}
              style={!isCapturing || pip.pipWindow !== null ? btnDisabledStyle : btnStyle}
            >
              Pop out controls
            </button>
            <span style={{ fontSize: "12px", color: "#888", fontFamily: "ui-monospace, monospace" }}>
              {pip.pipWindow
                ? "controls floating in PiP window"
                : "always-on-top widget — works when this tab is unfocused"}
            </span>
          </>
        ) : (
          <span style={{ fontSize: "12px", color: "#888" }}>
            Document Picture-in-Picture unavailable in this browser — in-page controls only (Chromium required).
          </span>
        )}
      </div>

      {/* REC indicator + elapsed timer (TASK-13). Reflects the recorder's real
          state; the timer counts active recording time only (paused freezes). */}
      <RecIndicator recState={recState} elapsedMs={elapsedMs} />

      <video
        ref={videoElRef}
        autoPlay
        muted
        playsInline
        style={{ width: "100%", aspectRatio: "16 / 9", background: "#111", borderRadius: "6px", border: "1px solid #222" }}
      />

      {recordedUrl && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <p style={{ fontSize: "12px", color: "#888", margin: 0, fontFamily: "ui-monospace, monospace" }}>
            recorded playback ({(totalBytes / 1024).toFixed(0)} KB):
          </p>
          <video
            src={recordedUrl}
            controls
            playsInline
            style={{ width: "100%", aspectRatio: "16 / 9", background: "#111", borderRadius: "6px", border: "1px solid #222" }}
          />
          <a href={recordedUrl} download="vellum-record-test.webm" style={{ ...btnStyle, width: "fit-content", textDecoration: "none" }}>
            Download .webm
          </a>
        </div>
      )}

      <pre
        style={{
          fontFamily: "ui-monospace, 'Geist Mono', monospace",
          fontSize: "12px",
          lineHeight: 1.6,
          color: "#9a9a9a",
          background: "#0f0f0f",
          border: "1px solid #1d1d1d",
          borderRadius: "6px",
          padding: "12px",
          margin: 0,
          whiteSpace: "pre-wrap",
          minHeight: "120px",
        }}
      >
        {logs.length === 0 ? "// console log mirror — press Start capture" : logs.map((l, i) => `${i + 1}  ${l}`).join("\n")}
      </pre>

      {/* The floating widget lives in the PiP window's document but stays in
          this React tree — so it reads the same recorder state and drives the
          same handlers as the in-page controls (AC#3, TASK-16). */}
      {pip.pipWindow &&
        createPortal(
          <PipRecorderControls
            recState={recState}
            elapsedMs={elapsedMs}
            micEnabled={micEnabled}
            onPauseResume={pauseResume}
            onStop={stopRecording}
            onToggleMic={toggleMic}
          />,
          pip.pipWindow.document.body,
        )}
    </main>
  );
}

// Visual recorder-state readout: a state dot + label + the elapsed timer.
// recording → bright pulsing dot; paused → static hollow ring; inactive → dim.
// Monochrome per ADR-004; timer in Geist Mono with tabular figures so digits
// don't jitter. The pulse is a calm ~1.6s breathe (ambient loop, not an enter
// animation) and animates only opacity+transform, never `all` (ADR-005).
function RecIndicator({ recState, elapsedMs }: { recState: RecorderState; elapsedMs: number }) {
  const isRecording = recState === "recording";
  const isPaused = recState === "paused";

  const dotColor = isRecording ? "#ededed" : isPaused ? "transparent" : "#3a3a3a";
  const dotBorder = isPaused ? "1.5px solid #ededed" : "none";
  const label = isRecording ? "REC" : isPaused ? "PAUSED" : "IDLE";
  const fg = recState === "inactive" ? "#666" : "#ededed";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
      <style>{`
        @keyframes vellum-rec-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.82); }
        }
        .vellum-rec-dot { animation: vellum-rec-pulse 1.6s ease-in-out infinite; }
      `}</style>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "7px" }}>
        <span
          className={isRecording ? "vellum-rec-dot" : undefined}
          style={{
            width: "9px",
            height: "9px",
            borderRadius: "50%",
            background: dotColor,
            border: dotBorder,
            boxSizing: "border-box",
          }}
        />
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: fg,
            fontFamily: "ui-monospace, 'Geist Mono', monospace",
          }}
        >
          {label}
        </span>
      </span>
      <span
        style={{
          fontSize: "22px",
          fontVariantNumeric: "tabular-nums",
          fontFamily: "ui-monospace, 'Geist Mono', monospace",
          letterSpacing: "0.02em",
          color: fg,
        }}
      >
        {formatElapsed(elapsedMs)}
      </span>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#ededed",
  color: "#0a0a0a",
  border: "none",
  borderRadius: "6px",
  padding: "8px 14px",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

const btnDisabledStyle: React.CSSProperties = {
  ...btnStyle,
  background: "#2a2a2a",
  color: "#666",
  cursor: "not-allowed",
};
