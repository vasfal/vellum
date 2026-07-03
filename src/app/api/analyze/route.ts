import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uploadVideo, UploadError } from "@/lib/gemini/upload";
import { analyze, AnalyzeError } from "@/lib/gemini/analyze";
import { analyzeLong } from "@/lib/gemini/analyze-long";
import { maxSegmentBytes } from "@/lib/ffmpeg/segment-video";
import { extractScreenshots } from "@/lib/ffmpeg/extract-screenshots";
import {
  ANALYSIS_LANGUAGES,
  ANALYSIS_MODES,
  AnalysisResultSchema,
  mmssToSec,
  type AnalysisLanguage,
  type AnalysisMode,
  type AnalysisResult,
} from "@/lib/gemini/schema";
import { StoredAnalysisResultSchema, type StoredVellumTask } from "@/lib/gemini/stored";
import type { VellumTask } from "@/lib/gemini/schema";
import { CommentSchema } from "@/lib/comments/comment";
import {
  buildReviseVideoContext,
  type ReviseSource,
} from "@/lib/gemini/prompts/revise-tasks";
import { z } from "zod";

/**
 * POST /api/analyze — the stateless bridge between the browser workspace and the
 * Node pipeline (ADR-014, ARCHITECTURE §Data flow steps 5–9).
 *
 * The browser holds the recording only through a File-System-Access directory
 * handle, which never exposes an absolute path to JS or the server. So the
 * client POSTs the recording BYTES; this route writes them to a throwaway temp
 * file, runs the SAME Phase 1 pipeline the CLI does — uploadVideo → analyze
 * (analyzeLong for files over the segment budget) → extractScreenshots — and
 * streams progress + the validated AnalysisResult + the screenshot PNGs back.
 *
 * It mirrors scripts/cli.ts's orchestration MINUS every write to a session
 * folder: nothing is persisted server-side. The browser owns writing report.md,
 * tasks.json, and screenshots/ into the workspace (a browser-side writeReport).
 * The temp file is always discarded — on success AND on failure (AC#4, #5).
 *
 * Wire format: NDJSON — one JSON object per line, "\n"-separated — over a
 * streaming Response. HTTP status stays 200 even on a pipeline failure; the
 * failure rides as a terminal {"type":"error"} event so a partial stream is
 * still well-formed (ARCHITECTURE §Error handling: fail loud, structured).
 */
export const runtime = "nodejs";

/** ffmpeg + the Gemini SDK need Node APIs — never the edge runtime. */
type StreamEvent =
  | {
      type: "progress";
      phase: "upload" | "analyzing" | "extracting" | "writing";
      /** upload may carry a percentage; extracting carries n-of-m. Both optional. */
      pct?: number;
      n?: number;
      m?: number;
    }
  | {
      type: "done";
      result: AnalysisResult;
      /** Parallel to result.tasks, same order (one PNG per screenshot_timestamp). */
      screenshots: { name: string; base64: string }[];
    }
  | { type: "error"; kind: string; message: string };

export async function POST(req: Request): Promise<Response> {
  const ext = resolveExt(req);
  const mimeType = mimeTypeForExt(ext);
  // TASK-46 — cost mode from ?mode=; defaults to "thorough" so an old client
  // (or the local CLI) that never sends it keeps the two-pass behavior. Only
  // "economy" switches to the single-pass path; anything else falls back safely.
  const mode = resolveMode(req);
  // TASK-49 — output language from ?lang=; defaults to "en" so an old client
  // (or the local CLI) that never sends it keeps the English-only behavior
  // (ADR-006). Only "uk" switches on the Ukrainian normalization.
  const language = resolveLanguage(req);
  // TASK-50 — an optional PRIMARY model override from ?model=. undefined (no
  // query) keeps the built-in MODEL, so an old client (or the local CLI) that
  // never sends it runs byte-identical. NOT validated against a model list on
  // purpose: a dead/unknown model fails loud in runStructured, which is the
  // acceptable, honest failure (the picker in TASK-47 only offers live models).
  const model = resolveModel(req);
  // req.signal aborts when the client cancels (TASK-42) — the browser aborts the
  // fetch, which disconnects here. We check it between stages so a Cancel stops
  // the pipeline (no wasted ffmpeg/Gemini work) and always reaches the temp
  // cleanup in finally, instead of running to completion after the client left.
  const { signal } = req;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: StreamEvent): void => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      // Created lazily so a failure before mkdtemp still hits the finally with
      // nothing to clean; once set, the whole dir (temp video + screenshots) is
      // removed regardless of how we exit (AC#4).
      let tmpDir: string | undefined;
      try {
        // Read the recording bytes and, for a re-run-with-video (TASK-60), the
        // optional revise payload. A plain analysis posts the raw bytes (the
        // historical path); a revise posts multipart (video + { priorResult,
        // comments }) so the payload isn't header-size-bounded. Redundant I/O
        // either way — the bytes already sit on disk in the workspace — but there
        // is no path to hand the server (ADR-014), so we re-materialize them.
        const { bytes, reviseContext } = await readBody(req);
        signal.throwIfAborted();
        tmpDir = await mkdtemp(path.join(tmpdir(), "vellum-analyze-"));
        const videoPath = path.join(tmpDir, `recording${ext}`);
        await writeFile(videoPath, bytes);

        const result = await runAnalysis(
          videoPath,
          mimeType,
          mode,
          language,
          model,
          reviseContext,
          emit,
          signal,
        );
        // TASK-60 — stamp the run's origin so the Details tab labels a video revise
        // apart from a fresh analysis. run is pipeline-assembled telemetry (never a
        // Gemini field), so overriding it here doesn't touch the model contract.
        if (reviseContext && result.run) result.run.origin = "revise-video";

        // Screenshots: one ffmpeg pass per task so progress is a real N/M
        // counter, mirroring cli.ts. extractScreenshots already produces the
        // ADR-013 "frame-MM-SS.png" names — keep them, the browser reuses them
        // verbatim when it writes screenshots/ into the workspace. Read each PNG
        // back immediately (before the next pass can overwrite a same-second
        // name) and base64 it; the array stays parallel to result.tasks.
        const screenshotsDir = path.join(tmpDir, "screenshots");
        const screenshots: { name: string; base64: string }[] = [];
        for (let i = 0; i < result.tasks.length; i += 1) {
          // Bail before each ffmpeg pass so a Cancel stops the extract loop
          // promptly rather than grinding through every remaining frame.
          signal.throwIfAborted();
          const sec = mmssToSec(result.tasks[i].screenshot_timestamp);
          const [shotPath] = await extractScreenshots(videoPath, [sec], screenshotsDir);
          const png = await readFile(shotPath);
          screenshots.push({ name: path.basename(shotPath), base64: png.toString("base64") });
          emit({ type: "progress", phase: "extracting", n: i + 1, m: result.tasks.length });
        }

        signal.throwIfAborted();
        // The server writes nothing, but the client still needs the "wrapping
        // up" beat before the terminal event — it maps to the browser-side
        // writeReport that follows (ADR-014).
        emit({ type: "progress", phase: "writing" });
        emit({ type: "done", result, screenshots });
      } catch (err) {
        // A client Cancel (aborted signal) is not a failure to report — the
        // browser already tore down its stream reader; just fall through to the
        // finally so the temp dir is cleaned. Any other error is structured, not
        // a raw 500: the typed stage errors carry user-facing guidance (a
        // missing/invalid GEMINI_API_KEY becomes a hint, not a trace). HTTP is
        // already 200; the failure is the payload.
        if (!signal.aborted) {
          // Log server-side too — the failure is otherwise only in the stream
          // payload, invisible in the dev server console (the route stays 200).
          console.error("[analyze] pipeline error:", err);
          emit({ type: "error", ...toStreamError(err) });
        }
      } finally {
        if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}

/**
 * Stages 1–2, routed by file size exactly like cli.ts: a recording over the
 * per-segment byte budget goes through analyzeLong (which does its own
 * per-segment upload + analyze + timestamp remap); everything else takes the
 * single uploadVideo → analyze path. Both return the same AnalysisResult shape,
 * so the caller is identical downstream (AC#3).
 *
 * Progress is best-effort around opaque calls (uploadVideo/analyze expose no
 * fine-grained callbacks): we emit the phase boundaries the client needs to
 * drive its UI — upload → analyzing — in a consistent order for both paths.
 */
async function runAnalysis(
  videoPath: string,
  mimeType: string,
  mode: AnalysisMode,
  language: AnalysisLanguage,
  // TASK-50 — the chosen PRIMARY model (or undefined for the built-in MODEL),
  // threaded into both the short and long analysis paths.
  model: string | undefined,
  // TASK-60 — the re-run-with-video revise context (prior tasks + comments), or
  // undefined for a plain analysis. Woven into the analysis prompt(s).
  reviseContext: string | undefined,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  const { size } = await stat(videoPath);

  emit({ type: "progress", phase: "upload" });
  if (size > maxSegmentBytes()) {
    // analyzeLong uploads + analyzes each segment behind its boundary; we can't
    // interleave finer phases through it, so we mark the whole pass "analyzing".
    // Its segments are always re-encoded to WebM, so it needs no mimeType. It
    // does NOT yet forward the abort signal into its per-segment Gemini calls
    // (follow-up); the boundary checks in POST still short-circuit around it.
    emit({ type: "progress", phase: "analyzing" });
    return analyzeLong(videoPath, mode, language, model, reviseContext);
  }

  const { fileUri } = await uploadVideo(videoPath);
  signal.throwIfAborted();
  emit({ type: "progress", phase: "analyzing" });
  // Thread the real container mimeType so an imported mp4 is described to Gemini
  // as mp4, not webm (S13); webm callers pass "video/webm" and are unchanged.
  // The signal reaches the in-flight generateContent so a Cancel tears it down.
  return analyze(fileUri, mimeType, signal, mode, language, model, reviseContext);
}

/**
 * Read the POST body: raw video bytes for a plain analysis, or a multipart form
 * (video + revise JSON) for a re-run-with-video (TASK-60). The revise JSON carries
 * the prior analysis + the reviewer's comments, which become the reviseContext
 * woven into the analysis prompt. A malformed revise part fails loud (AnalyzeError-
 * shaped via the caller's toStreamError) rather than silently analyzing plain.
 */
async function readBody(
  req: Request,
): Promise<{ bytes: Buffer; reviseContext: string | undefined }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { bytes: Buffer.from(await req.arrayBuffer()), reviseContext: undefined };
  }

  const form = await req.formData();
  const video = form.get("video");
  if (!(video instanceof Blob)) {
    throw new Error("Revise request is missing its 'video' part.");
  }
  const bytes = Buffer.from(await video.arrayBuffer());

  const reviseRaw = form.get("revise");
  if (typeof reviseRaw !== "string") {
    // Multipart with no revise part — treat as a plain analysis of the video.
    return { bytes, reviseContext: undefined };
  }
  const { source, comments } = parseRevisePart(reviseRaw);
  return { bytes, reviseContext: buildReviseVideoContext(source, comments) };
}

/** The shape of the multipart "revise" field (mirrors /api/revise's body). */
const RevisePartSchema = z.object({
  result: z.union([StoredAnalysisResultSchema, AnalysisResultSchema]),
  comments: z.array(CommentSchema),
});

/** Parse + validate the revise JSON into a prompt source + comments. */
function parseRevisePart(raw: string): {
  source: ReviseSource;
  comments: z.infer<typeof CommentSchema>[];
} {
  const parsed = RevisePartSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid revise payload: ${parsed.error.message}`);
  }
  const rawTasks: (StoredVellumTask | VellumTask)[] = parsed.data.result.tasks;
  const tasks: StoredVellumTask[] = rawTasks.map((task, i) =>
    "id" in task ? task : { ...task, id: `t${i + 1}`, origin: "ai" },
  );
  return {
    source: {
      overview: parsed.data.result.overview,
      review_type: parsed.data.result.review_type,
      tasks,
    },
    comments: parsed.data.comments,
  };
}

/**
 * Map a thrown error to the structured stream event. The typed stage errors
 * carry actionable messages verbatim (UploadError's missing_api_key message is
 * a step-by-step hint, not a stack); anything else is an unexpected internal
 * fault whose message we surface without a trace.
 */
function toStreamError(err: unknown): { kind: string; message: string } {
  if (err instanceof UploadError) return { kind: "upload", message: err.message };
  if (err instanceof AnalyzeError) return { kind: "analyze", message: err.message };
  return {
    kind: "internal",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * The temp file needs a real extension: uploadVideo validates it (.webm/.mp4)
 * and ffmpeg infers the container from it. The browser records WebM (ADR-003),
 * so that is the default; an explicit `?ext=` (from the client, which knows the
 * source name) or a video Content-Type can override it. A leading dot is
 * optional in the query value.
 */
function resolveExt(req: Request): string {
  const raw = new URL(req.url).searchParams.get("ext");
  if (raw) return raw.startsWith(".") ? raw : `.${raw}`;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("webm")) return ".webm";
  return ".webm";
}

/**
 * The container mimeType Gemini needs for the uploaded file (analyze threads it
 * into createPartFromUri). Mirrors mimeForRecordingExt on the browser side; the
 * two halves share a wire format, not a module (ADR-014). Anything other than
 * mp4 defaults to webm, matching resolveExt's default.
 */
function mimeTypeForExt(ext: string): string {
  return ext === ".mp4" ? "video/mp4" : "video/webm";
}

/**
 * The cost mode from ?mode= (TASK-46). Validated against ANALYSIS_MODES so a
 * missing, empty, or unknown value falls back to "thorough" — the safe default
 * (never silently downgrade quality on a malformed request).
 */
function resolveMode(req: Request): AnalysisMode {
  const raw = new URL(req.url).searchParams.get("mode");
  return ANALYSIS_MODES.includes(raw as AnalysisMode) ? (raw as AnalysisMode) : "thorough";
}

/**
 * The output language from ?lang= (TASK-49). Validated against ANALYSIS_LANGUAGES
 * so a missing, empty, or unknown value falls back to "en" — the safe default
 * that keeps the historical English-only behavior (ADR-006). Only "uk" turns on
 * the Ukrainian normalization instruction in the prompts.
 */
function resolveLanguage(req: Request): AnalysisLanguage {
  const raw = new URL(req.url).searchParams.get("lang");
  return ANALYSIS_LANGUAGES.includes(raw as AnalysisLanguage) ? (raw as AnalysisLanguage) : "en";
}

/**
 * The chosen PRIMARY model from ?model= (TASK-50), or undefined when absent —
 * which the pipeline treats as the built-in MODEL, so behavior is unchanged
 * until TASK-47's picker sends a choice. Deliberately NOT validated against the
 * live model list: /api/models only ever offers real models, and a stale/dead
 * choice fails loud in runStructured (the accepted, honest failure). We only
 * trim/empty-guard so a bare "?model=" doesn't select an empty-string model.
 */
function resolveModel(req: Request): string | undefined {
  const raw = new URL(req.url).searchParams.get("model")?.trim();
  return raw ? raw : undefined;
}
