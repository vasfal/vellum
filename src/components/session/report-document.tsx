"use client";

// TASK-68.1 (parent TASK-68) — the interactive report document.
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
// Editing is offered only when `editing` is true (the live run with a parsed
// analysis — see SessionView.canEdit); an archived / malformed run renders the
// same document READ-ONLY (static pills, rendered markdown, no controls) — the
// screenshot + timecode seeks still work.
//
// SEAM (sibling task — do NOT implement here): select-to-comment. Each task
// section carries `data-task-id`; a later commenting layer can resolve a text
// selection back to its task/field from these attributes without re-architecting.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ImageOff,
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
}) {
  const urls = useSessionScreenshots(workspace, name, screenshotsDir, reloadToken);
  const taskCount = analysis?.tasks.length ?? 0;
  // The overview block shows whenever there IS one, or while editing so an empty
  // one can be written; a malformed/overview-less read-only run skips it entirely.
  const showOverview = analysis !== null && (overview !== "" || editing);

  return (
    // The pane is the app background; a centered prose column reads like the
    // document it is (ADR-004). Hairline rules (divide-y) separate the overview and
    // each task — the on-screen echo of report.md's "---" section breaks.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-2xl flex-col divide-y divide-border/60 px-6">
        {showOverview && (
          <section className="flex flex-col gap-2 py-8">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Overview
            </span>
            <DocumentOverview
              overview={overview}
              editing={editing}
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
                baselineTask={baselineById.get(task.id)}
                screenshotUrl={urls.get(task.screenshot ?? "")}
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
  );
}

// The session overview at the top of the document: markdown-aware inline edit when
// editing, rendered markdown when read-only. A quiet edited-marker + revert sits
// beside it (like every other field).
function DocumentOverview({
  overview,
  editing,
  onChange,
  baseline,
}: {
  overview: string;
  editing: boolean;
  onChange: (next: string) => void;
  baseline: string | undefined;
}) {
  if (editing) {
    const edited = baseline !== undefined && overview !== baseline;
    return (
      <div className="group/field flex items-start gap-1">
        <span className="min-w-0 flex-1">
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
  return <MarkdownText text={overview} />;
}

// One task as a document section: numbered heading + title, a meta row (type /
// priority pills + timecode chips), the inline screenshot, the markdown-aware
// description, the screen-context note, and — while editing, on hover — a quiet
// footer rail of reorder / revert / delete controls.
function TaskSection({
  task,
  index,
  editing,
  baselineTask,
  screenshotUrl,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSeek,
}: {
  task: StoredVellumTask;
  index: number;
  editing: boolean;
  /** The AI baseline for this task id — absent for a human-added task. */
  baselineTask?: StoredVellumTask;
  /** Resolved object URL for this task's stored frame, or undefined (no preview). */
  screenshotUrl?: string;
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
    // `data-task-id` is the seam a later select-to-comment layer resolves against
    // (sibling task) — no commenting behavior is wired here.
    <section
      data-task-id={task.id}
      className="group relative flex scroll-mt-4 flex-col gap-3 py-8"
    >
      <div className="flex items-start gap-3">
        <span className="mt-1 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="flex min-w-0 flex-1 items-start gap-1">
          <span className="min-w-0 flex-1">
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
        </span>
      </div>

      {/* Meta row: type + priority pills, then the discussed/visible timecodes.
          All content rows share the section's left edge — same as the number —
          so the number, screenshot and text align down a single left margin. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex shrink-0 items-center gap-1.5">
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
        <span className="min-w-0 flex-1">
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
            <span className="min-w-0 flex-1">
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

      {/* Hover controls (editing only): reorder left; revert-to-AI + delete right.
          opacity-0 at rest so the document reads clean; the row's height is always
          reserved so revealing it never shifts the section. Delete is always
          available while editing, so the rail always renders here. */}
      {editing && (
        <div className="flex items-center justify-between opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 focus-within:opacity-100">
          <div className="flex items-center gap-0.5">
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
          </div>
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
        </div>
      )}
    </section>
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
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-px text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
      className={cn(
        "-mx-1 block w-[calc(100%+0.5rem)] rounded-sm px-1 py-0.5 text-left transition-colors duration-150 ease-out hover:bg-sidebar active:opacity-80",
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

// A quiet reorder / revert icon-button. Thin Lucide glyph, monochrome; a disabled
// end-of-list control dims and stops responding (ADR-004/005).
function ControlIcon({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof ChevronUp;
  onClick?: () => void;
  disabled?: boolean;
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
            className="rounded-sm p-1 text-muted-foreground transition-colors duration-150 ease-out hover:bg-sidebar hover:text-foreground active:opacity-80 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
    <span className="inline-flex items-center gap-0.5 rounded-full border border-border px-2 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
        "inline-flex items-center gap-0.5 rounded-full px-2 py-px text-[10px] font-medium uppercase tracking-wide",
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
