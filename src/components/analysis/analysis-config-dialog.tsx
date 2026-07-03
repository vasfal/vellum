"use client";

// TASK-47 — the pre-analysis config screen. Vasyl's locked decision: ALWAYS ASK.
// Every analysis (record auto-analyze, import, re-analyze) opens this screen
// before the run starts, so the user picks the MODEL, the MODE (Thorough/Economy,
// TASK-46) and the output LANGUAGE (English/Ukrainian, TASK-49) each time. The
// chosen values thread into runAnalyze via the app-level controller.
//
// The dialog is rendered from AnalysisProvider (app shell), so it works over any
// trigger and on top of the session view. It owns only the config UI + the model
// fetch; the actual run lives in the provider (beginRun).
//
// Cost stance (task): the exact cost is NOT knowable before the upload (tokens
// are unknown until Gemini has seen the video). So we show only the per-1M RATES
// and the relative cost of each mode — never a fabricated total. The real number
// lands in the info tab after the run (TASK-48).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronsUpDown, Info, TriangleAlert, Wallet } from "lucide-react";
import { Select } from "@base-ui/react/select";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { findRecording } from "@/lib/filesystem/recording-file";
import { cn } from "@/lib/utils";
import type { AnalysisLanguage, AnalysisMode } from "@/lib/gemini/schema";
// `import type` is fully erased at compile, so pulling this shape from the route
// module never drags its node:fs/pricing dependencies into the client bundle
// (mirrors run-analyze's hand-mirrored wire contract, but here it's type-only).
import type { ModelInfo, ModelsResponse } from "@/app/api/models/route";

/** The user's pre-analysis choices, threaded into runAnalyze by the provider. */
export interface AnalysisConfig {
  model: string;
  mode: AnalysisMode;
  language: AnalysisLanguage;
}

/**
 * Which flow opened this dialog (TASK-61). Every model call — a fresh analysis
 * and both revise actions — goes through the SAME config gate so the flow is
 * consistent (always ask model/language before spending on a call). The variant
 * only tunes which controls show, the labels, and the cost basis:
 *
 *   • "analyze"      — a fresh analysis: model + mode + language, full-video cost.
 *   • "revise-video" — re-run WITH video (full analyze pipeline + comments): same
 *                       full config as analyze; cost is full-video.
 *   • "revise-text"  — a single TEXT-only revise (/api/revise, no upload): model +
 *                       language only. Mode is HIDDEN — it governs multi-pass video
 *                       analysis and does nothing for one text call; cost is the
 *                       (much cheaper) text-only basis.
 */
export type AnalysisConfigVariant = "analyze" | "revise-text" | "revise-video";

interface VariantMeta {
  title: string;
  description: string;
  cta: string;
  /** Mode only applies to the multi-pass video pipeline — hidden for text revise. */
  showMode: boolean;
  /** How the estimated cost is computed: from the video's duration, or a fixed
   *  text-only token budget (no upload). */
  costKind: "video" | "text";
}

const VARIANT_META: Record<AnalysisConfigVariant, VariantMeta> = {
  analyze: {
    title: "Analysis settings",
    description: "Choose how this session is analyzed.",
    cta: "Start analysis",
    showMode: true,
    costKind: "video",
  },
  "revise-video": {
    title: "Re-run with video",
    description:
      "Re-analyze the recording with your comments — fresh screenshots included.",
    cta: "Re-run with video",
    showMode: true,
    costKind: "video",
  },
  "revise-text": {
    title: "Process comments",
    description:
      "Send the current tasks and your comments to the model for a text-only revision — no video, much cheaper.",
    cta: "Process comments",
    showMode: false,
    costKind: "text",
  },
};

/**
 * Degraded model set when GET /api/models fails (no key / network / upstream).
 * Keeps analysis possible rather than blocking — mirrors the route's RECOMMENDED
 * allowlist and pricing.ts's DEFAULT_PRICING (the `below` tier for tiered pro).
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", recommended: true, preview: false, inputPrice: 1.25, outputPrice: 10.0 },
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash", recommended: true, preview: false, inputPrice: 0.3, outputPrice: 2.5 },
  { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", recommended: true, preview: false, inputPrice: 0.1, outputPrice: 0.4 },
];

/** The recommended default when nothing is remembered (the priciest = best). */
const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_CONFIG: AnalysisConfig = {
  model: DEFAULT_MODEL,
  mode: "thorough",
  language: "en",
};

const LANGUAGES: { value: AnalysisLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "uk", label: "Ukrainian" },
];

const STORAGE_KEY = "vellum:analysis-config";

/** Read the last-used config from localStorage, falling back per-field so a
 *  partial/old blob can't produce an invalid selection. Never throws. */
function readStoredConfig(): AnalysisConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    // Loosely-typed persisted blob (our own writes); validated field-by-field
    // below, so a stale/hand-edited value degrades to the default, not a crash.
    const parsed = JSON.parse(raw) as Partial<AnalysisConfig>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_MODEL,
      mode: parsed.mode === "economy" ? "economy" : "thorough",
      language: parsed.language === "uk" ? "uk" : "en",
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function writeStoredConfig(config: AnalysisConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // A full/blocked localStorage must never stop an analysis — just don't remember.
  }
}

/** "$1.25 / $10 per 1M" when both prices are known, else "price n/a". */
function priceLabel(model: ModelInfo): string {
  if (model.inputPrice === undefined || model.outputPrice === undefined) {
    return "price n/a";
  }
  return `$${model.inputPrice} / $${model.outputPrice} per 1M`;
}

/** Recommended first, then by price DESC (pricier = more capable, so pro → flash
 *  → flash-lite); unknown-priced models last; ties broken by display name. */
function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const pa = a.inputPrice ?? -1; // unknown price sorts last
    const pb = b.inputPrice ?? -1;
    if (pa !== pb) return pb - pa;
    return a.displayName.localeCompare(b.displayName);
  });
}

// ── Cost estimate (TASK-47 refinement) ──────────────────────────────────────
// The video's duration is knowable before the run (the file is on disk), so we
// can ROUGHLY estimate the cost from duration × Gemini's token rates × passes ×
// the chosen model's price — far more useful than "cost after the run". It's an
// estimate, not the invoice: the real figure still lands in the info tab after
// the run (TASK-48). Marked "~approx" in the UI.
//
// Token rates: Gemini bills video at the DEFAULT media_resolution — 258 tok per
// sampled frame at 1 fps + 32 tok/s of audio ≈ 290 input tokens/s of video
// (ai.google.dev/gemini-api/docs/tokens). Constants are deliberately rough; the
// small task-list prompt + generated output are a rounding error against the
// video input, so precision there isn't worth chasing.
const VIDEO_INPUT_TOKENS_PER_SEC = 290; // 258/frame @1fps video + 32/s audio
const PROMPT_OVERHEAD_TOKENS = 600; // system + task-list prompt, per pass
const OUTPUT_TOKENS_PER_PASS = 4000; // generated report/tasks, per pass (rough)

/** The pre-run cost estimate in one of its states (loading → priced/degraded). */
type CostEstimateState =
  | { state: "loading" } // still measuring the video's duration
  | { state: "unavailable" } // no recording, or the duration couldn't be read
  | { state: "no-price"; passes: number; totalTokens: number } // model price n/a
  | { state: "ready"; cost: number; passes: number; totalTokens: number };

/** Thorough re-sends the whole video for a second pass (TASK-46); Basic sends it
 *  once. Passes scale both the video input and the per-pass overhead. */
function passesForMode(mode: AnalysisMode): number {
  return mode === "thorough" ? 2 : 1;
}

/**
 * Estimate the cost of analyzing a `durationSec`-long video with `model` in
 * `mode`. Returns a degraded "no-price" result (tokens only) when the model's
 * rates are unknown — never a fabricated $0. `durationSec === null` means the
 * duration couldn't be measured, so we can't estimate at all.
 */
function estimateCost(
  durationSec: number | null,
  model: ModelInfo | undefined,
  mode: AnalysisMode,
): CostEstimateState {
  if (durationSec === null || model === undefined) return { state: "unavailable" };

  const passes = passesForMode(mode);
  const inputTokens = Math.round(
    durationSec * VIDEO_INPUT_TOKENS_PER_SEC * passes + PROMPT_OVERHEAD_TOKENS * passes,
  );
  const outputTokens = OUTPUT_TOKENS_PER_PASS * passes;
  const totalTokens = inputTokens + outputTokens;

  if (model.inputPrice === undefined || model.outputPrice === undefined) {
    return { state: "no-price", passes, totalTokens };
  }
  const cost =
    (inputTokens / 1e6) * model.inputPrice + (outputTokens / 1e6) * model.outputPrice;
  return { state: "ready", cost, passes, totalTokens };
}

// ── Text-only revise cost (TASK-61) ─────────────────────────────────────────
// A "Process comments" revise is a SINGLE text call: it sends the current tasks +
// comments (no video upload) and gets back a revised result. So the cost basis is
// just that text payload's tokens × the model's price — no duration, no passes,
// far cheaper than a video run. The input tokens are measured by the caller from
// the actual payload (chars/4); we default to a rough budget if none is given.
const TEXT_REVISE_OUTPUT_TOKENS = 4000; // the revised report/tasks, one call
const TEXT_REVISE_DEFAULT_INPUT_TOKENS = 2000; // fallback when the caller omits it

/**
 * Estimate the cost of a single text-only revise call: `inputTokens` (the current
 * tasks + comments) + a fixed output budget, priced by `model`. Degrades to
 * "no-price" when the model's rates are unknown — never a fabricated $0.
 */
function estimateTextReviseCost(
  inputTokens: number,
  model: ModelInfo | undefined,
): CostEstimateState {
  if (model === undefined) return { state: "unavailable" };
  const outputTokens = TEXT_REVISE_OUTPUT_TOKENS;
  const totalTokens = inputTokens + outputTokens;
  if (model.inputPrice === undefined || model.outputPrice === undefined) {
    return { state: "no-price", passes: 1, totalTokens };
  }
  const cost =
    (inputTokens / 1e6) * model.inputPrice + (outputTokens / 1e6) * model.outputPrice;
  return { state: "ready", cost, passes: 1, totalTokens };
}

/** Compact token count for the estimate line: 183_200 → "183K", 1_240_000 → "1.2M". */
function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return `${n}`;
}

/**
 * Measure a video File's duration (seconds) via a throwaway <video> element.
 *
 * WebM from MediaRecorder usually ships NO duration in its header, so
 * `video.duration` reads Infinity/NaN after loadedmetadata. The fix is the
 * standard seek trick: jump to an absurd time so the browser scans to the real
 * end, then read `duration` off the durationchange/seeked event. MP4 imports
 * report duration immediately, so they resolve on loadedmetadata.
 *
 * Resolves null (never rejects) on decode error or a stall — the caller then
 * keeps the "cost after the run" fallback. A safety timeout covers environments
 * that won't decode WebM at all (e.g. headless/automated Chrome).
 */
function measureVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;

    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeAttribute("src");
      video.load(); // release the decoder
      URL.revokeObjectURL(url);
      resolve(value);
    };

    // A finite, positive duration is the answer; Infinity/NaN means "not in the
    // header yet" → keep waiting for the seek trick below to surface it.
    const readDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) finish(video.duration);
    };

    const timer = window.setTimeout(() => finish(null), 5000);

    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        finish(video.duration);
        return;
      }
      // Force the browser to scan to the end so the real duration lands.
      video.currentTime = 1e101;
    };
    video.ondurationchange = readDuration;
    video.onseeked = readDuration;
    video.onerror = () => finish(null);

    video.src = url;
  });
}

interface AnalysisConfigDialogProps {
  /** The session about to be analyzed, or null when the dialog is closed. */
  sessionName: string | null;
  /** Confirmed the config — the caller starts the run with these values. */
  onStart: (config: AnalysisConfig) => void;
  /** Dismissed without starting — nothing is written. */
  onClose: () => void;
  /** Which flow opened the dialog (TASK-61). Defaults to the full analyze config. */
  variant?: AnalysisConfigVariant;
  /** Seed the initial selections (e.g. the session's last run) OVER the remembered
   *  localStorage config, applied per provided field when the dialog opens. Used by
   *  the revise flows so the picker defaults to the run being revised. */
  defaults?: Partial<AnalysisConfig>;
  /** Text-only revise cost basis: rough input token count of the current tasks +
   *  comments payload (no video). Only read by the "revise-text" variant. */
  textInputTokens?: number;
}

export function AnalysisConfigDialog({
  sessionName,
  onStart,
  onClose,
  variant = "analyze",
  defaults,
  textInputTokens,
}: AnalysisConfigDialogProps) {
  const open = sessionName !== null;
  const meta = VARIANT_META[variant];

  // The workspace root — used to find the session's recording and measure its
  // duration for the cost estimate (the dialog is client-side, mounted inside
  // the ready workspace tree by AnalysisProvider).
  const { handle } = useWorkspace();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  // True when the live list couldn't load and we fell back to the built-in set.
  const [degraded, setDegraded] = useState(false);

  // The measured video duration (seconds) for the cost estimate. null once
  // resolved-but-unmeasurable (no recording / decode failed) → fallback line.
  const [durationSec, setDurationSec] = useState<number | null>(null);
  const [durationLoading, setDurationLoading] = useState(false);

  // Prefilled from the last run (Vasyl's "remember the choice"), but the screen
  // is still shown every time — "always ask".
  const [config, setConfig] = useState<AnalysisConfig>(readStoredConfig);

  // Latest `defaults` (recreated each render), read only inside the open-effect so
  // it doesn't re-run on every render — seeded once when the dialog opens.
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  // When the dialog opens, seed the caller's defaults (the run being revised) over
  // the remembered config, per provided field. A no-op for the analyze variant
  // (no defaults) — its "remember the last choice" behavior is unchanged.
  useEffect(() => {
    if (!open) return;
    const d = defaultsRef.current;
    if (!d) return;
    setConfig((prev) => ({
      model: d.model ?? prev.model,
      mode: d.mode ?? prev.mode,
      language: d.language ?? prev.language,
    }));
  }, [open]);

  // Fetch the live model list each time the dialog opens (a fresh key may have
  // been added since last time). On failure, degrade to the built-in set so the
  // analysis is never blocked (task).
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setDegraded(false);

    void (async () => {
      let list: ModelInfo[];
      let failed = false;
      try {
        const res = await fetch("/api/models");
        const body = (await res.json()) as ModelsResponse;
        if (!res.ok || "error" in body) throw new Error("models unavailable");
        list = body.models.length > 0 ? body.models : FALLBACK_MODELS;
      } catch {
        list = FALLBACK_MODELS;
        failed = true;
      }
      if (cancelled) return;
      const sorted = sortModels(list);
      setModels(sorted);
      setDegraded(failed);
      setLoading(false);
      // Reconcile the remembered model against what's actually offered: keep it
      // if present, otherwise fall to the default (or the first offered).
      setConfig((prev) => {
        if (sorted.some((m) => m.id === prev.model)) return prev;
        const fallback =
          sorted.find((m) => m.id === DEFAULT_MODEL)?.id ??
          sorted[0]?.id ??
          DEFAULT_MODEL;
        return { ...prev, model: fallback };
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // Measure the session's recording duration once per open, so the cost estimate
  // has a length to work from. Cached for the dialog's lifetime — changing the
  // model/mode recomputes the price from this duration without re-probing. A
  // missing recording or an unreadable duration leaves durationSec null → the
  // estimate degrades to the "cost after the run" fallback (never blocks).
  useEffect(() => {
    // The text-only revise doesn't upload the video, so its cost is duration-
    // independent — skip the probe entirely for that variant.
    if (!open || sessionName === null || meta.costKind === "text") return;

    let cancelled = false;
    setDurationSec(null);
    setDurationLoading(true);

    void (async () => {
      let seconds: number | null = null;
      try {
        const sessionDir = await handle.getDirectoryHandle(sessionName);
        const match = await findRecording(sessionDir);
        if (match) {
          const file = await match.handle.getFile();
          if (!cancelled) seconds = await measureVideoDuration(file);
        }
      } catch {
        // No recording, permission hiccup, decode failure — all degrade to the
        // fallback line rather than surfacing an error on the config screen.
        seconds = null;
      }
      if (cancelled) return;
      setDurationSec(seconds);
      setDurationLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, sessionName, handle]);

  // The estimate recomputes on model/mode change (and once the duration lands),
  // but never re-probes — duration is cached in state above. The text-only revise
  // (no video) prices a fixed text-payload token budget instead of the duration.
  const estimate: CostEstimateState = useMemo(() => {
    const model = models.find((m) => m.id === config.model);
    if (meta.costKind === "text") {
      return estimateTextReviseCost(
        textInputTokens ?? TEXT_REVISE_DEFAULT_INPUT_TOKENS,
        model,
      );
    }
    if (durationLoading) return { state: "loading" };
    return estimateCost(durationSec, model, config.mode);
  }, [
    meta.costKind,
    textInputTokens,
    durationLoading,
    durationSec,
    models,
    config.model,
    config.mode,
  ]);

  const handleStart = useCallback(() => {
    writeStoredConfig(config);
    onStart(config);
  }, [config, onStart]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{meta.title}</DialogTitle>
          <DialogDescription>
            {variant === "analyze" ? (
              <>
                Choose how {sessionName ? `“${sessionName}”` : "this session"} is
                analyzed.
              </>
            ) : (
              meta.description
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* ── Model ─────────────────────────────────────────────────── */}
          <Field label="Model">
            {degraded && (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <TriangleAlert className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
                Couldn’t load the live model list — showing the built-in set.
              </p>
            )}
            {loading ? (
              <div className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                Loading models…
              </div>
            ) : (
              <ModelSelect
                models={models}
                value={config.model}
                onChange={(id) => setConfig((prev) => ({ ...prev, model: id }))}
              />
            )}
          </Field>

          {/* ── Mode ──────────────────────────────────────────────────────
              Hidden for the text-only revise: mode governs multi-pass VIDEO
              analysis and does nothing for a single text call (TASK-61). */}
          {meta.showMode && (
            <Field label="Mode">
              <OptionRow
                selected={config.mode === "thorough"}
                onSelect={() => setConfig((prev) => ({ ...prev, mode: "thorough" }))}
                title="Thorough"
                hint="Two passes — most complete, priciest."
              />
              <OptionRow
                selected={config.mode === "economy"}
                onSelect={() => setConfig((prev) => ({ ...prev, mode: "economy" }))}
                title="Basic"
                hint="Single pass — roughly half the cost."
              />
            </Field>
          )}

          {/* ── Language ──────────────────────────────────────────────── */}
          <Field label="Language">
            {/* Two options only → horizontal pills rather than stacked rows. */}
            <div className="flex gap-1.5">
              {LANGUAGES.map(({ value, label }) => {
                const selected = config.language === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setConfig((prev) => ({ ...prev, language: value }))
                    }
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors active:translate-y-px",
                      selected
                        ? "border-foreground/10 bg-muted"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    {label}
                    {selected && (
                      <Check className="size-3.5 shrink-0" strokeWidth={1.75} />
                    )}
                  </button>
                );
              })}
            </div>
          </Field>

          {/* ── Estimated cost (TASK-47 refinement) ─────────────────────
              Rough pre-run estimate from the video's duration × token rates ×
              passes × the chosen model's price. Recomputes on model/mode change.
              Falls back to "after the run" when the duration can't be read. */}
          <CostEstimate estimate={estimate} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={loading}>
            {meta.cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled group: a small caption over a stack of option rows. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/**
 * The pre-run cost estimate, as a subtle monochrome summary row (ADR-004). Shows
 * "~$X · N passes · ~M tokens" when priced; "estimating…" while the duration
 * loads; "n/a" when the model's rates are unknown; and the plain "after the run"
 * fallback when the duration couldn't be measured. The "~" and the info tooltip
 * signal that this is an approximation, not the invoice.
 */
function CostEstimate({ estimate }: { estimate: CostEstimateState }) {
  // Unmeasurable duration → keep the honest original statement, full width.
  if (estimate.state === "unavailable") {
    return (
      <p className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        Cost depends on the video — you’ll see the exact figure after the run.
      </p>
    );
  }

  const value =
    estimate.state === "loading"
      ? "estimating…"
      : estimate.state === "no-price"
        ? "n/a"
        : `~$${estimate.cost.toFixed(2)}`;

  const detail =
    estimate.state === "ready" || estimate.state === "no-price"
      ? `${estimate.passes} ${estimate.passes === 1 ? "pass" : "passes"} · ~${formatTokens(estimate.totalTokens)} tokens`
      : null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Wallet className="size-3.5 shrink-0" strokeWidth={1.5} />
        Estimated cost
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className="inline-flex cursor-help text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Info className="size-3.5" strokeWidth={1.5} />
          </TooltipTrigger>
          <TooltipContent className="max-w-56">
            Approximate — from the video’s duration × Gemini’s token rates. The
            exact figure lands after the run.
          </TooltipContent>
        </Tooltip>
      </span>
      <span className="flex items-baseline gap-2 text-right">
        <span className="font-mono text-sm text-foreground">{value}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </span>
    </div>
  );
}

/** A monochrome selectable row (radio semantics): title + optional badges/hint,
 *  a check on the selected one. Hierarchy comes from contrast, not color (ADR-004). */
function OptionRow({
  selected,
  onSelect,
  title,
  badges,
  hint,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  badges?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
        "active:translate-y-px",
        selected
          ? "border-foreground/10 bg-muted"
          : "border-border hover:bg-muted/50",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Check
        className={cn(
          "size-4 shrink-0 transition-opacity",
          selected ? "opacity-100" : "opacity-0",
        )}
        strokeWidth={1.75}
      />
    </button>
  );
}

/**
 * The three model sections, in offer order. Empty sections are hidden. The
 * first two carry an info tooltip explaining what the grouping means; "All"
 * (everything neither recommended nor preview) needs no explanation.
 */
const MODEL_GROUPS: {
  key: string;
  label: string;
  tip: string | null;
  match: (m: ModelInfo) => boolean;
}[] = [
  {
    key: "recommended",
    label: "Recommended",
    tip: "Live-verified for video analysis — the best quality-for-cost picks.",
    match: (m) => m.recommended,
  },
  {
    key: "preview",
    label: "Preview",
    tip: "Newer or experimental models — may change or be less reliable.",
    match: (m) => m.preview && !m.recommended,
  },
  {
    key: "all",
    label: "All",
    tip: null,
    match: (m) => !m.recommended && !m.preview,
  },
];

/**
 * The model picker: a Base UI Select grouped into Recommended / Preview / All
 * (ADR-004 monochrome, Linear density). The trigger shows the chosen model +
 * its per-1M rate; the popup lists the offered models by section, hides empty
 * sections, and marks the selected one with a Check. `value` is the model id
 * (config.model), so the provider's remember/reconcile logic is untouched.
 */
function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <Select.Trigger
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-transparent px-3 py-2 text-left text-sm transition-colors",
          "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:translate-y-px",
        )}
      >
        <Select.Value className="flex min-w-0 items-center gap-2">
          {(current: string) => {
            const m = models.find((x) => x.id === current);
            if (!m) {
              return (
                <span className="text-muted-foreground">Select a model…</span>
              );
            }
            return (
              <>
                <span className="truncate font-medium">{m.displayName}</span>
                <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">
                  {priceLabel(m)}
                </span>
              </>
            );
          }}
        </Select.Value>
        <Select.Icon>
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.5}
          />
        </Select.Icon>
      </Select.Trigger>

      <Select.Portal>
        <Select.Positioner
          side="bottom"
          sideOffset={6}
          align="start"
          alignItemWithTrigger={false}
          className="z-50"
        >
          <Select.Popup
            className={cn(
              "max-h-64 w-(--anchor-width) min-w-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none",
              "origin-(--transform-origin) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            <Select.List>
              {MODEL_GROUPS.map((group) => {
                const offered = models.filter(group.match);
                if (offered.length === 0) return null;
                return (
                  <Select.Group
                    key={group.key}
                    className="py-1 first:pt-0 last:pb-0"
                  >
                    <Select.GroupLabel className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
                      {group.label}
                      {group.tip && <GroupTip text={group.tip} />}
                    </Select.GroupLabel>
                    {offered.map((m) => (
                      <Select.Item
                        key={m.id}
                        value={m.id}
                        className={cn(
                          "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors",
                          "data-highlighted:bg-muted",
                        )}
                      >
                        <Select.ItemText className="truncate">
                          {m.displayName}
                        </Select.ItemText>
                        <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-muted-foreground">
                          {priceLabel(m)}
                        </span>
                        <span className="flex w-4 shrink-0 justify-center">
                          <Select.ItemIndicator>
                            <Check className="size-4" strokeWidth={1.75} />
                          </Select.ItemIndicator>
                        </span>
                      </Select.Item>
                    ))}
                  </Select.Group>
                );
              })}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** The info icon + hover tooltip beside a section label inside the select popup.
 *  stopPropagation keeps a pointer on the icon from reaching the Select's list
 *  (so hovering "why?" never highlights or picks an item). */
function GroupTip({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-flex cursor-help text-muted-foreground/70 transition-colors hover:text-foreground"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <Info className="size-3.5" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent className="max-w-56">{text}</TooltipContent>
    </Tooltip>
  );
}
