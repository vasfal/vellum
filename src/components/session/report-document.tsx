"use client";

// TASK-68.1 (parent TASK-68) — the interactive report document.
// TASK-68.2 layers Google-Docs-style commenting directly on top of it.
//
// ONE surface replaces the old Tasks/Markdown switcher AND the View/Edit mode
// toggle: the structured tasks.json (overview + each task) rendered as a
// markdown-like reading experience where every field is inline-editable, always —
// no mode. tasks.json stays the source of truth (ADR-025); report.md is still a
// generated export (render-report.ts), re-rendered on each save so the two never
// drift. This is the Google-Docs interaction model: click text and type.
//
//   • Overview + description: markdown-aware inline edit — click to edit the RAW
//     markdown, blur renders it (MarkdownText). Title + screen-context: plain
//     inline text.
//   • Type + priority: small pills; click opens the shared EnumSelect dropdown.
//   • Screenshot: rendered inline from the task's stored frame; clicking it seeks
//     the player to the VISIBLE timecode (screenshot_timestamp).
//   • Timecode chips: discussed (task.timestamp) + visible (screenshot_timestamp),
//     each clickable to seek — the two-seek behavior (ADR-013) preserved.
//   • Per task on hover: reorder, revert-to-AI-baseline, delete.
//
// COMMENTING (TASK-68.2) — always available on the live document (no mode):
//   • Select any text → a floating Comment button → composer → an anchored (field
//     or overview) comment, highlighted in place.
//   • Click a highlighted span → its comment(s) pop up inline (view / edit / delete).
//   • A whole task, or a GROUP of tasks, can be picked (per-task toggle → a floating
//     bar) and commented as one unit; the whole session too (footer button).
//   • Accumulated comments are turned into a new AI run from the footer (revise).
//
// Editing/commenting are offered only when `editing` / `commenting` is true (the
// live run with a parsed analysis — see SessionView.canEdit); an archived / malformed
// run renders the same document READ-ONLY (no controls, no highlights).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  ImageOff,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import type {
  StoredAnalysisResult,
  StoredVellumTask,
} from "@/lib/gemini/stored";
import { CATEGORIES, PRIORITIES } from "@/lib/gemini/schema";
import {
  commentQuote,
  type Comment,
  type CommentTarget,
} from "@/lib/comments/comment";
import { loadScreenshots } from "@/lib/filesystem/report-content";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { EditMarker, EnumSelect, InlineText } from "./inline-edit";
import { MarkdownText } from "./markdown-text";
import {
  CommentComposer,
  CommentFooter,
  CommentThreadPopover,
  SelectionCommentButton,
  TaskSelectionBar,
  commentAnchor,
  hasActiveSelection,
  taskLevelComments,
  useCommentHighlights,
  useDocumentTextSelection,
  type PendingSelection,
  type ReviseUiState,
} from "./comment-mode";

/** The composer's open state: the target it will create + where to anchor it. */
interface ComposerState {
  target: CommentTarget;
  rect: { bottom: number; left: number };
  contextLabel: string;
}

/** The click-to-view thread: which comment ids to show + where. */
interface ThreadState {
  ids: string[];
  rect: { bottom: number; left: number };
}

export function ReportDocument({
  analysis,
  malformed,
  overview,
  editing,
  baselineById,
  overviewBaseline,
  onOverviewChange,
  onTaskChange,
  onAddTask,
  onDeleteTask,
  onMoveTask,
  onSeek,
  workspace,
  name,
  screenshotsDir,
  reloadToken,
  // ---- TASK-68.2 commenting ----
  commenting,
  comments,
  reviseState,
  reviseBlocked,
  onAddComment,
  onEditComment,
  onDeleteComment,
  onProcessComments,
  onReRunWithVideo,
  onCancelRevise,
}: {
  /** The active run's analysis: the live editable draft, or a read-only archive. */
  analysis: StoredAnalysisResult | null;
  /** The active run's tasks.json couldn't be parsed — show a quiet notice. */
  malformed: boolean;
  /** The active overview text (the draft's overview when editing). */
  overview: string;
  /** Inline editing is allowed (the live run with a parsed analysis). */
  editing: boolean;
  /** AI baseline per task id, for the per-field "edited" dots + revert. */
  baselineById: Map<string, StoredVellumTask>;
  /** The AI baseline overview, for the overview's edited marker + revert. */
  overviewBaseline: string | undefined;
  onOverviewChange: (next: string) => void;
  /** Persist a field edit on the task at `index` (autosaved by SessionView). */
  onTaskChange: (index: number, patch: Partial<StoredVellumTask>) => void;
  onAddTask: () => void;
  onDeleteTask: (index: number) => void;
  onMoveTask: (index: number, dir: -1 | 1) => void;
  /** Seek the player to an "mm:ss" moment (discussed / visible). */
  onSeek: (mmss: string | undefined) => void;
  workspace: FileSystemDirectoryHandle;
  name: string;
  /** The active run's frames folder (screenshots/ or screenshots-<stamp>/). */
  screenshotsDir: string;
  /** Bumped after each save so the frame map re-reads if the run changed. */
  reloadToken: number;
  /** Commenting is available (same gate as editing — the live parsed run). */
  commenting: boolean;
  /** All comments for the current version. */
  comments: Comment[];
  /** The comment→AI-revise busy/error state + whether a run blocks starting one. */
  reviseState: ReviseUiState;
  reviseBlocked: boolean;
  /** Create a comment with the given target (autosaved by SessionView). */
  onAddComment: (target: CommentTarget, body: string) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  /** Turn the accumulated comments into a new AI run (text-only / with video). */
  onProcessComments: () => void;
  onReRunWithVideo: () => void;
  onCancelRevise: () => void;
}) {
  const urls = useSessionScreenshots(workspace, name, screenshotsDir, reloadToken);
  const taskCount = analysis?.tasks.length ?? 0;
  // The overview block shows whenever there IS one, or while editing so an empty
  // one can be written; a malformed/overview-less read-only run skips it entirely.
  const showOverview = analysis !== null && (overview !== "" || editing);

  // Tasks in the shape the comment layer resolves anchors + labels against
  // (StoredVellumTask structurally satisfies AnchorTarget).
  const tasks = analysis?.tasks ?? [];

  // ---- commenting interaction state ----------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  // A captured text selection awaiting the floating "Comment" button (step 1).
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(
    null,
  );
  // The composer (step 2) — open for a range / task / group / session comment.
  const [composer, setComposer] = useState<ComposerState | null>(null);
  // The click-to-view thread popover.
  const [thread, setThread] = useState<ThreadState | null>(null);
  // Whole tasks picked for a task / task-group comment.
  const [taskSelection, setTaskSelection] = useState<string[]>([]);

  // Comments currently shown in the thread popover (resolved live so a delete /
  // an external change reflects immediately; empty → the popover is effectively
  // closed).
  const threadComments = thread
    ? comments.filter((c) => thread.ids.includes(c.id))
    : [];
  // The range comment being viewed, so its highlight lifts above the others.
  const openId =
    thread?.ids.find((id) =>
      comments.some((c) => c.id === id && commentQuote(c)),
    ) ?? null;

  // Paint saved range highlights + get a click→comment resolver. Re-runs when the
  // comments, the rendered analysis/overview, or the open comment change.
  const resolveClick = useCommentHighlights(scrollRef, comments, openId, [
    comments,
    analysis,
    overview,
    editing,
    openId,
  ]);

  // Watch for a text selection inside one commentable field → the pending anchor.
  useDocumentTextSelection(commenting, scrollRef, setPendingSelection);

  // Drop the floating Comment button once the selection collapses (a click away),
  // so it doesn't linger with nothing selected.
  useEffect(() => {
    if (!commenting) return;
    const onSel = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setPendingSelection(null);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [commenting]);

  // A click that lands on a highlighted span opens that comment inline. Runs in the
  // CAPTURE phase so it can pre-empt (and stop) the field's own click-to-edit.
  const onClickCapture = useCallback(
    (e: React.MouseEvent) => {
      if (!commenting) return;
      const ids = resolveClick(e.clientX, e.clientY);
      if (ids.length === 0) return;
      e.stopPropagation();
      e.preventDefault();
      setThread({ ids, rect: { bottom: e.clientY, left: e.clientX } });
    },
    [commenting, resolveClick],
  );

  const toggleTaskSelection = useCallback((taskId: string) => {
    setTaskSelection((prev) =>
      prev.includes(taskId)
        ? prev.filter((id) => id !== taskId)
        : [...prev, taskId],
    );
  }, []);

  // Step 2: promote a captured selection into the composer.
  const openComposerFromSelection = useCallback(() => {
    setPendingSelection((sel) => {
      if (sel) {
        setComposer({
          target: sel.target,
          rect: { bottom: sel.rect.bottom, left: sel.rect.left },
          contextLabel: `“${sel.target.quote}”`,
        });
      }
      return null;
    });
  }, []);

  // Open the composer for the whole-task / task-group selection, anchored centrally.
  const openComposerFromTasks = useCallback(() => {
    setTaskSelection((ids) => {
      if (ids.length > 0) {
        const target: CommentTarget =
          ids.length === 1
            ? { type: "task", taskId: ids[0] }
            : { type: "tasks", taskIds: ids };
        setComposer({
          target,
          rect: {
            bottom: window.innerHeight - 72,
            left: Math.max(12, window.innerWidth / 2 - 170),
          },
          contextLabel:
            ids.length === 1 ? "This task" : `${ids.length} tasks`,
        });
      }
      return ids; // keep the selection until the comment is saved
    });
  }, []);

  // The footer "Comment on session" button opens the composer for a global comment.
  const openSessionComposer = useCallback(
    (rect: { bottom: number; left: number }) => {
      setComposer({
        target: { type: "global" },
        rect,
        contextLabel: "Comment on the whole session",
      });
    },
    [],
  );

  const submitComposer = useCallback(
    (body: string) => {
      if (!composer) return;
      onAddComment(composer.target, body);
      setComposer(null);
      setTaskSelection([]);
      window.getSelection()?.removeAllRanges();
    },
    [composer, onAddComment],
  );

  // Open the thread popover for a whole task's task-level comments (its badge).
  const openTaskComments = useCallback(
    (taskId: string, rect: { bottom: number; left: number }) => {
      const ids = taskLevelComments(comments, taskId).map((c) => c.id);
      if (ids.length > 0) setThread({ ids, rect });
    },
    [comments],
  );

  return (
    // Outer column: the scrolling document over a (commenting-only) sticky footer.
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        ref={scrollRef}
        onClickCapture={onClickCapture}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          // Tint the live selection with the comment-highlight yellow while
          // commenting, so "the span I'm about to comment" reads as the same signal
          // as the saved highlights (scoped, so default selection is untouched).
          commenting && "comment-selection",
        )}
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col divide-y divide-border/60 px-6">
          {showOverview && (
            <section className="flex flex-col gap-2 py-8">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Overview
              </span>
              <DocumentOverview
                overview={overview}
                editing={editing}
                commenting={commenting}
                onChange={onOverviewChange}
                baseline={overviewBaseline}
              />
            </section>
          )}

          {malformed && (
            <div className="py-8">
              <div className="flex items-center gap-2 rounded-lg bg-sidebar px-4 py-3 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5 shrink-0" strokeWidth={1.5} />
                <span>
                  This session&apos;s <code className="font-mono">tasks.json</code>{" "}
                  couldn&apos;t be read. The recording still plays.
                </span>
              </div>
            </div>
          )}

          {analysis && analysis.tasks.length > 0
            ? analysis.tasks.map((task, i) => (
                <TaskSection
                  key={task.id ?? i}
                  task={task}
                  index={i}
                  editing={editing}
                  commenting={commenting}
                  baselineTask={baselineById.get(task.id)}
                  screenshotUrl={urls.get(task.screenshot ?? "")}
                  taskComments={
                    commenting ? taskLevelComments(comments, task.id) : []
                  }
                  selectedForComment={taskSelection.includes(task.id)}
                  onToggleCommentSelect={() => toggleTaskSelection(task.id)}
                  onOpenTaskComments={(rect) => openTaskComments(task.id, rect)}
                  onChange={(patch) => onTaskChange(i, patch)}
                  onDelete={() => onDeleteTask(i)}
                  onMoveUp={i > 0 ? () => onMoveTask(i, -1) : undefined}
                  onMoveDown={
                    i < taskCount - 1 ? () => onMoveTask(i, 1) : undefined
                  }
                  onSeek={onSeek}
                />
              ))
            : !editing && (
                <p className="py-8 text-sm text-muted-foreground">
                  {malformed
                    ? "No tasks to show."
                    : "No tasks were extracted from this recording."}
                </p>
              )}

          {editing && (
            <div className="py-8">
              {/* Add a blank task at the end — a restrained dashed-outline ghost
                  button, the same language as the unanalyzed-session rows. */}
              <button
                type="button"
                onClick={onAddTask}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out hover:bg-sidebar hover:text-foreground active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Plus className="size-4" strokeWidth={1.5} />
                Add task
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Commenting footer — the session-comment affordance + the revise controls. */}
      {commenting && (
        <CommentFooter
          commentCount={comments.length}
          state={reviseState}
          blocked={reviseBlocked}
          onSessionComment={openSessionComposer}
          onProcess={onProcessComments}
          onReRunWithVideo={onReRunWithVideo}
          onCancel={onCancelRevise}
        />
      )}

      {/* Floating commenting UI (portaled to body). */}
      {commenting && pendingSelection && !composer && (
        <SelectionCommentButton
          rect={pendingSelection.rect}
          onClick={openComposerFromSelection}
        />
      )}
      {commenting && composer && (
        <CommentComposer
          rect={composer.rect}
          contextLabel={composer.contextLabel}
          onSave={submitComposer}
          onCancel={() => setComposer(null)}
        />
      )}
      {commenting && thread && threadComments.length > 0 && (
        <CommentThreadPopover
          rect={thread.rect}
          comments={threadComments}
          tasks={tasks}
          overview={overview}
          onEdit={onEditComment}
          onDelete={onDeleteComment}
          onClose={() => setThread(null)}
        />
      )}
      {commenting && taskSelection.length > 0 && !composer && (
        <TaskSelectionBar
          count={taskSelection.length}
          onComment={openComposerFromTasks}
          onClear={() => setTaskSelection([])}
        />
      )}
    </div>
  );
}

// The session overview at the top of the document: markdown-aware inline edit when
// editing, rendered markdown when read-only. A quiet edited-marker + revert sits
// beside it. While commenting, the rendered block carries the comment anchor so a
// text selection resolves to an `overview` range.
function DocumentOverview({
  overview,
  editing,
  commenting,
  onChange,
  baseline,
}: {
  overview: string;
  editing: boolean;
  commenting: boolean;
  onChange: (next: string) => void;
  baseline: string | undefined;
}) {
  if (editing) {
    const edited = baseline !== undefined && overview !== baseline;
    return (
      <div className="group/field flex items-start gap-1">
        <span
          className="min-w-0 flex-1"
          data-comment-anchor={
            commenting ? commentAnchor("overview", "overview") : undefined
          }
        >
          <InlineMarkdown
            value={overview}
            ariaLabel="Session overview"
            placeholder="Add an overview."
            onCommit={onChange}
          />
        </span>
        <span className="mt-1.5">
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
  // Read-only: the gate above only renders this block when overview is non-empty.
  return (
    <span
      data-comment-anchor={
        commenting ? commentAnchor("overview", "overview") : undefined
      }
    >
      <MarkdownText text={overview} />
    </span>
  );
}

// One task as a document section: numbered heading + title, a meta row (type /
// priority pills + timecode chips), the inline screenshot, the markdown-aware
// description, the screen-context note, and — while editing / commenting, on hover —
// a quiet footer rail of comment / reorder / revert / delete controls.
function TaskSection({
  task,
  index,
  editing,
  commenting,
  baselineTask,
  screenshotUrl,
  taskComments,
  selectedForComment,
  onToggleCommentSelect,
  onOpenTaskComments,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSeek,
}: {
  task: StoredVellumTask;
  index: number;
  editing: boolean;
  commenting: boolean;
  /** The AI baseline for this task id — absent for a human-added task. */
  baselineTask?: StoredVellumTask;
  /** Resolved object URL for this task's stored frame, or undefined (no preview). */
  screenshotUrl?: string;
  /** Whole-task / group comments attached to THIS task (for its badge). */
  taskComments: Comment[];
  /** This task is picked for a task / task-group comment. */
  selectedForComment: boolean;
  onToggleCommentSelect: () => void;
  onOpenTaskComments: (rect: { bottom: number; left: number }) => void;
  onChange: (patch: Partial<StoredVellumTask>) => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onSeek: (mmss: string | undefined) => void;
}) {
  // A field is "edited" only when a baseline exists AND the value differs. No
  // baseline (human task / none captured yet) → never edited.
  const changed = <K extends keyof StoredVellumTask>(field: K): boolean =>
    baselineTask !== undefined && task[field] !== baselineTask[field];

  const taskEdited =
    baselineTask !== undefined &&
    (changed("title") ||
      changed("description") ||
      changed("screen_context") ||
      changed("category") ||
      changed("priority"));

  const revertTask = () => {
    if (!baselineTask) return;
    onChange({
      title: baselineTask.title,
      description: baselineTask.description,
      screen_context: baselineTask.screen_context,
      category: baselineTask.category,
      priority: baselineTask.priority,
    });
  };

  // The dropdown chevron tucked INSIDE the enum pill as a trailing affordance.
  const chevron = (
    <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={1.5} />
  );

  return (
    // `data-task-id` is the section identity the commenting layer reads. A selected-
    // for-comment task takes a quiet inset ring so it's clear what a group comment
    // will cover.
    <section
      data-task-id={task.id}
      className={cn(
        "group relative flex scroll-mt-4 flex-col gap-3 py-8",
        selectedForComment &&
          "rounded-lg ring-1 ring-inset ring-foreground/25",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-1 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="flex min-w-0 flex-1 items-start gap-1">
          <span
            className="min-w-0 flex-1"
            data-comment-anchor={
              commenting ? commentAnchor(task.id, "title") : undefined
            }
          >
            {editing ? (
              <InlineText
                value={task.title}
                ariaLabel="Task title"
                className="text-base font-semibold leading-snug tracking-tight text-foreground"
                onCommit={(next) => onChange({ title: next })}
              />
            ) : (
              <span className="text-base font-semibold leading-snug tracking-tight text-foreground">
                {task.title}
              </span>
            )}
          </span>
          {editing && changed("title") && <FieldDot />}
          {commenting && taskComments.length > 0 && (
            <TaskCommentBadge
              count={taskComments.length}
              onOpen={onOpenTaskComments}
            />
          )}
        </span>
      </div>

      {/* Meta row: type + priority pills, then the discussed/visible timecodes.
          All content rows share the section's left edge — same as the number —
          so the number, screenshot and text align down a single left margin. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* text-[10px] leading-none so the EnumSelect trigger buttons wrapping the
            pills don't inherit the document's 16px/24px line box — that tall line
            box baseline-shifted the pills ~2px below the bare timecode badges. */}
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] leading-none">
          {editing ? (
            <>
              <EnumSelect
                value={task.category}
                options={CATEGORIES}
                ariaLabel="Task type"
                renderPill={(c, opts) => (
                  <Pill trailing={opts?.trigger ? chevron : undefined}>{c}</Pill>
                )}
                onChange={(next) => onChange({ category: next })}
              />
              {changed("category") && <FieldDot />}
              <EnumSelect
                value={task.priority}
                options={PRIORITIES}
                ariaLabel="Task priority"
                renderPill={(p, opts) => (
                  <PriorityPill
                    priority={p}
                    trailing={opts?.trigger ? chevron : undefined}
                  />
                )}
                onChange={(next) => onChange({ priority: next })}
              />
              {changed("priority") && <FieldDot />}
            </>
          ) : (
            <>
              <Pill>{task.category}</Pill>
              <PriorityPill priority={task.priority} />
            </>
          )}
        </span>
        <Timecodes
          timestamp={task.timestamp}
          screenshotTimestamp={task.screenshot_timestamp}
          onSeek={onSeek}
        />
      </div>

      {/* The extracted frame, inline. Clicking it seeks to where it's visible. */}
      <div>
        <TaskScreenshot
          url={screenshotUrl}
          alt={task.title}
          onSeek={() => onSeek(task.screenshot_timestamp)}
          canSeek={Boolean(task.screenshot_timestamp)}
        />
      </div>

      {/* Description — markdown-aware inline edit (raw on click, rendered on blur). */}
      <div className="flex items-start gap-1">
        <span
          className="min-w-0 flex-1"
          data-comment-anchor={
            commenting ? commentAnchor(task.id, "description") : undefined
          }
        >
          {editing ? (
            <InlineMarkdown
              value={task.description}
              ariaLabel="Task description"
              onCommit={(next) => onChange({ description: next })}
            />
          ) : (
            <MarkdownText text={task.description} />
          )}
        </span>
        {editing && changed("description") && <FieldDot />}
      </div>

      {/* Screen context — a quieter note; plain inline text (not markdown). A
          human-added task may carry none (undefined) → the row is skipped. */}
      {task.screen_context !== undefined && (
        <div className="flex items-start gap-1 text-xs leading-relaxed text-muted-foreground/80">
          <span className="shrink-0 py-0.5 text-muted-foreground/60">
            Screen —
          </span>
          <span
            className="min-w-0 flex-1"
            data-comment-anchor={
              commenting ? commentAnchor(task.id, "screen_context") : undefined
            }
          >
            {editing ? (
              <InlinePlainText
                value={task.screen_context}
                ariaLabel="On-screen context"
                className="text-xs leading-relaxed text-muted-foreground/80"
                onCommit={(next) => onChange({ screen_context: next })}
              />
            ) : (
              <span>{task.screen_context}</span>
            )}
          </span>
          {editing && changed("screen_context") && <FieldDot />}
        </div>
      )}

      {/* Hover controls (editing / commenting): the comment toggle on the left,
          reorder + revert-to-AI + delete on the right. opacity-0 at rest so the
          document reads clean; a selected-for-comment task keeps its toggle visible. */}
      {(editing || commenting) && (
        <div
          className={cn(
            "flex items-center justify-between transition-opacity duration-150 ease-out group-hover:opacity-100 focus-within:opacity-100",
            selectedForComment ? "opacity-100" : "opacity-0",
          )}
        >
          <div className="flex items-center gap-0.5">
            {commenting && (
              <ControlIcon
                label={
                  selectedForComment
                    ? "Remove from comment selection"
                    : "Select task to comment"
                }
                icon={MessageSquarePlus}
                onClick={onToggleCommentSelect}
                active={selectedForComment}
              />
            )}
            {editing && (
              <>
                <ControlIcon
                  label="Move up"
                  icon={ChevronUp}
                  onClick={onMoveUp}
                  disabled={!onMoveUp}
                />
                <ControlIcon
                  label="Move down"
                  icon={ChevronDown}
                  onClick={onMoveDown}
                  disabled={!onMoveDown}
                />
              </>
            )}
          </div>
          {editing && (
            <div className="flex items-center gap-0.5">
              {taskEdited && (
                <ControlIcon
                  label="Revert to AI"
                  icon={RotateCcw}
                  onClick={revertTask}
                />
              )}
              <DeleteControl title={task.title} onDelete={onDelete} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// The whole-task / group comment badge beside a task title: a small count that opens
// the thread popover on the task-level comments attached here.
function TaskCommentBadge({
  count,
  onOpen,
}: {
  count: number;
  onOpen: (rect: { bottom: number; left: number }) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onOpen({ bottom: r.bottom, left: r.left });
      }}
      aria-label={`${count} ${count === 1 ? "comment" : "comments"} on this task`}
      className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] font-medium leading-none text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground active:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <MessageSquare className="size-3" strokeWidth={1.5} />
      {count}
    </button>
  );
}

// The discussed/visible timecode chips (ADR-013). Each is its own seek button —
// discussed → task.timestamp, visible → screenshot_timestamp — so the two moments
// stay distinct. A task with neither (a human task with no moment) renders nothing.
function Timecodes({
  timestamp,
  screenshotTimestamp,
  onSeek,
}: {
  timestamp?: string;
  screenshotTimestamp?: string;
  onSeek: (mmss: string | undefined) => void;
}) {
  if (!timestamp && !screenshotTimestamp) return null;
  return (
    <div className="flex items-center gap-1.5">
      {timestamp && (
        <TimecodeButton
          label="discussed"
          value={timestamp}
          tooltip="Jump to where this was discussed"
          onClick={() => onSeek(timestamp)}
        />
      )}
      {screenshotTimestamp && (
        <TimecodeButton
          label="visible"
          value={screenshotTimestamp}
          tooltip="Jump to where this is visible"
          onClick={() => onSeek(screenshotTimestamp)}
        />
      )}
    </div>
  );
}

// A timecode reads as a badge (matching the type/priority pills) rather than
// loose mono text, but stays a seek button: a small uppercase label + the mono
// mm:ss, in a bordered chip that warms on hover.
function TimecodeButton({
  label,
  value,
  tooltip,
  onClick,
}: {
  label: string;
  value: string;
  tooltip: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-px text-[10px] leading-none text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        <span className="font-medium uppercase tracking-wide">{label}</span>
        <span className="font-mono tabular-nums">{value}</span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// The inline screenshot. Always clickable (edit or read-only) to seek the player
// to where the issue is visible; a task with no stored frame (or a dropped file)
// degrades to a quiet placeholder rather than a broken image (ADR-013).
function TaskScreenshot({
  url,
  alt,
  onSeek,
  canSeek,
}: {
  url?: string;
  alt: string;
  onSeek: () => void;
  /** There's a visible timecode to seek to — otherwise the frame isn't clickable. */
  canSeek: boolean;
}) {
  if (!url) {
    return (
      <span className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-card text-muted-foreground">
        <ImageOff className="size-5" strokeWidth={1.5} />
        <span className="px-4 text-center text-xs text-muted-foreground/70">
          No preview
        </span>
      </span>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- object URL from a local File, not a remote asset next/image can optimize
    <img
      src={url}
      alt={alt}
      className="w-full rounded-md border border-border"
    />
  );

  if (!canSeek) return image;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onSeek}
            className="group/shot block w-full overflow-hidden rounded-md transition-opacity duration-150 ease-out hover:opacity-90 active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        {image}
      </TooltipTrigger>
      <TooltipContent>Jump to where this is visible</TooltipContent>
    </Tooltip>
  );
}

// A markdown-aware inline field (description, overview): the RAW markdown is edited
// in an auto-growing textarea (click to enter, Cmd/Ctrl+Enter or blur to commit,
// Escape to cancel, empty/unchanged keeps the prior value), and the resting state
// renders that markdown. A role="button" wrapper (not a real <button>) so the
// rendered block content — <p>, lists — stays valid HTML.
function InlineMarkdown({
  value,
  onCommit,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  /** Shown (muted) when the value is empty and not editing — e.g. an empty overview. */
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  const start = () => {
    // Don't hijack a text selection meant for commenting (TASK-68.2).
    if (hasActiveSelection()) return;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return; // empty/unchanged → keep prior value
    onCommit(next);
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        autoFocus
        rows={1}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="block w-full resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-muted-foreground outline-none focus:border-foreground/30"
      />
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={start}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          start();
        }
      }}
      className="-mx-2 cursor-text rounded-md px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-sidebar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {value ? (
        <MarkdownText text={value} />
      ) : (
        <span className="text-[13px] text-muted-foreground/50">{placeholder}</span>
      )}
    </div>
  );
}

// A single-line plain (non-markdown) inline field (screen context). Enter or blur
// commits; Escape cancels; empty/unchanged keeps the prior value. Mirrors the
// InlineText primitive but auto-grows across lines for a longer note.
function InlinePlainText({
  value,
  onCommit,
  ariaLabel,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  const start = () => {
    // Don't hijack a text selection meant for commenting (TASK-68.2).
    if (hasActiveSelection()) return;
    setDraft(value);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === value) return;
    onCommit(next);
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        autoFocus
        rows={1}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className={cn(
          "block w-full resize-none rounded-sm border border-border bg-transparent px-1 py-0.5 outline-none focus:border-foreground/30",
          className,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      // select-text so a drag-select of this note can become a comment (TASK-68.2).
      className={cn(
        "-mx-1 block w-[calc(100%+0.5rem)] select-text rounded-sm px-1 py-0.5 text-left transition-colors duration-150 ease-out hover:bg-sidebar active:opacity-80",
        className,
      )}
    >
      {value}
    </button>
  );
}

// The quiet per-field "edited" indicator: a small muted dot marking a field whose
// value differs from its AI baseline. Pure signal — the revert is a task-level
// control in the footer rail. Its top margin lines the dot up with the first line.
function FieldDot() {
  return (
    <span
      className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50"
      aria-hidden
    />
  );
}

// A quiet comment / reorder / revert icon-button. Thin Lucide glyph, monochrome; a
// disabled end-of-list control dims and stops responding (ADR-004/005). `active`
// keeps a toggled control (the comment-select) at full contrast.
function ControlIcon({
  label,
  icon: Icon,
  onClick,
  disabled,
  active,
}: {
  label: string;
  icon: typeof ChevronUp;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "rounded-sm p-1 transition-colors duration-150 ease-out hover:bg-sidebar hover:text-foreground active:opacity-80 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          />
        }
      >
        <Icon className="size-4" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// The per-task delete control + its confirmation. Reuses the same destructive
// Dialog pattern as the session delete so the confirm reads consistently. Deleting
// is instant + autosaved by the parent — no pending spinner; the section vanishes.
function DeleteControl({
  title,
  onDelete,
}: {
  title: string;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Delete task"
              className="rounded-sm p-1 text-muted-foreground transition-colors duration-150 ease-out hover:bg-destructive/10 hover:text-destructive active:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          }
        >
          <Trash2 className="size-4" strokeWidth={1.5} />
        </TooltipTrigger>
        <TooltipContent>Delete task</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{title}”?</DialogTitle>
            <DialogDescription>
              This removes the task from this analysis. Can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                onDelete();
                setOpen(false);
              }}
            >
              <Trash2 strokeWidth={1.5} />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// A thin monochrome pill (the task's type). Outlined, uppercase, tracked — a label,
// not a colored chip. `trailing` tucks the EnumSelect dropdown chevron INSIDE it.
function Pill({
  children,
  trailing,
}: {
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-border px-2 py-px text-[10px] font-medium uppercase leading-none tracking-wide text-muted-foreground">
      {children}
      {trailing}
    </span>
  );
}

// ADR-018 — priority is the one place hue is allowed (a restrained exception to
// ADR-004's monochrome). Filled but muted: high = soft brick red, med = soft amber,
// low stays a neutral gray. Token-based so both themes hold (ADR-019).
const PRIORITY_STYLES: Record<StoredVellumTask["priority"], string> = {
  high: "bg-[var(--priority-high)] text-[var(--priority-high-foreground)]",
  med: "bg-[var(--priority-med)] text-[var(--priority-med-foreground)]",
  low: "bg-secondary text-secondary-foreground",
};

function PriorityPill({
  priority,
  trailing,
}: {
  priority: StoredVellumTask["priority"];
  trailing?: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-2 py-px text-[10px] font-medium uppercase leading-none tracking-wide",
        PRIORITY_STYLES[priority],
      )}
    >
      {priority}
      {trailing}
    </span>
  );
}

// Load the active run's frames as filename→object-URL, revoking the URLs when the
// file set changes or the pane unmounts (the useObjectUrl pattern, for a whole
// Map). Re-reads when the session, the selected run's screenshots folder, or a save
// (reloadToken) changes. Mirrors the removed ReportView's screenshot resolution.
function useSessionScreenshots(
  workspace: FileSystemDirectoryHandle,
  name: string,
  screenshotsDir: string,
  reloadToken: number,
): Map<string, string> {
  const [files, setFiles] = useState<Map<string, File>>(() => new Map());

  useEffect(() => {
    let cancelled = false;
    loadScreenshots(workspace, name, screenshotsDir)
      .then((map) => {
        if (!cancelled) setFiles(map);
      })
      .catch(() => {
        // A missing/unreadable folder degrades to no previews rather than crashing.
        if (!cancelled) setFiles(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, name, screenshotsDir, reloadToken]);

  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    const next = new Map<string, string>();
    for (const [key, file] of files) next.set(key, URL.createObjectURL(file));
    setUrls(next);
    return () => {
      for (const url of next.values()) URL.revokeObjectURL(url);
    };
  }, [files]);

  return urls;
}
