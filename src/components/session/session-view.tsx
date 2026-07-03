"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Braces,
  Check,
  Copy,
  Download,
  Eye,
  FileText,
  FileVideo,
  ListChecks,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Wand,
  X,
} from "lucide-react";
import { Menu } from "@base-ui/react/menu";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnalysis } from "@/components/analysis/analysis-provider";
import {
  AnalysisConfigDialog,
  type AnalysisConfig,
} from "@/components/analysis/analysis-config-dialog";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import {
  loadArchivedRun,
  loadSessionData,
  type ArchivedRunData,
  type SessionData,
} from "@/lib/filesystem/session-data";
import {
  loadRunHistory,
  type RunHistoryEntry,
} from "@/lib/filesystem/run-history";
import { writeNameSidecar, writeOverrideName } from "@/lib/filesystem/session-name";
import {
  readAiBaseline,
  saveSessionEdits,
} from "@/lib/filesystem/write-edits-browser";
import { readComments, writeComments } from "@/lib/filesystem/comments-browser";
import { downloadTextFile } from "@/lib/filesystem/download";
import { mintCommentId, type Comment } from "@/lib/comments/comment";
import { AnalyzeFlowError, runAnalyze } from "@/lib/analyze/run-analyze";
import { runRevise } from "@/lib/analyze/run-revise";
import {
  kebabCase,
  mmssToSec,
  type AnalysisRun,
  type ReviewType,
} from "@/lib/gemini/schema";
import {
  mintTaskId,
  type StoredAnalysisResult,
  type StoredVellumTask,
} from "@/lib/gemini/stored";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { FadeText } from "@/components/fade-text";
import { PageHeader } from "@/components/page-header";
import { AnalyzeStatus, type AnalyzeState } from "./analyze-action";
import { EditMarker, InlineTextarea } from "./inline-edit";
import {
  CommentComposer,
  CommentableText,
  CommentsPanel,
  taskCardDomId,
  useCommentSelection,
  type PendingAnchor,
} from "./comment-mode";
import { ReportView } from "./report-view";
import { TaskListItem } from "./task-list-item";

// TASK-17 — the session view. Loads one session's tasks.json + recording.webm
// through the live workspace handle (TASK-15) and lays out a sticky video player
// beside a dense, scrollable, clickable task list.
//
// Layout: left column = player + overview (pinned so it survives the list
// scroll); right column = the task list, scrolling independently. Dark/monochrome
// on the TASK-2 tokens (ADR-004).
//
// TASK-18 adds the interaction across the two panes: a shared videoRef lets a
// task-row click seek the player (to where it was discussed) and a screenshot
// click seek to where it's visible; each row shows its extracted frame; an
// incomplete session (ADR-008) gets a header badge instead of crashing.

/** review_type → human label. UI-only display; the enum lives in the schema. */
const REVIEW_TYPE_LABELS: Record<ReviewType, string> = {
  ui_design: "UI Design",
  dev_vs_design: "Dev vs Design",
  documentation: "Documentation",
  mixed: "Mixed",
  other: "Other",
};

// TASK-51 — which analysis run the view is showing. null = the latest run
// (tasks.json), the default. Otherwise an ADR-009 archive: its tasks filename
// (`tasks-<stamp>.json`) plus the time it ran, for the "viewing an earlier run"
// banner. Selecting a run is READ-ONLY — it never triggers a re-analysis.
interface SelectedRun {
  source: string;
  sortMs: number;
}

// Download kebab — the archive stamp inside a run's tasks filename ("tasks-<stamp>.json"
// → "<stamp>"), used to disambiguate a downloaded archive's filename from the
// latest's. Returns null for the live "tasks.json" (no stamp) or an unrecognized
// source, so the caller falls back to the un-stamped name.
function archiveStampFromSource(source: string | undefined): string | null {
  if (!source) return null;
  const m = /^tasks-(.+)\.json$/.exec(source);
  return m ? m[1] : null;
}

// TASK-34 — the right pane (tasks / markdown) is user-resizable via a drag handle
// between the columns. Width in px, clamped so neither pane collapses, and
// persisted per browser.
const RIGHT_PANE_KEY = "vellum:session-right-pane-width";
const RIGHT_PANE_DEFAULT = 460;
const RIGHT_PANE_MIN = 340;
const RIGHT_PANE_MAX = 820;
const clampRightWidth = (w: number) =>
  Math.max(RIGHT_PANE_MIN, Math.min(RIGHT_PANE_MAX, w));

// Next remounts the session page on a route-param change (/session/a ->
// /session/b), so SessionView's local state resets to null on every navigation —
// which is why a "keep previous data" flag in useState alone still flashed the
// skeleton for a frame. This module-level cache survives the remount: the
// last-loaded data per session (instant, correct revisits) plus the most-recent
// of all (so the FIRST visit to a not-yet-cached session keeps the OUTGOING one
// on screen instead of blanking). File handles in SessionData are lazy, so a few
// cached entries cost little; cap them to stay honest about memory.
const SESSION_CACHE_MAX = 8;
const sessionDataCache = new Map<string, SessionData>();
let mostRecentSessionData: SessionData | null = null;

function cacheSessionData(name: string, data: SessionData) {
  sessionDataCache.delete(name); // re-insert so it's the most-recently-used key
  sessionDataCache.set(name, data);
  if (sessionDataCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionDataCache.keys().next().value;
    if (oldest !== undefined) sessionDataCache.delete(oldest);
  }
  mostRecentSessionData = data;
}

// TASK-61 — does the LIVE run carry manual edits not present in its AI baseline?
// True only when a tasks.ai.json baseline exists (an edit already happened) AND
// the current draft still differs from it: the overview changed, a task was
// added / removed / reordered, or any editable field diverged. Reverting every
// change back to the AI value collapses it to false again (matches the per-field
// markers). Returns false with no baseline (a pristine AI run) or no draft
// (nothing loaded / an archived run is being viewed) — so it never falsely flags.
function isLiveEdited(
  draft: StoredAnalysisResult | null,
  baseline: StoredAnalysisResult | null,
): boolean {
  if (!draft || !baseline) return false;
  if (draft.overview !== baseline.overview) return true;
  if (draft.tasks.length !== baseline.tasks.length) return true;
  const baseById = new Map(baseline.tasks.map((t) => [t.id, t]));
  for (let i = 0; i < draft.tasks.length; i++) {
    const t = draft.tasks[i];
    // A different id at this position = reorder, or a human-added task (no entry).
    if (baseline.tasks[i]?.id !== t.id) return true;
    const b = baseById.get(t.id);
    if (!b) return true;
    if (
      t.title !== b.title ||
      t.description !== b.description ||
      t.screen_context !== b.screen_context ||
      t.category !== b.category ||
      t.priority !== b.priority
    ) {
      return true;
    }
  }
  return false;
}

export function SessionView({ name }: { name: string }) {
  const { handle, refreshSessions } = useWorkspace();
  const router = useRouter();
  // Seed from the module cache so a remount (Next's per-route-param behavior)
  // starts with the cached session — or, on a first visit, the outgoing one — so
  // there's no null frame and no skeleton flash. The effect below always reloads
  // in the background to revalidate whatever was seeded.
  const [data, setData] = useState<SessionData | null>(
    () => sessionDataCache.get(name) ?? mostRecentSessionData,
  );
  // Bumped on a manual rename so the view reloads with the fresh displayName.
  const [reloadNonce, setReloadNonce] = useState(0);
  // The Cancel-analysis confirmation (TASK-42).
  const [cancelOpen, setCancelOpen] = useState(false);
  // TASK-51 — the archived run being viewed, or null for the latest (default).
  const [selectedRun, setSelectedRun] = useState<SelectedRun | null>(null);

  // Analysis lives in the app-level controller (TASK-42), so it survives
  // navigating between sessions. Read this session's slice of it.
  const { analysis, analyze, cancelAnalyze, errors, completions } = useAnalysis();
  const myAnalysis = analysis?.name === name ? analysis : null;
  // Another session is being analyzed — block starting a second run here (AC#3).
  const otherAnalyzing = analysis !== null && analysis.name !== name;
  // Bumped by the controller each time a run for THIS session completes; drives
  // the in-place reload below (replaces the old onDone → reloadNonce path).
  const completedCount = completions[name] ?? 0;
  const myError = errors[name] ?? null;

  const startAnalyze = useCallback(() => analyze(name), [analyze, name]);
  const confirmCancel = useCallback(() => {
    cancelAnalyze();
    setCancelOpen(false);
  }, [cancelAnalyze]);

  // Project the controller's per-session state into the shape the progress strip
  // and buttons render from: a live run wins, else a retained error, else idle.
  const analyzeState: AnalyzeState = myAnalysis
    ? {
        status: "running",
        progress: { phase: myAnalysis.phase, n: myAnalysis.n, m: myAnalysis.m },
      }
    : myError
      ? { status: "error", kind: myError.kind, message: myError.message }
      : { status: "idle" };

  // Load once per (workspace, session name). Re-runs on a manual rename
  // (reloadNonce) and whenever an analysis run for THIS session completes
  // (completedCount) — so the view reloads in place with the freshly-written
  // tasks.json / recording / screenshots.
  useEffect(() => {
    let cancelled = false;
    loadSessionData(handle, name)
      .then((next) => {
        // Swap the kept data only once the new session has loaded — the old body
        // stays on screen until this lands, so there's no skeleton flash. Cache
        // it so a remount / revisit seeds from it instead of blanking.
        if (!cancelled) {
          cacheSessionData(name, next);
          setData(next);
        }
      })
      .catch(() => {
        // loadSessionData already maps expected failures to a status; a throw
        // here is genuinely unexpected. Fail visibly rather than hang on loading.
        if (!cancelled) setData({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [handle, name, reloadNonce, completedCount]);

  // The skeleton shows ONLY when there is nothing to keep on screen — i.e. the
  // first-ever load, before the module cache has anything. Once any session has
  // loaded, `data` is always seeded (cache/most-recent), so navigation keeps the
  // previous body up until the new one lands — no skeleton, however slow the read.
  const showSkeleton = data === null;

  // TASK-51 — snap back to the latest run when the session changes or a new run
  // finishes (completedCount). A just-finished run becomes the newest, so keeping
  // an older one selected would be confusing; the latest is always the default.
  useEffect(() => {
    setSelectedRun(null);
  }, [name, completedCount]);

  // Analyze a readable session (re-analyze once it has tasks) OR an un-analyzed
  // one (a fresh recording/import — its first analysis).
  const done = data;
  const ok = done?.status === "ok" ? done : null;
  const canAnalyze = ok !== null || done?.status === "unanalyzed";

  // The effective display name (TASK-22), resolved by loadSessionData. Falls back
  // to the folder name while loading or for a not-found/error state.
  let displayName = name;
  if (done?.status === "ok" || done?.status === "unanalyzed") {
    displayName = done.displayName;
  }

  // AC#5 — manual rename: persist the override into name.txt, then reload the
  // view (fresh displayName) and re-scan the sidebar. name.txt is separate from
  // tasks.json, so a later re-analysis never overwrites the user's chosen name.
  const onRename = useCallback(
    async (next: string) => {
      const dir = await handle.getDirectoryHandle(name);
      await writeOverrideName(dir, next);
      // TASK-43 — refresh the Finder sidecar to the new name (drops the stale one).
      // Best-effort and never throws, so the rename stands even if the disk write
      // of the breadcrumb fails.
      await writeNameSidecar(dir, next);
      setReloadNonce((n) => n + 1);
      refreshSessions();
    },
    [handle, name, refreshSessions],
  );

  // TASK-19 AC#2 — delete the whole session folder (recording + report +
  // screenshots) from the workspace, then re-scan the sidebar and leave this
  // now-gone view. A folder already removed (NotFoundError) is not an error —
  // we still refresh and navigate away rather than crash.
  const onDelete = useCallback(async () => {
    try {
      await handle.removeEntry(name, { recursive: true });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
    }
    refreshSessions();
    router.push("/");
  }, [handle, name, refreshSessions, router]);

  return (
    // h-full (not h-svh): fill the floating inset panel, which is already
    // viewport-bounded — h-svh would overshoot the panel's bottom margin.
    <div className="flex h-full min-h-0 flex-col">
      <Header
        displayName={displayName}
        folderId={name}
        canRename={canAnalyze}
        onRename={onRename}
        canDelete={canAnalyze}
        onDelete={onDelete}
        data={done}
        analyze={analyzeState}
        canAnalyze={canAnalyze}
        hasAnalysis={ok?.analysis != null}
        onAnalyze={startAnalyze}
        otherAnalyzing={otherAnalyzing}
      />
      <AnalyzeStatus
        state={analyzeState}
        onRetry={startAnalyze}
        onCancel={() => setCancelOpen(true)}
      />
      <Body
        data={done}
        showSkeleton={showSkeleton}
        analyze={analyzeState}
        onAnalyze={startAnalyze}
        otherAnalyzing={otherAnalyzing}
        workspace={handle}
        name={name}
        reloadKey={`${reloadNonce}:${completedCount}`}
        selectedRun={selectedRun}
        onSelectRun={setSelectedRun}
        otherAnalysisActive={analysis !== null}
        onRunReplaced={() => {
          // A revise wrote a new run: snap to the latest, reload in place, and
          // re-scan the sidebar (TASK-60), exactly like an analysis completion.
          setSelectedRun(null);
          setReloadNonce((n) => n + 1);
          refreshSessions();
        }}
      />

      {/* Cancel-analysis confirmation (TASK-42). Nothing is written until the run
          succeeds, so confirming leaves the session exactly as it was. */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel analysis?</DialogTitle>
            <DialogDescription>
              This stops the current run. Nothing is saved — the session stays
              unchanged and you can analyze it again later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Keep analyzing
            </DialogClose>
            <Button variant="destructive" onClick={confirmCancel}>
              <X strokeWidth={1.5} />
              Cancel analysis
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Header({
  displayName,
  folderId,
  canRename,
  onRename,
  canDelete,
  onDelete,
  data,
  analyze,
  canAnalyze,
  hasAnalysis,
  onAnalyze,
  otherAnalyzing,
}: {
  displayName: string;
  /** The on-disk folder name (a timestamp; the stable identity + URL slug). */
  folderId: string;
  canRename: boolean;
  onRename: (next: string) => Promise<void>;
  canDelete: boolean;
  onDelete: () => Promise<void>;
  data: SessionData | null;
  analyze: AnalyzeState;
  canAnalyze: boolean;
  hasAnalysis: boolean;
  onAnalyze: () => void;
  /** A run on another session is active — block starting one here (AC#3). */
  otherAnalyzing: boolean;
}) {
  const ok = data?.status === "ok" ? data : null;

  return (
    // Same PageHeader shell as every other screen; the editable title is passed
    // as a custom title node, badges + the actions menu as trailing children.
    <PageHeader
      title={
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <SessionTitle
            displayName={displayName}
            canRename={canRename}
            onRename={onRename}
          />
        </div>
      }
    >
      <FolderId name={folderId} />
      {ok?.incomplete && <IncompleteBadge />}
      {ok?.analysis?.review_type && (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {REVIEW_TYPE_LABELS[ok.analysis.review_type]}
        </span>
      )}
      {(canAnalyze || canDelete) && (
        <MoreActions
          analyze={analyze}
          hasAnalysis={hasAnalysis}
          onAnalyze={onAnalyze}
          canAnalyze={canAnalyze}
          canDelete={canDelete}
          displayName={displayName}
          onDelete={onDelete}
          otherAnalyzing={otherAnalyzing}
        />
      )}
    </PageHeader>
  );
}

// TASK-34 follow-up — the session's Re-analyze + Delete actions collapsed into a
// single "more actions" kebab menu (Base UI Menu) in the header. Delete opens the
// same destructive confirm dialog as before; deletion navigates away so the view
// unmounts (no need to close the dialog on success). A failure re-enables it.
function MoreActions({
  analyze,
  hasAnalysis,
  onAnalyze,
  canAnalyze,
  canDelete,
  displayName,
  onDelete,
  otherAnalyzing,
}: {
  analyze: AnalyzeState;
  hasAnalysis: boolean;
  onAnalyze: () => void;
  canAnalyze: boolean;
  canDelete: boolean;
  displayName: string;
  onDelete: () => Promise<void>;
  otherAnalyzing: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const running = analyze.status === "running";
  // Block starting a run here while THIS session runs or another one does (AC#3).
  const analyzeBlocked = running || otherAnalyzing;
  const AnalyzeIcon = running ? Loader2 : hasAnalysis ? RefreshCw : Wand;

  const confirm = useCallback(async () => {
    setDeleting(true);
    try {
      await onDelete();
    } catch {
      // Deletion failed unexpectedly — keep the dialog open so the user can
      // retry or cancel rather than silently swallowing the error.
      setDeleting(false);
    }
  }, [onDelete]);

  return (
    <>
      <Menu.Root>
        <Tooltip>
          <TooltipTrigger
            render={
              <Menu.Trigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="More actions"
                  />
                }
              >
                <MoreHorizontal strokeWidth={1.5} />
              </Menu.Trigger>
            }
          />
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className="min-w-40 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none [&_svg]:size-4 [&_svg]:shrink-0">
              {canAnalyze && (
                <Menu.Item
                  onClick={onAnalyze}
                  disabled={analyzeBlocked}
                  className="flex cursor-default select-none flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
                >
                  <span className="flex items-center gap-2">
                    <AnalyzeIcon
                      className={running ? "animate-spin" : undefined}
                      strokeWidth={1.5}
                    />
                    {hasAnalysis ? "Re-analyze" : "Analyze"}
                  </span>
                  {otherAnalyzing && !running && (
                    <span className="pl-6 text-[11px] text-muted-foreground">
                      Another analysis is running
                    </span>
                  )}
                </Menu.Item>
              )}
              {canDelete && (
                <Menu.Item
                  onClick={() => setConfirmOpen(true)}
                  className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10"
                >
                  <Trash2 strokeWidth={1.5} />
                  Delete
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{displayName}”?</DialogTitle>
          <DialogDescription>
            This removes the recording, report and screenshots. Can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={deleting} />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? (
              <Loader2 className="animate-spin" strokeWidth={1.5} />
            ) : (
              <Trash2 strokeWidth={1.5} />
            )}
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

// The right-pane download kebab. Mirrors the session header's
// MoreActions kebab EXACTLY (Base UI Menu, a ghost icon-sm MoreHorizontal button,
// the same popup styling) so the two read as one vocabulary. Two items, scoped to
// the CURRENTLY-VIEWED run: save its report Markdown (activeReportFile's bytes) or
// its tasks as pretty JSON (the active StoredAnalysisResult — the live draft with
// autosaved edits, or an archive's parsed analysis). Each item disables when its
// source is absent (a report-less or malformed run) — the kebab still renders and
// nothing crashes. Downloads go through the browser (Blob + throwaway <a>), NOT a
// File System Access write, so no permission or directory handle is required.
function DownloadMenu({
  reportFile,
  analysis,
  workspace,
  name,
  displayName,
  stamp,
}: {
  /** The active run's report filename (report.md / report-<stamp>.md), or null. */
  reportFile: string | null;
  /** The active run's parsed analysis (live draft or an archive), or null. */
  analysis: StoredAnalysisResult | null;
  workspace: FileSystemDirectoryHandle;
  name: string;
  displayName: string;
  /** An archived run's stamp for filename disambiguation; null for the latest. */
  stamp: string | null;
}) {
  // Filesystem-safe stem from the session display name (kebab slug), plus the
  // archive stamp when viewing an older run so its files don't collide with the
  // latest's. kebabCase returns undefined for a name with no usable chars — fall
  // back to a neutral stem so we always produce a valid filename.
  const slug = kebabCase(displayName) ?? "session";
  const base = stamp ? `${slug}-${stamp}` : slug;

  const saveMd = useCallback(async () => {
    if (!reportFile) return;
    try {
      const dir = await workspace.getDirectoryHandle(name);
      const handle = await dir.getFileHandle(reportFile);
      const text = await (await handle.getFile()).text();
      downloadTextFile(`${base}.md`, text, "text/markdown");
    } catch {
      // Best-effort: a read failure (the file vanished mid-session) is a silent
      // no-op rather than a crash — the kebab and the view stay usable.
    }
  }, [reportFile, workspace, name, base]);

  const saveJson = useCallback(() => {
    if (!analysis) return;
    downloadTextFile(
      `${base}.json`,
      JSON.stringify(analysis, null, 2),
      "application/json",
    );
  }, [analysis, base]);

  return (
    <Menu.Root>
      <Tooltip>
        <TooltipTrigger
          render={
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Download"
                />
              }
            >
              <Download strokeWidth={1.5} />
            </Menu.Trigger>
          }
        />
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none [&_svg]:size-4 [&_svg]:shrink-0">
            <Menu.Item
              onClick={saveMd}
              disabled={reportFile === null}
              className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
            >
              <FileText strokeWidth={1.5} />
              Save as MD
            </Menu.Item>
            <Menu.Item
              onClick={saveJson}
              disabled={analysis === null}
              className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent"
            >
              <Braces strokeWidth={1.5} />
              Save as JSON
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// The session title, inline-editable (TASK-22 AC#5). Click to rename; Enter or
// blur commits, Escape cancels, an empty/unchanged value keeps the current name.
// The rename writes name.txt (an override that survives re-analysis) — the folder
// itself is never renamed. A non-renameable state (loading / not-found) is a plain
// heading. Monochrome, thin Lucide pencil revealed on hover (ADR-004/005).
function SessionTitle({
  displayName,
  canRename,
  onRename,
}: {
  displayName: string;
  canRename: boolean;
  onRename: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(displayName);
  const [saving, setSaving] = useState(false);

  // Seed the draft from the CURRENT resolved name each time we enter edit mode, so
  // it always reflects a fresh suggested_name / prior rename without a sync effect.
  const startEditing = useCallback(() => {
    setValue(displayName);
    setEditing(true);
  }, [displayName]);

  const commit = useCallback(async () => {
    const next = value.trim();
    setEditing(false);
    if (!next || next === displayName) return; // empty/unchanged → keep current name
    setSaving(true);
    try {
      await onRename(next);
    } catch {
      // Write failed — the view keeps showing the current (unchanged) name.
    } finally {
      setSaving(false);
    }
  }, [value, displayName, onRename]);

  const cancel = useCallback(() => setEditing(false), []);

  if (!canRename) {
    return (
      <FadeText className="min-w-0 text-[15px] font-medium tracking-tight">
        {displayName}
      </FadeText>
    );
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        disabled={saving}
        aria-label="Rename session"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        className="min-w-0 flex-1 truncate rounded-sm border border-border bg-transparent px-1.5 py-0.5 text-[15px] font-medium tracking-tight outline-none focus:border-foreground/30"
      />
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={startEditing}
            className="group flex min-w-0 items-center gap-1.5 text-left active:opacity-80"
          />
        }
      >
        <span className="min-w-0 truncate text-[15px] font-medium tracking-tight">{displayName}</span>
        <Pencil
          className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100"
          strokeWidth={1.5}
        />
      </TooltipTrigger>
      <TooltipContent>Rename session</TooltipContent>
    </Tooltip>
  );
}

// TASK-43 — surface the on-disk folder name (a timestamp; ADR-017 never renames
// it) so the user can map app-name <-> Finder folder, and copy it in one click.
// Deliberately quiet: mono + muted (ADR-004), the folder id truncates, and the
// copy glyph only appears on hover. Click copies to the clipboard and flips to a
// check for a moment. Clipboard access is best-effort (a blocked clipboard is a
// silent no-op — this is a convenience, never load-bearing).
function FolderId({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
    } catch {
      // Clipboard unavailable/blocked — nothing to do; the id is still visible.
    }
  }, [name]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={copy}
            aria-label="Copy folder name"
            className="group hidden min-w-0 shrink items-center gap-1 font-mono text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground active:opacity-80 sm:flex"
          />
        }
      >
        {copied ? (
          <Check className="size-3 shrink-0" strokeWidth={1.5} />
        ) : (
          <Copy
            className="size-3 shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100"
            strokeWidth={1.5}
          />
        )}
        <span className="min-w-0 max-w-[18ch] truncate tabular-nums">{name}</span>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy folder name"}</TooltipContent>
    </Tooltip>
  );
}

// Session-view echo of the sidebar's IncompleteBadge (session-list.tsx): the
// marker is present but recording.webm or report.md is missing (ADR-008). Thin
// outlined pill — hierarchy from contrast, not hue (ADR-004).
function IncompleteBadge() {
  return (
    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Incomplete
    </span>
  );
}

// TASK-51 — load an archived run's tasks for read-only viewing. Idle while the
// latest run is shown (source null); loads on demand when an archive is picked.
// A read/parse failure degrades to a malformed run rather than crashing — the
// banner + Back-to-latest stay usable.
type ArchivedRunLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; data: ArchivedRunData };

function useArchivedRun(
  workspace: FileSystemDirectoryHandle,
  name: string,
  source: string | null,
): ArchivedRunLoad {
  const [load, setLoad] = useState<ArchivedRunLoad>({ status: "idle" });

  useEffect(() => {
    if (!source) {
      setLoad({ status: "idle" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    loadArchivedRun(workspace, name, source)
      .then((data) => {
        if (!cancelled) setLoad({ status: "done", data });
      })
      .catch(() => {
        if (!cancelled) {
          setLoad({
            status: "done",
            data: {
              analysis: null,
              malformed: true,
              reportFile: null,
              // No stamp resolved on failure → fall back to the live folder; a
              // missing frame still degrades to "no preview" (ADR-013).
              screenshotsDir: "screenshots",
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, name, source]);

  return load;
}

function Body({
  data,
  showSkeleton,
  analyze,
  onAnalyze,
  otherAnalyzing,
  workspace,
  name,
  reloadKey,
  selectedRun,
  onSelectRun,
  otherAnalysisActive,
  onRunReplaced,
}: {
  data: SessionData | null;
  /** The kept-previous-data skeleton gate: true only on first load or a slow
   *  reload, so a fast session swap never flashes the skeleton (Body decides). */
  showSkeleton: boolean;
  analyze: AnalyzeState;
  onAnalyze: () => void;
  otherAnalyzing: boolean;
  // The live workspace handle + session folder, threaded to the Markdown view so
  // it can read report.md + screenshots on demand (TASK-34).
  workspace: FileSystemDirectoryHandle;
  name: string;
  // Bumped whenever the view reloads (rename / analysis-complete) so the Info
  // tab's run-history reader re-reads and surfaces a freshly-written run (TASK-48).
  reloadKey: string;
  // TASK-51 — the archived run being viewed (null = latest) + the setter, so the
  // Info tab can switch runs and the body can render the selected one.
  selectedRun: SelectedRun | null;
  onSelectRun: (run: SelectedRun | null) => void;
  // TASK-60 — an analysis run (in the app-level controller) is active anywhere;
  // block starting a revise while one is (one AI action at a time).
  otherAnalysisActive: boolean;
  // TASK-60 — a revise wrote a new run; ask the parent to reload the view + sidebar.
  onRunReplaced: () => void;
}) {
  // The player lives in the left column; a task click in the right column seeks
  // it. A shared ref is the seam between the two panes (TASK-18). Declared
  // unconditionally so hooks order is stable across load states.
  const videoRef = useRef<HTMLVideoElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  // A task click both selects and seeks; a manual scrub should DESELECT (the
  // highlighted task no longer matches the playhead). We tell the two apart with
  // a flag set right before our own seek and consumed by the seeking handler.
  const programmaticSeek = useRef(false);

  // TASK-51 — when an older run is selected, load its tasks (from the ADR-009
  // archive) to render in place of the latest. Idle for the latest run.
  const archived = useArchivedRun(workspace, name, selectedRun?.source ?? null);
  // Row indices don't carry across runs OR sessions, so drop the selection when
  // the run switches or the session changes (the highlighted task no longer means
  // anything in the new list). The `name` reset matters now that keep-previous
  // data keeps this component mounted across navigation instead of remounting it.
  useEffect(() => {
    setSelected(null);
  }, [selectedRun?.source, name]);

  const seekTo = useCallback((mmss: string | undefined) => {
    const video = videoRef.current;
    // No recording (incomplete session) or no timestamp (a human task with no
    // moment — ADR-024) → nothing to seek.
    if (!video || !mmss) return;
    const target = mmssToSec(mmss);
    if (video.currentTime === target) return; // no change → no seeking event
    programmaticSeek.current = true;
    video.currentTime = target;
  }, []);

  const onVideoSeeking = useCallback(() => {
    if (programmaticSeek.current) {
      programmaticSeek.current = false; // our own seek — keep the selection
      return;
    }
    setSelected(null); // user scrubbed the player → drop the row highlight
  }, []);

  // Resizable right pane (TASK-34). rightWidthRef mirrors the state so the
  // pointerup handler can persist the final width without re-binding listeners.
  const mainRef = useRef<HTMLElement>(null);
  const [rightWidth, setRightWidth] = useState(RIGHT_PANE_DEFAULT);
  const rightWidthRef = useRef(rightWidth);
  // Mirror the width into a ref via an effect (not during render) so the
  // pointerup handler can read the final value without re-binding listeners.
  useEffect(() => {
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);

  useEffect(() => {
    const saved = Number(localStorage.getItem(RIGHT_PANE_KEY));
    if (saved) setRightWidth(clampRightWidth(saved));
  }, []);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const rect = mainRef.current?.getBoundingClientRect();
      if (rect) setRightWidth(clampRightWidth(rect.right - ev.clientX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(RIGHT_PANE_KEY, String(rightWidthRef.current));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // ---- TASK-57 (ADR-024): Edit-mode state ----------------------------------
  // Editing only ever touches the LIVE run (an archive is read-only). The live
  // analysis is the source we seed the editable draft from.
  const liveAnalysis = data?.status === "ok" ? data.analysis : null;
  const viewingArchiveEarly = selectedRun !== null;
  const canEdit = !viewingArchiveEarly && liveAnalysis !== null;

  // The View/Edit/Comment mode lives here (not in RightColumn) because Edit mode
  // also drives the left pane's overview editor. Reset to View whenever editing
  // isn't allowed (an archived/malformed run) so a mode can't leak into read-only.
  const [mode, setMode] = useState<SessionMode>("view");
  useEffect(() => {
    if (!canEdit) setMode("view");
  }, [canEdit]);
  const editing = canEdit && mode === "edit";

  // The working copy of the analysis. Seeded from the live run and re-seeded when
  // the session reloads (rename / re-analysis mints a fresh liveAnalysis object).
  // After a manual save we do NOT reload, so this draft — not the stale on-disk
  // read — is the source the live task list + overview render from.
  const [draft, setDraft] = useState<StoredAnalysisResult | null>(liveAnalysis);
  useEffect(() => {
    setDraft(liveAnalysis);
  }, [liveAnalysis]);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // The immutable AI baseline of the current run (tasks.ai.json), for the "edited"
  // markers + revert. Null until the first edit creates it — then re-read on each
  // save (savedNonce) so markers appear once the baseline exists.
  const [baseline, setBaseline] = useState<StoredAnalysisResult | null>(null);
  // Bumped after every successful save. Drives (a) the baseline re-read above and
  // (b) the Markdown pane reload so report.md on disk and the list never drift.
  const [savedNonce, setSavedNonce] = useState(0);

  useEffect(() => {
    if (!canEdit) {
      setBaseline(null);
      return;
    }
    let cancelled = false;
    workspace
      .getDirectoryHandle(name)
      .then((dir) => readAiBaseline(dir))
      .then((b) => {
        if (!cancelled) setBaseline(b);
      })
      .catch(() => {
        // No baseline is a valid state (nothing edited yet) — degrade to no
        // markers rather than crashing.
        if (!cancelled) setBaseline(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit, workspace, name, savedNonce]);

  const baselineById = useMemo(() => {
    const map = new Map<string, StoredVellumTask>();
    baseline?.tasks.forEach((t) => map.set(t.id, t));
    return map;
  }, [baseline]);

  // TASK-61 — whether the live run has manual edits diverging from its AI baseline,
  // for the quiet "Edited" indicator on the live run row in Details. Recomputed as
  // the draft is edited or the baseline is (re-)read after a save.
  const liveEdited = useMemo(() => isLiveEdited(draft, baseline), [draft, baseline]);

  // Serialize saves so rapid field commits can't race: chain each write after the
  // in-flight one, then persist that snapshot. Each commit is discrete (blur /
  // Enter), so this writes the tasks in order and disk ends at the last edit. A
  // failed write is swallowed (best-effort, mirrors the inline-rename path) so the
  // chain stays alive; the in-memory draft is unaffected.
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const persist = useCallback(
    (next: StoredAnalysisResult) => {
      saveChain.current = saveChain.current
        .catch(() => {})
        .then(async () => {
          const dir = await workspace.getDirectoryHandle(name);
          await saveSessionEdits(dir, next, name);
          setSavedNonce((n) => n + 1);
        });
    },
    [workspace, name],
  );

  // Field edits: compute the next draft from the latest value (draftRef, not the
  // render-time closure), set it, and persist. Done in the event handler (not a
  // setState updater) so it isn't double-invoked under StrictMode.
  const updateTask = useCallback(
    (index: number, patch: Partial<StoredVellumTask>) => {
      const cur = draftRef.current;
      if (!cur) return;
      const next: StoredAnalysisResult = {
        ...cur,
        tasks: cur.tasks.map((t, i) => (i === index ? { ...t, ...patch } : t)),
      };
      setDraft(next);
      persist(next);
    },
    [persist],
  );

  const updateOverview = useCallback(
    (overview: string) => {
      const cur = draftRef.current;
      if (!cur) return;
      const next: StoredAnalysisResult = { ...cur, overview };
      setDraft(next);
      persist(next);
    },
    [persist],
  );

  // ---- TASK-58 (ADR-024): structural edits — add / delete / reorder ---------
  // All three mutate the draft array and persist through the SAME non-archiving
  // saveSessionEdits (via persist) — never writeReportBrowser — so they update
  // tasks.json + report.md in place and NEVER create an archived run (AC#5). The
  // savedNonce bump inside persist re-reads report.md so the Markdown pane tracks
  // the new list/order; the task list renders straight off `draft`.

  // Add a blank human task at the end (origin "human", a collision-free id). Its
  // fields are seeded to schema-valid defaults (title/description are .min(1) in
  // the stored schema) that the user then edits with the TASK-57 inline editors.
  // timestamp/screenshot_timestamp/screen_context/screenshot are omitted (relaxed
  // optionals) — a human task with no frame renders without an image ("no
  // preview") and carries no AI baseline (so no revert-to-AI marker). Select it so
  // it's obvious which card just appeared.
  const addTask = useCallback(() => {
    const cur = draftRef.current;
    if (!cur) return;
    const newTask: StoredVellumTask = {
      id: mintTaskId(cur.tasks),
      origin: "human",
      title: "New task",
      description: "Add a description.",
      category: "idea",
      priority: "med",
    };
    const next: StoredAnalysisResult = { ...cur, tasks: [...cur.tasks, newTask] };
    setDraft(next);
    persist(next);
    setSelected(next.tasks.length - 1);
  }, [persist]);

  // Delete a task by index (confirmed in the card). The orphaned screenshots/*.png
  // is left unreferenced on disk — harmless, not pruned in v1.1 (ADR-025). Keep the
  // selection coherent: drop it if the removed row was selected, shift it left if a
  // row before it went away.
  const deleteTask = useCallback(
    (index: number) => {
      const cur = draftRef.current;
      if (!cur) return;
      const next: StoredAnalysisResult = {
        ...cur,
        tasks: cur.tasks.filter((_, i) => i !== index),
      };
      setDraft(next);
      persist(next);
      setSelected((sel) => {
        if (sel === null) return null;
        if (sel === index) return null;
        return sel > index ? sel - 1 : sel;
      });
    },
    [persist],
  );

  // Reorder via up/down: swap a task with its neighbour (dependency-free — no dnd
  // library; the list is short and up/down stays keyboard-accessible). Array order
  // = display order = report.md order. Each task keeps its own `screenshot`
  // filename, so frames stay correct after the move (ADR-025). Selection follows
  // the swap so the highlight stays on the same task.
  const moveTask = useCallback(
    (index: number, dir: -1 | 1) => {
      const cur = draftRef.current;
      if (!cur) return;
      const target = index + dir;
      if (target < 0 || target >= cur.tasks.length) return;
      const tasks = [...cur.tasks];
      [tasks[index], tasks[target]] = [tasks[target], tasks[index]];
      const next: StoredAnalysisResult = { ...cur, tasks };
      setDraft(next);
      persist(next);
      setSelected((sel) => {
        if (sel === index) return target;
        if (sel === target) return index;
        return sel;
      });
    },
    [persist],
  );

  // ---- TASK-59 (ADR-024): Comment-mode state -------------------------------
  // Comments are a SEPARATE sidecar (comments.json) — Comment mode never touches
  // tasks.json / report.md (all writes below go through writeComments only). Loaded
  // once per session on the live run; re-read on reload (rename / re-analysis).
  const commenting = canEdit && mode === "comment";
  const [comments, setComments] = useState<Comment[]>([]);
  const commentsRef = useRef(comments);
  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    if (!canEdit) {
      setComments([]);
      return;
    }
    let cancelled = false;
    workspace
      .getDirectoryHandle(name)
      .then((dir) => readComments(dir))
      .then((cs) => {
        if (!cancelled) setComments(cs);
      })
      .catch(() => {
        // A missing/unreadable comments.json is a valid "no comments" state.
        if (!cancelled) setComments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canEdit, workspace, name, reloadKey]);

  // Serialize comment writes exactly like the edit save chain, so rapid add/edit/
  // delete can't race. Writes ONLY comments.json — never the analysis (AC#5).
  const commentSaveChain = useRef<Promise<void>>(Promise.resolve());
  const persistComments = useCallback(
    (next: Comment[]) => {
      commentSaveChain.current = commentSaveChain.current
        .catch(() => {})
        .then(async () => {
          const dir = await workspace.getDirectoryHandle(name);
          await writeComments(dir, next);
        });
    },
    [workspace, name],
  );

  const addComment = useCallback(
    (partial: Omit<Comment, "id" | "createdAt">) => {
      const cur = commentsRef.current;
      const comment: Comment = {
        ...partial,
        id: mintCommentId(cur),
        createdAt: new Date().toISOString(),
      };
      const next = [...cur, comment];
      setComments(next);
      persistComments(next);
    },
    [persistComments],
  );

  const editComment = useCallback(
    (id: string, body: string) => {
      const next = commentsRef.current.map((c) =>
        c.id === id ? { ...c, body } : c,
      );
      setComments(next);
      persistComments(next);
    },
    [persistComments],
  );

  const deleteComment = useCallback(
    (id: string) => {
      const next = commentsRef.current.filter((c) => c.id !== id);
      setComments(next);
      persistComments(next);
    },
    [persistComments],
  );

  // The pending text selection awaiting a comment (drives the floating composer).
  const [pendingAnchor, setPendingAnchor] = useState<PendingAnchor | null>(null);
  useCommentSelection(commenting, setPendingAnchor);
  // Leaving Comment mode drops any half-typed composer.
  useEffect(() => {
    if (!commenting) setPendingAnchor(null);
  }, [commenting]);

  const commitAnchorComment = useCallback(
    (body: string) => {
      if (!pendingAnchor) return;
      addComment({
        kind: "anchor",
        taskId: pendingAnchor.taskId,
        field: pendingAnchor.field,
        quote: pendingAnchor.quote,
        body,
      });
      window.getSelection()?.removeAllRanges();
      setPendingAnchor(null);
    },
    [pendingAnchor, addComment],
  );

  // Clicking a comment scrolls to its anchored task card + a brief flash ring
  // (nice-to-have). A global / overview / orphan comment has no task to focus.
  const focusComment = useCallback((comment: Comment) => {
    if (!comment.taskId) return;
    const el = document.getElementById(taskCardDomId(comment.taskId));
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-1", "ring-inset", "ring-foreground/25");
    window.setTimeout(
      () => el.classList.remove("ring-1", "ring-inset", "ring-foreground/25"),
      1200,
    );
  }, []);

  // ---- TASK-60 (ADR-024): the comment→AI-revise loop -----------------------
  // Two flavors, both from Comment mode when comments exist: a text-only revise
  // (fast/cheap, no video — /api/revise) and a re-run-with-video (the full
  // grounded pipeline + the comments, /api/analyze). Both write a NEW run
  // (archiving the prior run + its comments), so on success we clear the local
  // comments and ask the parent to reload. Cancellable via an AbortController.
  const [revise, setRevise] = useState<ReviseUiState>({ status: "idle" });
  const reviseAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => reviseAbort.current?.abort(), // abort a run in flight on unmount
    [],
  );

  const beginReviseFlow = useCallback(
    (flavor: "text" | "video", config: AnalysisConfig) => {
      // The current stored analysis (reflects saved edits); nothing to revise
      // without it or without comments.
      const source = draft ?? liveAnalysis;
      const current = commentsRef.current;
      if (!source || current.length === 0) return;
      if (revise.status === "running") return;

      const controller = new AbortController();
      reviseAbort.current = controller;
      setRevise({ status: "running", flavor });

      void (async () => {
        try {
          const dir = await workspace.getDirectoryHandle(name);
          if (flavor === "text") {
            // Text-only revise: the chosen model + language thread into /api/revise
            // (mode is n/a for a single text call, so the dialog never asked).
            await runRevise({
              sessionDir: dir,
              sessionName: name,
              result: source,
              comments: current,
              model: config.model,
              language: config.language,
              signal: controller.signal,
            });
          } else {
            // Re-run WITH video: a full analyze pipeline + the comments, so the
            // full config (model + mode + language) threads into /api/analyze.
            await runAnalyze({
              sessionDir: dir,
              sessionName: name,
              model: config.model,
              mode: config.mode,
              language: config.language,
              signal: controller.signal,
              revise: { result: source, comments: current },
              onProgress: () => {
                // A coarse busy state is enough here — the button shows "Re-running…".
              },
            });
          }
          if (controller.signal.aborted) return;
          setRevise({ status: "idle" });
          setComments([]); // the new run starts comment-free (archived with the old)
          setMode("view");
          onRunReplaced();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            setRevise({ status: "idle" });
            return;
          }
          const message =
            err instanceof AnalyzeFlowError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          setRevise({ status: "error", message });
        }
      })();
    },
    [draft, liveAnalysis, revise.status, workspace, name, onRunReplaced],
  );

  const cancelRevise = useCallback(() => {
    reviseAbort.current?.abort();
    setRevise({ status: "idle" });
  }, []);

  // TASK-61 — both revise actions now go through the SAME pre-analysis config gate
  // as a fresh analysis (always ask model/language before spending on a call). The
  // ReviseBar buttons open this dialog; confirming runs beginReviseFlow with the
  // chosen config. null = closed.
  const [reviseConfig, setReviseConfig] = useState<{
    flavor: "text" | "video";
  } | null>(null);

  // Seed the config dialog with the current run's choices so a revise defaults to
  // how the session was last produced (model/mode/language), else the app defaults.
  const reviseSource = draft ?? liveAnalysis;
  const reviseDefaults = useMemo<Partial<AnalysisConfig>>(
    () => ({
      model: reviseSource?.run?.models?.[0],
      mode: reviseSource?.run?.mode,
      language: reviseSource?.run?.language,
    }),
    [reviseSource],
  );

  // Rough input-token budget for the TEXT-only revise cost estimate: the current
  // tasks + comments serialized (~4 chars/token). The video revise ignores this
  // (its cost is measured from the recording's duration instead).
  const reviseTextTokens = useMemo(() => {
    if (!reviseSource) return undefined;
    const payload = JSON.stringify({ result: reviseSource, comments });
    return Math.ceil(payload.length / 4);
  }, [reviseSource, comments]);

  if (showSkeleton || data === null) return <LoadingBody />;

  if (data.status === "not-found") {
    return (
      <CenteredNotice
        title="Session not found"
        detail="This folder is gone or is no longer a Vellum session."
      />
    );
  }
  if (data.status === "error") {
    return (
      <CenteredNotice
        title="Couldn't open this session"
        detail="The workspace became unreachable. Try reopening it from the sidebar."
      />
    );
  }
  if (data.status === "unanalyzed") {
    return (
      <UnanalyzedBody
        recording={data.recording}
        analyze={analyze}
        onAnalyze={onAnalyze}
        otherAnalyzing={otherAnalyzing}
      />
    );
  }

  // TASK-51 — resolve which run's content the body renders. The latest (default)
  // reads straight from `data`; an archived run reads from the on-demand load.
  // While an archive loads we keep the latest's overview on the left (stable) and
  // show a loading state on the right rather than flashing the stale list.
  const viewingArchive = selectedRun !== null;
  const runLoading = viewingArchive && archived.status !== "done";
  const archivedData = archived.status === "done" ? archived.data : null;

  const activeAnalysis =
    viewingArchive && archivedData ? archivedData.analysis : data.analysis;
  const activeMalformed =
    viewingArchive && archivedData ? archivedData.malformed : data.malformed;
  const activeOverview = activeAnalysis?.overview ?? "";
  // report.md for the latest (null if this session has none — an incomplete
  // session, ADR-008); report-<stamp>.md for an archive (null → no report for this
  // run). null → the Markdown tab hides; the task list still works.
  const activeReportFile = viewingArchive
    ? archivedData?.reportFile ?? null
    : data.hasReport
      ? "report.md"
      : null;
  // The frames folder the Markdown view resolves images against: the live
  // screenshots/ for the latest, or this run's screenshots-<stamp>/ (ADR-023).
  const activeScreenshotsDir =
    viewingArchive && archivedData ? archivedData.screenshotsDir : "screenshots";
  // Download kebab — the download filename disambiguator: null for the latest (files are
  // `<slug>.md/.json`), the archived run's stamp otherwise (`<slug>-<stamp>.md`)
  // so an older run's export never collides with the latest's. The stamp is lifted
  // from the selected run's `tasks-<stamp>.json` filename.
  const activeDownloadStamp = viewingArchive
    ? archiveStampFromSource(selectedRun?.source)
    : null;

  // TASK-56/57 — the View/Edit/Comment switcher (and inline editing) is offered
  // only on the LIVE run with a parsed analysis (`canEdit`, computed above with the
  // editing state). On that run we render from the editable `draft` (which reflects
  // saved edits) instead of the on-disk read; an archived/read-only run renders its
  // own content untouched.
  const shownAnalysis = canEdit ? draft ?? activeAnalysis : activeAnalysis;
  const shownOverview = canEdit ? draft?.overview ?? activeOverview : activeOverview;

  return (
    <>
      <main
        ref={mainRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: `minmax(0,1fr) 1px ${rightWidth}px` }}
      >
        <PlayerPane
          recording={data.recording}
          showTabs={data.analysis !== null}
          videoRef={videoRef}
          onSeeking={onVideoSeeking}
          workspace={workspace}
          name={name}
          reloadKey={reloadKey}
          selectedSource={selectedRun?.source ?? null}
          onSelectRun={onSelectRun}
          liveEdited={liveEdited}
        />
        <ResizeHandle onPointerDown={startResize} />
        <RightColumn
          analysis={shownAnalysis}
          malformed={activeMalformed}
          reportFile={activeReportFile}
          screenshotsDir={activeScreenshotsDir}
          loading={runLoading}
          viewingArchive={viewingArchive}
          onGoToLatest={() => onSelectRun(null)}
          displayName={data.displayName}
          downloadStamp={activeDownloadStamp}
          canEdit={canEdit}
          mode={mode}
          onModeChange={setMode}
          editing={editing}
          baselineById={baselineById}
          onTaskChange={updateTask}
          onAddTask={addTask}
          onDeleteTask={deleteTask}
          onMoveTask={moveTask}
          reloadToken={savedNonce}
          workspace={workspace}
          name={name}
          selected={selected}
          onSelect={setSelected}
          onSeek={seekTo}
          commenting={commenting}
          comments={comments}
          pendingAnchor={pendingAnchor}
          overview={shownOverview}
          onOverviewChange={updateOverview}
          overviewBaseline={baseline?.overview}
          onAddGlobalComment={(body) => addComment({ kind: "global", body })}
          onEditComment={editComment}
          onDeleteComment={deleteComment}
          onFocusComment={focusComment}
          reviseState={revise}
          reviseBlocked={otherAnalysisActive}
          onProcessComments={() => setReviseConfig({ flavor: "text" })}
          onReRunWithVideo={() => setReviseConfig({ flavor: "video" })}
          onCancelRevise={cancelRevise}
        />
      </main>

      {/* The floating comment composer for a live text selection (TASK-59). */}
      {commenting && pendingAnchor && (
        <CommentComposer
          anchor={pendingAnchor}
          onSave={commitAnchorComment}
          onCancel={() => setPendingAnchor(null)}
        />
      )}

      {/* TASK-61 — the pre-analysis config gate for BOTH revise actions, reusing
          the same dialog as a fresh analysis. "Process comments" opens the
          text-only variant (model + language, no mode, cheap text cost);
          "Re-run with video" opens the full config (model + mode + language,
          full-video cost). Confirming threads the choice into beginReviseFlow. */}
      <AnalysisConfigDialog
        variant={reviseConfig?.flavor === "video" ? "revise-video" : "revise-text"}
        sessionName={reviseConfig ? name : null}
        defaults={reviseDefaults}
        textInputTokens={reviseTextTokens}
        onStart={(config) => {
          const flavor = reviseConfig?.flavor;
          setReviseConfig(null);
          if (flavor) beginReviseFlow(flavor, config);
        }}
        onClose={() => setReviseConfig(null)}
      />
    </>
  );
}

// Right column of a readable session: a Tasks | Markdown switcher (only when a
// report.md exists) over the pane it toggles. Tasks is the interactive list
// (TASK-18); Markdown renders report.md (TASK-34). A session with no report.md
// (incomplete — ADR-008) shows the task list alone, no switcher. The view state
// lives here so switching never disturbs the player or the task selection.
function RightColumn({
  analysis,
  malformed,
  reportFile,
  screenshotsDir,
  loading,
  viewingArchive,
  onGoToLatest,
  displayName,
  downloadStamp,
  canEdit,
  mode,
  onModeChange,
  editing,
  baselineById,
  onTaskChange,
  onAddTask,
  onDeleteTask,
  onMoveTask,
  reloadToken,
  workspace,
  name,
  selected,
  onSelect,
  onSeek,
  commenting,
  comments,
  pendingAnchor,
  overview,
  onOverviewChange,
  overviewBaseline,
  onAddGlobalComment,
  onEditComment,
  onDeleteComment,
  onFocusComment,
  reviseState,
  reviseBlocked,
  onProcessComments,
  onReRunWithVideo,
  onCancelRevise,
}: {
  // The ACTIVE run's content (TASK-51): the latest, or a selected archive. On the
  // live editable run this is the in-memory draft (reflects saved edits).
  analysis: StoredAnalysisResult | null;
  malformed: boolean;
  // The report to render in the Markdown tab (report.md or report-<stamp>.md), or
  // null when the active run has none — the switcher then hides.
  reportFile: string | null;
  // The frames folder the Markdown view resolves images against (screenshots/ or a
  // run's screenshots-<stamp>/ — ADR-023).
  screenshotsDir: string;
  // True while an archived run is still loading — show a placeholder, not the
  // previous run's list.
  loading: boolean;
  // TASK-51 follow-up — a non-latest (archived) run is selected. Read-only, so
  // there's no mode switcher; instead the header offers a "Go to latest run"
  // affordance (onGoToLatest clears the selection back to the live run).
  viewingArchive: boolean;
  onGoToLatest: () => void;
  // Download kebab — the session display name (for the download filename slug) + the
  // archived-run stamp disambiguator (null for the latest). Fed to the download
  // kebab on the far right of the header row.
  displayName: string;
  downloadStamp: string | null;
  // TASK-56 — the live run with a parsed analysis: offer the View/Edit/Comment
  // switcher. False for an archived or malformed run (read-only, View only).
  canEdit: boolean;
  // TASK-57 — the mode is owned by Body (it also drives the overview editor), so
  // the switcher here is controlled.
  mode: SessionMode;
  onModeChange: (next: SessionMode) => void;
  // Edit mode is active (canEdit && mode === "edit") — turn the rows editable.
  editing: boolean;
  // AI baseline per task id, for the "edited" markers + revert (empty until the
  // first edit creates the baseline).
  baselineById: Map<string, StoredVellumTask>;
  // Persist a field edit on a task (by list index). Autosaved by Body.
  onTaskChange: (index: number, patch: Partial<StoredVellumTask>) => void;
  // TASK-58 — structural edits (Edit mode only), all autosaved by Body via the
  // non-archiving save path.
  onAddTask: () => void;
  onDeleteTask: (index: number) => void;
  onMoveTask: (index: number, dir: -1 | 1) => void;
  // Bumped after each save so the Markdown pane re-reads report.md (tasks.json ↔
  // report.md stay in sync on screen).
  reloadToken: number;
  workspace: FileSystemDirectoryHandle;
  name: string;
  selected: number | null;
  onSelect: (index: number) => void;
  onSeek: (mmss: string | undefined) => void;
  // TASK-59 — Comment mode (canEdit && mode === "comment"): the task list becomes
  // selectable + highlighted, and the comments panel docks below the panes.
  commenting: boolean;
  comments: Comment[];
  /** The OPEN composer's anchor (the in-progress selection), so the field it targets
   *  can show its pending yellow highlight on the page. Null when none is open. */
  pendingAnchor: PendingAnchor | null;
  /** The active overview text — rendered as a header block at the top of the Tasks
   *  pane (TASK-61 layout) and used to resolve overview-anchor comments below. On
   *  the live editable run this reflects saved edits (the draft's overview). */
  overview: string;
  /** TASK-57 — Edit mode: commit an inline edit of the overview (autosaved by Body). */
  onOverviewChange: (next: string) => void;
  /** The AI baseline overview, for the "edited" marker + revert (undefined = none). */
  overviewBaseline: string | undefined;
  onAddGlobalComment: (body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  onFocusComment: (comment: Comment) => void;
  // TASK-60 — the comment→AI-revise actions + their busy/error state.
  reviseState: ReviseUiState;
  /** An analysis run is active elsewhere — block starting a revise. */
  reviseBlocked: boolean;
  onProcessComments: () => void;
  onReRunWithVideo: () => void;
  onCancelRevise: () => void;
}) {
  const [view, setView] = useState<SessionPaneView>("tasks");
  const hasReport = reportFile !== null;
  const active = hasReport ? view : "tasks";

  // Markdown is a read-only rendered report — you can't edit or comment there
  // (the overview + tasks it contains are already baked into the prose). When the
  // Markdown tab is open, fall back to View so no edit/comment affordance (or the
  // now-hidden mode switcher) leaks into it. Switching back to Tasks starts from
  // View — we don't preserve the prior mode across the Markdown visit (simpler,
  // predictable).
  useEffect(() => {
    if (active === "markdown" && mode !== "view") onModeChange("view");
  }, [active, mode, onModeChange]);

  // Keep both panes mounted and toggle them with `hidden`, instead of swapping
  // one for the other — switching Tasks<->Markdown used to unmount ReportView,
  // so each visit re-read report.md + every screenshot and re-parsed the
  // Markdown. Mounted once, it stays warm. Markdown is still lazy: it doesn't
  // mount until the first time it's opened, so a session you never expand pays
  // nothing.
  const [markdownVisited, setMarkdownVisited] = useState(false);
  useEffect(() => {
    if (active === "markdown") setMarkdownVisited(true);
  }, [active]);

  // The download kebab shows whenever the active run has anything to
  // export (a report to save as MD, or a parsed analysis to save as JSON). This
  // also keeps the header row present on a run that has neither a switcher nor a
  // report but does have tasks, so the kebab is reachable on every version.
  const canDownload = reportFile !== null || analysis !== null;

  return (
    <div className="flex min-h-0 flex-col">
      {(canEdit || hasReport || viewingArchive || canDownload) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 pt-3 pb-3">
          {/* Content switcher (Tasks | Markdown) on the LEFT; the empty span keeps
              the right-side affordances pushed right via justify-between when
              there's no report to switch. */}
          {hasReport ? (
            <ViewSwitcher value={view} onChange={setView} />
          ) : (
            <span aria-hidden />
          )}
          {/* RIGHT side, as one group so the kebab always sits at the far right.
              On the live editable run: the icon-only View | Edit | Comment switcher
              (Tasks tab only — Markdown is read-only). On a non-latest archived run
              (read-only, no switcher): a quiet text button back to the latest run.
              The switcher/back-button are mutually exclusive (canEdit is false while
              an archive is viewed); the download button renders on BOTH. */}
          <div className="flex items-center gap-2">
            {canEdit && active === "tasks" && (
              <ModeSwitcher value={mode} onChange={onModeChange} />
            )}
            {viewingArchive && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={onGoToLatest}
              >
                Go to latest run
              </Button>
            )}
            <DownloadMenu
              reportFile={reportFile}
              analysis={analysis}
              workspace={workspace}
              name={name}
              displayName={displayName}
              stamp={downloadStamp}
            />
          </div>
        </div>
      )}
      {/* Archived-run switch (TASK-51): a brief placeholder while its tasks load,
          over both hidden panes. */}
      {loading && <RunLoading />}
      <div
        hidden={loading || active !== "tasks"}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TaskListPane
          analysis={analysis}
          malformed={malformed}
          selected={selected}
          onSelect={onSelect}
          onSeek={onSeek}
          editing={editing}
          baselineById={baselineById}
          onTaskChange={onTaskChange}
          onAddTask={onAddTask}
          onDeleteTask={onDeleteTask}
          onMoveTask={onMoveTask}
          commenting={commenting}
          comments={comments}
          pendingAnchor={pendingAnchor}
          overview={overview}
          onOverviewChange={onOverviewChange}
          overviewBaseline={overviewBaseline}
        />
      </div>
      {markdownVisited && reportFile && (
        <div
          hidden={loading || active !== "markdown"}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ReportView
            workspace={workspace}
            name={name}
            reportFile={reportFile}
            screenshotsDir={screenshotsDir}
            reloadToken={reloadToken}
          />
        </div>
      )}
      {/* TASK-59 — the comments panel docks below the panes in Comment mode:
          tasks/overview on top, comments accumulating below (the plannotator
          margin feel). Its tasks come from the live analysis (AnchorTarget). */}
      {commenting && (
        <CommentsPanel
          comments={comments}
          tasks={analysis?.tasks ?? []}
          overview={overview}
          onAddGlobal={onAddGlobalComment}
          onEdit={onEditComment}
          onDelete={onDeleteComment}
          onFocus={onFocusComment}
          reviseState={reviseState}
          reviseBlocked={reviseBlocked}
          onProcessComments={onProcessComments}
          onReRunWithVideo={onReRunWithVideo}
          onCancelRevise={onCancelRevise}
        />
      )}
    </div>
  );
}

// TASK-51 — the right pane while a picked archived run's tasks load. Mirrors the
// task-list surface so the switch doesn't shift the column.
function RunLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-background p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2 p-4">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

type SessionPaneView = "tasks" | "markdown";

/** One segment of a SegmentedSwitcher: a stable id, its label, and an optional
 *  Lucide icon (the right pane uses icons; the left pane's Overview/Details don't). */
interface Segment<T extends string> {
  id: T;
  label: string;
  icon?: typeof ListChecks;
}

// A compact, hug-content segmented control (ADR-004): a muted track with the
// active segment lifted onto a raised pill; the rest stay muted text and rise to
// full contrast on hover. 150ms ease-out (ADR-005). Generic so the right pane's
// Tasks | Markdown and its icon-only View | Edit | Comment mode switcher share
// one styling source of truth.
//
// `iconOnly` is the mode switcher's variant. The ACTIVE segment shows its icon +
// label inline; a resting non-active segment is icon-only and shows its label as a
// Tooltip on hover (the same Tooltip used elsewhere) — no inline reveal. aria-label
// keeps every segment accessible. The active label span is the 20px text line box,
// so the switcher stays a fixed 28px, level with the labelled Tasks | Markdown one.
function SegmentedSwitcher<T extends string>({
  segments,
  value,
  onChange,
  iconOnly = false,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (next: T) => void;
  iconOnly?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {segments.map((segment) => {
        const active = value === segment.id;
        const icon = segment.icon && (
          <segment.icon className="size-4 shrink-0" strokeWidth={1.5} />
        );

        // Icon-only (the mode switcher). The ACTIVE segment shows its icon + label
        // inline (a 20px line box, so the box matches the labelled switcher's 28px
        // height). A non-active segment is icon-only and surfaces its label as a
        // Tooltip on hover — no inline reveal. aria-label keeps it accessible.
        if (iconOnly) {
          if (active) {
            return (
              <button
                key={segment.id}
                type="button"
                onClick={() => onChange(segment.id)}
                aria-pressed
                aria-label={segment.label}
                className="inline-flex items-center gap-1.5 rounded-md bg-background px-2 py-1 text-sm font-medium text-foreground shadow-sm transition-colors duration-150 ease-out active:opacity-80"
              >
                {icon}
                <span className="whitespace-nowrap">{segment.label}</span>
              </button>
            );
          }
          return (
            <Tooltip key={segment.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onChange(segment.id)}
                    aria-pressed={false}
                    aria-label={segment.label}
                    className="inline-flex items-center rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground active:opacity-80"
                  />
                }
              >
                {icon}
              </TooltipTrigger>
              <TooltipContent>{segment.label}</TooltipContent>
            </Tooltip>
          );
        }

        return (
          <button
            key={segment.id}
            type="button"
            onClick={() => onChange(segment.id)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors duration-150 ease-out active:opacity-80",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {icon}
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}

const RIGHT_PANE_SEGMENTS: Segment<SessionPaneView>[] = [
  { id: "tasks", label: "Tasks", icon: ListChecks },
  { id: "markdown", label: "Markdown", icon: FileText },
];

// The right pane's Tasks | Markdown switcher (TASK-34) — a thin wrapper over the
// shared SegmentedSwitcher.
function ViewSwitcher({
  value,
  onChange,
}: {
  value: SessionPaneView;
  onChange: (next: SessionPaneView) => void;
}) {
  return (
    <SegmentedSwitcher
      segments={RIGHT_PANE_SEGMENTS}
      value={value}
      onChange={onChange}
    />
  );
}

// TASK-56 — the session's editing mode (ADR-024). View is the current read-only
// behavior; Edit and Comment are scaffolded here (same read-only body for now) and
// filled by TASK-57/58/59. Only offered on the live run (see RightColumn.canEdit).
type SessionMode = "view" | "edit" | "comment";

// TASK-60 — the comment→AI-revise UI state (idle / a running flavor / an error).
type ReviseUiState =
  | { status: "idle" }
  | { status: "running"; flavor: "text" | "video" }
  | { status: "error"; message: string };

const MODE_SEGMENTS: Segment<SessionMode>[] = [
  { id: "view", label: "View", icon: Eye },
  { id: "edit", label: "Edit", icon: Pencil },
  { id: "comment", label: "Comment", icon: MessageSquareText },
];

// The View | Edit | Comment mode switcher — the same monochrome SegmentedSwitcher
// as the Tasks | Markdown pane (ADR-004), rendered ICON-ONLY (thin Lucide Eye /
// Pencil / MessageSquareText, ADR-005) at the SAME segment height as the labelled
// switcher. The active segment shows its label inline; the others are icon-only
// and reveal their label as a Tooltip on hover.
// Validated in both themes (ADR-019): its track/pill read off the theme tokens,
// no hardcoded colors.
function ModeSwitcher({
  value,
  onChange,
}: {
  value: SessionMode;
  onChange: (next: SessionMode) => void;
}) {
  return (
    <SegmentedSwitcher
      segments={MODE_SEGMENTS}
      value={value}
      onChange={onChange}
      iconOnly
    />
  );
}

// The drag handle between the player and the right pane (TASK-34). A crisp 1px
// line flush on the pane boundary (so the tab bar's border meets it with no gap)
// with a wider invisible grab zone overlaid — the overlay doesn't affect layout.
function ResizeHandle({
  onPointerDown,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className="group relative bg-border transition-colors hover:bg-foreground/30"
    >
      <span className="absolute inset-y-0 -left-1.5 -right-1.5 z-10 cursor-col-resize touch-none select-none" />
    </div>
  );
}

// Left column: the video player pinned to the top; beneath it the run history
// (InfoPanel — every run's model(s), mode, language, tokens, and cost, read from
// tasks.json + the ADR-009 archives). The Overview moved to the top of the Tasks
// pane in the right column (TASK-61 layout), so there's no left-pane switcher
// anymore — this column is just the player + Runs. The history only appears once
// there's an analysis to describe; before that (unanalyzed / malformed) it's just
// the player.
function PlayerPane({
  recording,
  showTabs,
  videoRef,
  onSeeking,
  workspace,
  name,
  reloadKey,
  selectedSource,
  onSelectRun,
  liveEdited,
}: {
  recording: File | null;
  /** Whether the analyzed session has run history to show (the latest run parsed).
   *  Kept stable across run-switching so the Runs list (where you switch) never
   *  vanishes mid-switch. */
  showTabs: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Fires on every seek — used to drop the row selection on a manual scrub. */
  onSeeking: () => void;
  workspace: FileSystemDirectoryHandle;
  name: string;
  /** Reload token — re-reads run history when the view reloads (TASK-48). */
  reloadKey: string;
  /** The archived run currently viewed (null = latest) + the setter, so the Runs
   *  list can highlight the active run and switch to another (TASK-51). */
  selectedSource: string | null;
  onSelectRun: (run: SelectedRun | null) => void;
  /** TASK-61 — the live run has manual edits diverging from its AI baseline; the
   *  Runs list flags its live run row with a quiet "Edited" indicator. */
  liveEdited: boolean;
}) {
  const objectUrl = useObjectUrl(recording);

  // The left pane no longer scrolls as one block. The player is a fixed top
  // section; beneath it the run history fills the rest, with its OWN fixed header
  // (the "N runs" summary + full-bleed border) over an independently-scrolling
  // list of run rows (v1.1 — headers fixed, content scrolls under the border).
  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 p-6">
        {objectUrl ? (
          <video
            key={objectUrl}
            ref={videoRef}
            src={objectUrl}
            controls
            onSeeking={onSeeking}
            className="aspect-video w-full rounded-md border border-border bg-black"
          />
        ) : (
          <MissingRecording />
        )}
      </div>

      {showTabs && (
        <div className="flex min-h-0 flex-1 flex-col">
          <InfoPanel
            workspace={workspace}
            name={name}
            reloadKey={reloadKey}
            selectedSource={selectedSource}
            onSelectRun={onSelectRun}
            liveEdited={liveEdited}
          />
        </div>
      )}
    </div>
  );
}

// The analysis summary (unchanged from the original Overview section). A parsed
// AnalysisResult always carries an overview (schema-required), so the empty
// branch only guards a defensively-empty string.
function OverviewPanel({
  overview,
  editing,
  onChange,
  baseline,
  commenting,
  comments,
  pendingQuote,
}: {
  overview: string;
  // TASK-57 — Edit mode: the overview is inline-editable (multi-line), diffed
  // against the AI baseline for a quiet "edited" marker + revert.
  editing: boolean;
  onChange: (next: string) => void;
  baseline: string | undefined;
  // TASK-59 — Comment mode: the overview is selectable + shows comment highlights.
  commenting: boolean;
  comments: Comment[];
  // The in-progress composer's quote when it anchors to the overview — its pending
  // yellow highlight on the page.
  pendingQuote?: string;
}) {
  if (commenting) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {overview ? (
          <CommentableText
            text={overview}
            field="overview"
            comments={comments}
            pendingQuote={pendingQuote}
          />
        ) : (
          "No overview was written for this session."
        )}
      </p>
    );
  }

  if (editing) {
    const edited = baseline !== undefined && overview !== baseline;
    return (
      <div className="group/field flex items-start gap-1">
        <span className="min-w-0 flex-1">
          <InlineTextarea
            value={overview}
            ariaLabel="Session overview"
            className="text-[13px] leading-relaxed text-muted-foreground"
            onCommit={onChange}
          />
        </span>
        <span className="mt-0.5">
          <EditMarker
            edited={edited}
            onRevert={() => {
              if (baseline !== undefined) onChange(baseline);
            }}
          />
        </span>
      </div>
    );
  }

  if (!overview) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        No overview was written for this session.
      </p>
    );
  }
  return (
    <p className="text-[13px] leading-relaxed text-muted-foreground">
      {overview}
    </p>
  );
}

type RunHistoryLoad =
  | { status: "loading" }
  | { status: "done"; runs: RunHistoryEntry[] };

// TASK-48 — the Info tab: this session's analysis history. Reads every run
// (tasks.json + the ADR-009 archives) via loadRunHistory and lists each with its
// model(s) incl. fallback (ADR-021 — this subsumes TASK-44), mode, language,
// tokens, and real cost, plus totals. Read-only, monochrome, dense. Reloads on
// `reloadKey` so a just-finished re-analysis shows up without leaving the view.
function InfoPanel({
  workspace,
  name,
  reloadKey,
  selectedSource,
  onSelectRun,
  liveEdited,
}: {
  workspace: FileSystemDirectoryHandle;
  name: string;
  reloadKey: string;
  /** The archived run currently viewed (null = latest), for highlighting + click
   *  toggling (TASK-51). */
  selectedSource: string | null;
  onSelectRun: (run: SelectedRun | null) => void;
  /** TASK-61 — the live run diverges from its AI baseline; flag its row "Edited". */
  liveEdited: boolean;
}) {
  const [load, setLoad] = useState<RunHistoryLoad>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    loadRunHistory(workspace, name)
      .then((runs) => {
        if (!cancelled) setLoad({ status: "done", runs });
      })
      .catch(() => {
        // loadRunHistory is best-effort and shouldn't throw; a genuine throw
        // degrades to an empty history rather than a crash (ADR-008).
        if (!cancelled) setLoad({ status: "done", runs: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, name, reloadKey]);

  if (load.status === "loading") {
    return (
      <div className="flex flex-col gap-3 px-6 pb-6">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  const { runs } = load;
  if (runs.length === 0) {
    return (
      <p className="px-6 pb-6 text-[13px] leading-relaxed text-muted-foreground">
        No analysis details recorded yet. Model, token, and cost data appears
        here once this session is analyzed.
      </p>
    );
  }

  const multi = runs.length > 1;
  // The header (RunTotals) is fixed with a full-bleed bottom border; the run rows
  // scroll independently beneath it (v1.1 layout).
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunTotals runs={runs} />
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-6 pb-6 pt-4">
        {runs.map((entry) => {
          // The active run: an explicit archive selection, else the latest (which
          // is `current`) when nothing is selected.
          const active = selectedSource
            ? selectedSource === entry.source
            : entry.current;
          return (
            <RunRow
              key={entry.source}
              entry={entry}
              multi={multi}
              active={active}
              // "Edited" shows ONLY on the live run while it's the one being
              // viewed (active): a persistent flag on an unselected row read as
              // noise. So: live run + diverges from its AI baseline + selected.
              edited={entry.current && liveEdited && active}
              onSelect={() =>
                // Clicking the latest run returns to the default (null); clicking
                // an archive views it. Read-only — never re-analyzes.
                onSelectRun(
                  entry.current
                    ? null
                    : { source: entry.source, sortMs: entry.sortMs },
                )
              }
            />
          );
        })}
      </ul>
    </div>
  );
}

// The header line above the run list: how many runs, and their summed real cost.
// Costs are only summed for runs that carry one; if any run's cost is unknown
// (a used model had no known price, or a pre-TASK-45 run) the total is marked
// with a trailing "+" so it reads as a floor, never a false exact figure.
function RunTotals({ runs }: { runs: RunHistoryEntry[] }) {
  let knownCost = 0;
  let hasKnownCost = false;
  let anyUnknownCost = false;
  for (const entry of runs) {
    const cost = entry.run?.costUsd;
    if (typeof cost === "number") {
      knownCost += cost;
      hasKnownCost = true;
    } else {
      anyUnknownCost = true;
    }
  }

  const costLabel = hasKnownCost
    ? `$${knownCost.toFixed(2)}${anyUnknownCost ? "+" : ""}`
    : "—";

  return (
    <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-border px-6 pb-2.5">
      <span className="text-[13px] font-medium text-foreground">
        {runs.length} {runs.length === 1 ? "run" : "runs"}
      </span>
      <span className="font-mono text-[13px] tabular-nums text-foreground">
        {costLabel}
      </span>
    </div>
  );
}

// One run in the history. Primary line: relative time + its real cost. Meta line
// (muted): absolute time, model(s), mode, language, tokens. A run with no
// telemetry (pre-TASK-45) shows the time it can infer and "—" for the rest —
// surfaced, never hidden (ADR-008).
function RunRow({
  entry,
  multi,
  active,
  edited,
  onSelect,
}: {
  entry: RunHistoryEntry;
  multi: boolean;
  /** This run is the one currently shown in the view (TASK-51). */
  active: boolean;
  /** TASK-61 — this is the live run and it has manual edits vs its AI baseline. */
  edited: boolean;
  /** Toggle the view to this run (latest → default, archive → view it). */
  onSelect: () => void;
}) {
  const { run, sortMs, current, id } = entry;
  const absolute = new Date(sortMs).toLocaleString();
  const cost =
    run && typeof run.costUsd === "number" ? `$${run.costUsd.toFixed(2)}` : "—";

  // The info body is identical whether or not the run is switchable; only the
  // wrapper differs. When there are several runs, a leading check column marks
  // the one being viewed (alongside the selected-row fill). The check is its own
  // column (reserved on every row) so BOTH text lines align to the timestamp.
  const body = (
    <div className="flex gap-2">
      {multi && (
        <span className="flex w-3.5 shrink-0 justify-center pt-[3px]">
          {active && (
            <Check className="size-3.5 text-foreground" strokeWidth={2} />
          )}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Primary line: the run id LEADS (its mono handle is the identifier),
            then a muted middot divider, the relative time, and the Latest / Edited
            pills — all centered on one row, with the cost pushed to the right. */}
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[13px] leading-none tabular-nums text-foreground">
              #{id}
            </span>
            <span aria-hidden className="text-muted-foreground/70">
              ·
            </span>
            <span className="text-[13px] leading-none text-foreground">
              {formatRelativeTime(sortMs)}
            </span>
            {current && multi && (
              <span className="rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
                Latest
              </span>
            )}
            {edited && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
                <Pencil className="size-2.5" strokeWidth={1.5} />
                Edited
              </span>
            )}
          </span>
          <span className="font-mono text-[12px] leading-none tabular-nums text-foreground">
            {cost}
          </span>
        </div>
        {/* Secondary line: the run's metadata. The id now leads the primary line
            above, so it isn't repeated here — the absolute timestamp leads. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span className="font-mono tabular-nums" title={absolute}>
            {absolute}
          </span>
          {run ? (
            <>
              {run.origin && run.origin !== "analyze" && (
                <>
                  <MetaDot />
                  <span className="rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                    {ORIGIN_LABELS[run.origin]}
                  </span>
                </>
              )}
              <MetaDot />
              <ModelLabel models={run.models} />
              <MetaDot />
              <span>{MODE_LABELS[run.mode]}</span>
              {run.language && (
                <>
                  <MetaDot />
                  <span>{LANGUAGE_LABELS[run.language]}</span>
                </>
              )}
              <MetaDot />
              <span className="font-mono tabular-nums">
                {compactTokens(run.tokensIn)} in · {compactTokens(run.tokensOut)} out
              </span>
            </>
          ) : (
            <>
              <MetaDot />
              <span>—</span>
            </>
          )}
        </div>
      </div>
    </div>
  );

  // A lone run isn't switchable — render a static row (no fill, nothing to select).
  if (!multi) {
    return <li className="py-2.5">{body}</li>;
  }

  // Several runs: the whole row is one click target that loads that run into the
  // view (read-only). The active run sits on a raised card surface (bg-sidebar +
  // a hairline ring — the same selected-row vocabulary as the task list); a
  // non-active row stays flat and takes a quieter, more muted fill on hover for a
  // clickable affordance. Rows are separated by the ul's gap, not dividers, so the
  // rounded fills read cleanly (ADR-005: 150ms ease-out on the hover bg).
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          "-mx-2 block w-[calc(100%+1rem)] rounded-lg px-2 py-2.5 text-left transition-colors duration-150 ease-out",
          "active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar ring-1 ring-inset ring-foreground/10"
            : "hover:bg-sidebar/60",
        )}
      >
        {body}
      </button>
    </li>
  );
}

// The model(s) a run used, primary-first (ADR-021). A single model renders as
// its pretty name; a fallback (>1 model) renders "primary → fallback" plus a
// quiet "fallback" tag — this is TASK-44's model surfacing, folded in here.
function ModelLabel({ models }: { models: string[] }) {
  if (models.length === 0) return <span>—</span>;
  if (models.length === 1) return <span>{prettyModel(models[0])}</span>;
  return (
    <span className="flex items-center gap-1.5">
      <span>{models.map(prettyModel).join(" → ")}</span>
      <span className="rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide">
        fallback
      </span>
    </span>
  );
}

/** A hairline middot separating meta fields — quieter than the text around it. */
function MetaDot() {
  return <span className="text-muted-foreground/70">/</span>;
}

const MODE_LABELS: Record<AnalysisRun["mode"], string> = {
  thorough: "Thorough",
  economy: "Basic",
};

// TASK-60 — how a run was produced; only the revise origins get a badge ("analyze"
// is the unmarked default). Keyed by the non-analyze origins so a fresh analysis
// stays visually clean.
const ORIGIN_LABELS: Record<"revise-text" | "revise-video", string> = {
  "revise-text": "Revised",
  "revise-video": "Revised · video",
};

const LANGUAGE_LABELS: Record<NonNullable<AnalysisRun["language"]>, string> = {
  en: "English",
  uk: "Ukrainian",
};

/** "gemini-2.5-flash" → "2.5 Flash". Unknown ids pass through mostly as-is. */
function prettyModel(id: string): string {
  return id
    .replace(/^gemini-/, "")
    .split("-")
    .map((part) => (/^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** Compact token count: 81002 → "81K", 6092 → "6K", 1_250_000 → "1.3M". */
function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Right column: the dense, scrollable, clickable task list. Selecting a row seeks
// the player to where the task was *discussed*; clicking a row's "visible"
// timestamp seeks to where it's *visible* (ADR-013). Thumbnails were dropped
// (TASK-33 follow-up) — too small to read; the frames stay in the report.
function TaskListPane({
  analysis,
  malformed,
  selected,
  onSelect,
  onSeek,
  editing,
  baselineById,
  onTaskChange,
  onAddTask,
  onDeleteTask,
  onMoveTask,
  commenting,
  comments,
  pendingAnchor,
  overview,
  onOverviewChange,
  overviewBaseline,
}: {
  analysis: StoredAnalysisResult | null;
  malformed: boolean;
  // Selection lives in Body so a manual video scrub can clear it (a task click
  // both selects and seeks; a scrub deselects).
  selected: number | null;
  onSelect: (index: number) => void;
  onSeek: (mmss: string | undefined) => void;
  // TASK-57 — Edit mode: rows become inline-editable, diffed against the baseline.
  editing: boolean;
  baselineById: Map<string, StoredVellumTask>;
  onTaskChange: (index: number, patch: Partial<StoredVellumTask>) => void;
  // TASK-58 — structural edits, offered only in Edit mode.
  onAddTask: () => void;
  onDeleteTask: (index: number) => void;
  onMoveTask: (index: number, dir: -1 | 1) => void;
  // TASK-59 — Comment mode: rows become selectable + show comment highlights.
  commenting: boolean;
  comments: Comment[];
  // The OPEN composer's anchor (the in-progress selection), forwarded so the field
  // it targets can show its pending yellow highlight on the page.
  pendingAnchor: PendingAnchor | null;
  // TASK-61 layout — the session overview, rendered as a header block above the
  // task list. Editable in Edit mode / commentable in Comment mode exactly like
  // it was in the (removed) left-pane About tab; read-only in View.
  overview: string;
  onOverviewChange: (next: string) => void;
  overviewBaseline: string | undefined;
}) {
  const taskCount = analysis?.tasks.length ?? 0;
  // The overview header shows whenever there IS one, or in Edit mode so an empty
  // one can be written. Skipped for a malformed/overview-less read-only run so it
  // never adds an empty "No overview" line above the list.
  const showOverview = analysis !== null && (overview !== "" || editing);
  return (
    // TASK-33 — the pane is the app background black; cards share that black at
    // rest (blend, no divider lines) and lighten to the sidebar gray on hover.
    // flex-1 so it fills the right column beneath the TASK-34 switcher and scrolls
    // internally (it used to be the grid cell directly, stretched by the grid).
    // `comment-selection` (Comment mode only) tints the live text selection with
    // the comment-highlight yellow — scoped so default selection is untouched.
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-background p-4",
        commenting && "comment-selection",
      )}
    >
      {/* TASK-61 layout — the overview as a quiet header block above the numbered
          list: a small mono/uppercase label, then the summary (inline-editable in
          Edit, commentable in Comment). A hairline separates it from the cards. */}
      {showOverview && (
        <div className="flex flex-col gap-2 border-b border-border/60 px-1 pb-4">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Overview
          </span>
          <OverviewPanel
            overview={overview}
            editing={editing}
            onChange={onOverviewChange}
            baseline={overviewBaseline}
            commenting={commenting}
            comments={comments.filter(
              (c) => c.kind === "anchor" && c.field === "overview",
            )}
            pendingQuote={
              pendingAnchor &&
              !pendingAnchor.taskId &&
              pendingAnchor.field === "overview"
                ? pendingAnchor.quote
                : undefined
            }
          />
        </div>
      )}

      {malformed && (
        <div className="flex items-center gap-2 rounded-lg bg-sidebar px-4 py-3 text-xs text-muted-foreground">
          <TriangleAlert className="size-3.5 shrink-0" strokeWidth={1.5} />
          <span>
            This session&apos;s <code className="font-mono">tasks.json</code>{" "}
            couldn&apos;t be read. The recording still plays.
          </span>
        </div>
      )}

      {analysis && analysis.tasks.length > 0 ? (
        analysis.tasks.map((task, i) => (
          <TaskListItem
            key={task.id ?? i}
            task={task}
            index={i}
            selected={selected === i}
            onSelect={() => {
              onSelect(i);
              onSeek(task.timestamp); // discussed moment
            }}
            onSeekVisible={() => onSeek(task.screenshot_timestamp)}
            editing={editing}
            baselineTask={baselineById.get(task.id)}
            onChange={(patch) => onTaskChange(i, patch)}
            onDelete={() => onDeleteTask(i)}
            onMoveUp={i > 0 ? () => onMoveTask(i, -1) : undefined}
            onMoveDown={i < taskCount - 1 ? () => onMoveTask(i, 1) : undefined}
            commenting={commenting}
            comments={
              commenting
                ? comments.filter(
                    (c) => c.kind === "anchor" && c.taskId === task.id,
                  )
                : []
            }
            pendingAnchor={pendingAnchor}
          />
        ))
      ) : (
        !editing && (
          <p className="px-1 py-3 text-sm text-muted-foreground">
            {malformed
              ? "No tasks to show."
              : "No tasks were extracted from this recording."}
          </p>
        )
      )}

      {/* TASK-58 — the "add task" affordance, Edit mode only. A restrained, full-
          width dashed-outline ghost button at the end of the list (same dashed
          language as the unanalyzed rows); lightens to the sidebar tone on hover.
          Monochrome, thin Lucide plus, 150ms ease-out (ADR-004/005). */}
      {editing && (
        <button
          type="button"
          onClick={onAddTask}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-sidebar hover:text-foreground active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Plus className="size-4" strokeWidth={1.5} />
          Add task
        </button>
      )}
    </div>
  );
}

// A just-recorded / just-imported session: the recording plays, but nothing has
// been analyzed yet (no tasks.json — ADR-008). Show the player and a prominent
// Analyze CTA instead of a task list. Running/progress/error are surfaced by the
// header button + the AnalyzeStatus strip; the CTA disables while a run is live.
function UnanalyzedBody({
  recording,
  analyze,
  onAnalyze,
  otherAnalyzing,
}: {
  recording: File;
  analyze: AnalyzeState;
  onAnalyze: () => void;
  otherAnalyzing: boolean;
}) {
  const objectUrl = useObjectUrl(recording);
  const running = analyze.status === "running";

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-6 py-10">
        {objectUrl ? (
          <video
            key={objectUrl}
            src={objectUrl}
            controls
            className="aspect-video w-full rounded-md border border-border bg-black"
          />
        ) : (
          <MissingRecording />
        )}

        {/* While this session is analyzing, the header strip already shows the
            progress — so drop the redundant prompt + button here and just play
            the recording. The prompt returns if the run ends without a report. */}
        {!running && (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-medium text-foreground">
                Not analyzed yet
              </h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                The recording is saved. Run analysis to extract tasks,
                screenshots, and a report from it.
              </p>
            </div>
            <Button
              onClick={onAnalyze}
              disabled={otherAnalyzing}
              className="mt-1"
            >
              <Wand strokeWidth={1.5} />
              Analyze recording
            </Button>
            {otherAnalyzing && (
              <p className="text-xs text-muted-foreground">
                Another analysis is running — it&apos;ll be free once that
                finishes.
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function MissingRecording() {
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card text-muted-foreground">
      <FileVideo className="size-6" strokeWidth={1.5} />
      <p className="text-sm">Recording not found</p>
      <p className="text-xs text-muted-foreground/70">
        This session has no <code className="font-mono">recording.webm</code>.
      </p>
    </div>
  );
}

function LoadingBody() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.6fr)_minmax(340px,1fr)]">
      <div className="border-r border-border p-6">
        <Skeleton className="aspect-video w-full rounded-md" />
        <Skeleton className="mt-4 h-3 w-24" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-2 h-3 w-4/5" />
      </div>
      <div className="flex flex-col gap-4 p-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CenteredNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}
