// TASK-11 — MediaRecorder wrapper.
//
// Wraps a combined screen+mic MediaStream (built in TASK-10) in a MediaRecorder
// configured to Vellum's recording defaults: VP9 video + Opus audio in a WebM
// container, ~2.5 Mbps target bitrate (ARCHITECTURE §Recording defaults).
//
// The seam for TASK-12 (write-to-disk via File System Access) is `onChunk`:
// every `dataavailable` fires `onChunk(blob)` so the consumer can stream each
// chunk straight to disk as it arrives. That is the whole point of the
// timeslice — the full recording is never held in one buffer, which gives both
// OOM-safety on long recordings and crash-recovery of the partial file
// (ARCHITECTURE §Error handling: "recording tab crash"). This module never
// accumulates chunks itself; whoever wants the assembled Blob collects it from
// `onChunk` (the record-test page does this for short verification recordings).

// VP9 + Opus in WebM — best quality/size in Chromium (CLAUDE.md §MediaRecorder).
export const VELLUM_MIME = "video/webm; codecs=vp9,opus";

// ~2.5 Mbps — UI-text legibility vs file size, ~1.1 GB/hour (ARCHITECTURE
// §Recording defaults, AC#4). Audio rides Opus at its own default bitrate.
export const VELLUM_VIDEO_BITS_PER_SECOND = 2_500_000;

// 1s chunks: small enough that a tab crash loses ≤1s, large enough to keep
// per-chunk overhead negligible. Passed to MediaRecorder.start(timeslice).
export const VELLUM_TIMESLICE_MS = 1000;

export type RecorderState = "inactive" | "recording" | "paused";

export interface RecorderHandle {
  start: () => void;
  pause: () => void;
  resume: () => void;
  /**
   * Stops recording; resolves once the final `dataavailable` has fired (so a
   * consumer collecting chunks via `onChunk` has the complete set). Does not
   * return a Blob — assembling one would mean holding the whole recording in
   * memory, the exact thing the timeslice avoids.
   */
  stop: () => Promise<void>;
  state: () => RecorderState;
}

export interface CreateRecorderOptions {
  stream: MediaStream;
  /** Fired once per `dataavailable` — the per-chunk seam TASK-12 writes to disk. */
  onChunk: (chunk: Blob) => void;
  /** Optional surfacing of MediaRecorder errors (fail loud, never swallow). */
  onError?: (error: Error) => void;
}

/**
 * Build a MediaRecorder around `stream`. Throws synchronously if the browser
 * can't record VP9/Opus WebM — we fail loud rather than silently fall back to a
 * codec Gemini or the report pipeline doesn't expect (ARCHITECTURE §Error
 * handling: "fail loud").
 */
export function createRecorder({
  stream,
  onChunk,
  onError,
}: CreateRecorderOptions): RecorderHandle {
  if (!MediaRecorder.isTypeSupported(VELLUM_MIME)) {
    throw new Error(`MediaRecorder cannot record "${VELLUM_MIME}" in this browser`);
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: VELLUM_MIME,
    videoBitsPerSecond: VELLUM_VIDEO_BITS_PER_SECOND,
  });

  recorder.addEventListener("dataavailable", (event) => {
    // The final chunk on stop() can be empty; don't forward zero-byte blobs.
    if (event.data.size > 0) onChunk(event.data);
  });

  recorder.addEventListener("error", (event) => {
    // MediaRecorderErrorEvent.error is the underlying DOMException.
    const err = (event as unknown as { error?: DOMException }).error;
    onError?.(err ?? new Error("MediaRecorder error"));
  });

  return {
    start: () => recorder.start(VELLUM_TIMESLICE_MS),
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    stop: () =>
      new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      }),
    state: () => recorder.state,
  };
}
