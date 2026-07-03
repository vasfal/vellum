"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";

import type { StoredVellumTask } from "@/lib/gemini/stored";
import type { Comment } from "@/lib/comments/comment";
import { CATEGORIES, PRIORITIES } from "@/lib/gemini/schema";
import {
  CommentableText,
  taskCardDomId,
  type PendingAnchor,
} from "./comment-mode";
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
import {
  EnumSelect,
  InlineText,
  InlineTextarea,
} from "./inline-edit";

// TASK-17/18 — one task in the session view's list. Renders the contract fields
// (title, category, priority, discussed/visible timestamps, description,
// screen_context). The extracted screenshots are intentionally NOT shown here
// (TASK-33 follow-up): the thumbnails were too small to read; the frames still
// live in the report / Markdown view at full size.
//
// TASK-33 — the card is a padded, rounded shape on the sidebar surface: no
// divider lines (sibling cards are separated by a gap, see TaskListPane), hover
// fills the card with the sidebar's hover tone, matching the sessions sidebar.
//
// Two seek affordances (ADR-013), by design distinct:
//   • clicking the row selects it AND seeks the player to where it was *discussed*
//   • clicking the "visible" timestamp seeks to where the issue is *visible*
// The screenshot used to own the visible-seek; with the thumbnail gone that seek
// moves onto the "visible" timestamp. To keep valid, accessible HTML we DON'T
// nest buttons: the row's primary action is a full-bleed overlay <button> (z-0);
// the "visible" seek is its own <button> layered above (z-10); the rest of the
// text is pointer-events-none so its clicks fall through to the overlay.
//
// Aesthetic: monochrome throughout (hierarchy from contrast and typography) with
// ONE deliberate exception — priority carries a muted, low-chroma hue (TASK-33
// AC#7, a restrained departure from ADR-004; category stays monochrome).
// Timestamps are Geist Mono (font-mono). Motion per ADR-005 — ease-out, 150ms.

export function TaskListItem({
  task,
  index,
  selected,
  onSelect,
  onSeekVisible,
  editing = false,
  baselineTask,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  commenting = false,
  comments = [],
  pendingAnchor = null,
}: {
  task: StoredVellumTask;
  index: number;
  selected: boolean;
  /** Select the row + seek the player to the discussed moment. */
  onSelect: () => void;
  /** Seek the player to the moment the issue is visible (the extracted frame). */
  onSeekVisible: () => void;
  /** TASK-57 — Edit mode: fields become inline-editable in place. */
  editing?: boolean;
  /** TASK-59 — Comment mode: fields become selectable + show comment highlights. */
  commenting?: boolean;
  /** This task's comments (already filtered by taskId), for the highlights. */
  comments?: Comment[];
  /** The OPEN composer's anchor — when it targets a field of THIS task, that field
   *  shows its pending yellow highlight on the page (resolves to saved on save,
   *  vanishes on cancel). Null when no composer is open. */
  pendingAnchor?: PendingAnchor | null;
  /** The AI baseline for this task id, for the "edited" markers + revert. Absent
   *  for a human-added task (origin "human", no baseline) → no markers/revert. */
  baselineTask?: StoredVellumTask;
  /** Persist a field edit (autosaved by the parent). Required when `editing`. */
  onChange?: (patch: Partial<StoredVellumTask>) => void;
  /** TASK-58 — delete this task (Edit mode; confirmed inside the card). */
  onDelete?: () => void;
  /** TASK-58 — move this task up/down. Undefined at the list ends (disables it). */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  if (editing && onChange) {
    return (
      <EditingCard
        task={task}
        index={index}
        baselineTask={baselineTask}
        onChange={onChange}
        onDelete={onDelete}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
    );
  }

  if (commenting) {
    return (
      <CommentingCard
        task={task}
        index={index}
        comments={comments}
        pendingAnchor={pendingAnchor}
      />
    );
  }

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-xl bg-background p-4",
        // Rest = the app background black (blends into the pane); hover/selected
        // LIGHTEN to the sidebar gray so the active row reads by going lighter.
        "transition-colors duration-150 ease-out hover:bg-sidebar",
        selected && "bg-sidebar ring-1 ring-inset ring-foreground/10",
      )}
    >
      {/* Primary action, full-bleed so the whole card is one target. Not wrapping
          the content (which holds its own "visible" seek button) keeps the HTML
          valid — no button nested in a button. Rounded to match the card so the
          focus ring and :active fill hug its corners. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-pressed={selected}
              onClick={onSelect}
              className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-sidebar"
            />
          }
        >
          <span className="sr-only">
            Select task {index + 1}: {task.title}. Jumps to where it was discussed.
          </span>
        </TooltipTrigger>
        <TooltipContent>Jump to where this was discussed</TooltipContent>
      </Tooltip>

      {/* Text column. pointer-events-none so clicks fall through to the overlay
          button above; the "visible" seek (a real button) re-enables pointers. */}
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
            {task.title}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Pill>{task.category}</Pill>
            <PriorityPill priority={task.priority} />
          </span>
        </div>

        {/* Discussed vs visible — mono. "discussed" falls through to the row
            overlay (which seeks it); "visible" is its own seek button. A human
            task (TASK-58) may carry neither moment — skip the row when it has
            none rather than render empty "discussed"/"visible" labels. */}
        {(task.timestamp || task.screenshot_timestamp) && (
          <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
            {task.timestamp && <span>discussed {task.timestamp}</span>}
            {task.timestamp && task.screenshot_timestamp && (
              <span aria-hidden className="text-border">
                ·
              </span>
            )}
            {task.screenshot_timestamp && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onSeekVisible}
                      className="pointer-events-auto rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  }
                >
                  visible {task.screenshot_timestamp}
                </TooltipTrigger>
                <TooltipContent>Jump to where this is visible</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}

        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {task.description}
        </p>

        {task.screen_context && (
          <p className="text-xs leading-relaxed text-muted-foreground/80">
            <span className="text-muted-foreground/60">Screen — </span>
            {task.screen_context}
          </p>
        )}
      </div>
    </div>
  );
}

// TASK-59 (ADR-024) — the Comment-mode form of a task card: read-only like the
// view card, but WITHOUT the full-bleed seek overlay (so the text is selectable)
// and with its fields wrapped in CommentableText (data-attrs for anchoring + quiet
// highlights on commented spans). Carries a DOM id so a comment click can scroll
// to it. Category/priority/timestamps stay plain read-only context.
function CommentingCard({
  task,
  index,
  comments,
  pendingAnchor,
}: {
  task: StoredVellumTask;
  index: number;
  comments: Comment[];
  pendingAnchor?: PendingAnchor | null;
}) {
  const forField = (field: Comment["field"]) =>
    comments.filter((c) => c.kind === "anchor" && c.field === field);
  // The pending (in-progress) quote for a field — only when the open composer's
  // anchor is on THIS task's field. Renders as the same yellow as saved highlights.
  const pendingFor = (field: Comment["field"]) =>
    pendingAnchor &&
    pendingAnchor.taskId === task.id &&
    pendingAnchor.field === field
      ? pendingAnchor.quote
      : undefined;

  return (
    <div
      id={taskCardDomId(task.id)}
      className="group relative flex scroll-mt-4 flex-col gap-1.5 rounded-xl bg-background p-4 transition-colors duration-150 ease-out"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground">
            <CommentableText
              text={task.title}
              taskId={task.id}
              field="title"
              comments={forField("title")}
              pendingQuote={pendingFor("title")}
            />
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Pill>{task.category}</Pill>
            <PriorityPill priority={task.priority} />
          </span>
        </div>

        {(task.timestamp || task.screenshot_timestamp) && (
          <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
            {task.timestamp && <span>discussed {task.timestamp}</span>}
            {task.timestamp && task.screenshot_timestamp && (
              <span aria-hidden className="text-border">
                ·
              </span>
            )}
            {task.screenshot_timestamp && (
              <span>visible {task.screenshot_timestamp}</span>
            )}
          </div>
        )}

        <p className="text-[13px] leading-relaxed text-muted-foreground">
          <CommentableText
            text={task.description}
            taskId={task.id}
            field="description"
            comments={forField("description")}
            pendingQuote={pendingFor("description")}
          />
        </p>

        {task.screen_context && (
          <p className="text-xs leading-relaxed text-muted-foreground/80">
            <span className="text-muted-foreground/60">Screen — </span>
            <CommentableText
              text={task.screen_context}
              taskId={task.id}
              field="screen_context"
              comments={forField("screen_context")}
              pendingQuote={pendingFor("screen_context")}
            />
          </p>
        )}
      </div>
    </div>
  );
}

// TASK-57 (ADR-024) — the Edit-mode form of a task card: every field is inline-
// editable in place (title/description/screen_context as text, category/priority as
// enum dropdowns). No full-bleed seek overlay here (the view-mode row's job) — the
// card holds real inputs, so clicks must land on them.
//
// v1.1 polish: the card is TRANSPARENT (no filled surface) but keeps its hairline
// ring (ring-foreground/5) so it still reads as an outlined card while editing —
// the fields sit on the pane, framed but unfilled. A field changed from its AI
// baseline shows a quiet dot as
// a pure indicator (no per-field revert anymore); reverting is a single TASK-level
// action in the footer, left of delete, that restores every field to the baseline.
// A human-added task has no baseline entry (baselineTask undefined) → no dots, no
// revert.
function EditingCard({
  task,
  index,
  baselineTask,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  task: StoredVellumTask;
  index: number;
  baselineTask?: StoredVellumTask;
  onChange: (patch: Partial<StoredVellumTask>) => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  // A field is "edited" only when a baseline exists AND the current value differs
  // from it. No baseline (human task, or none captured yet) → never edited.
  const changed = <K extends keyof StoredVellumTask>(field: K): boolean =>
    baselineTask !== undefined && task[field] !== baselineTask[field];

  // The whole task diverges from its AI baseline (any editable field). Drives the
  // single task-level "revert to AI" control in the footer.
  const taskEdited =
    baselineTask !== undefined &&
    (changed("title") ||
      changed("description") ||
      changed("screen_context") ||
      changed("category") ||
      changed("priority"));

  // Revert every editable field of this task to its AI baseline in one patch
  // (autosaved by the parent like any other edit). Guarded by taskEdited so the
  // control only shows when there IS a baseline to restore.
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

  // The dropdown chevron, tucked INSIDE the enum pill as a trailing affordance.
  const chevron = (
    <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={1.5} />
  );

  return (
    <div className="group/card relative flex flex-col gap-1.5 rounded-xl bg-transparent p-4 ring-1 ring-inset ring-foreground/5">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <span className="mt-1 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="flex min-w-0 flex-1 items-start gap-1">
            <span className="min-w-0 flex-1">
              <InlineText
                value={task.title}
                ariaLabel="Task title"
                className="text-sm font-medium leading-snug text-foreground"
                onCommit={(next) => onChange({ title: next })}
              />
            </span>
            {changed("title") && <FieldDot />}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <EnumSelect
              value={task.category}
              options={CATEGORIES}
              ariaLabel="Task category"
              renderPill={(c, opts) => (
                <Pill trailing={opts?.trigger ? chevron : undefined}>{c}</Pill>
              )}
              onChange={(next) => onChange({ category: next })}
            />
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
          </span>
        </div>

        {/* Timestamps stay read-only context in Edit mode (not user-editable). */}
        {(task.timestamp || task.screenshot_timestamp) && (
          <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground">
            {task.timestamp && <span>discussed {task.timestamp}</span>}
            {task.timestamp && task.screenshot_timestamp && (
              <span aria-hidden className="text-border">
                ·
              </span>
            )}
            {task.screenshot_timestamp && (
              <span>visible {task.screenshot_timestamp}</span>
            )}
          </div>
        )}

        <div className="flex items-start gap-1">
          <span className="min-w-0 flex-1">
            <InlineTextarea
              value={task.description}
              ariaLabel="Task description"
              className="text-[13px] leading-relaxed text-muted-foreground"
              onCommit={(next) => onChange({ description: next })}
            />
          </span>
          {changed("description") && <FieldDot />}
        </div>

        {task.screen_context !== undefined && (
          <div className="flex items-start gap-1 text-xs leading-relaxed text-muted-foreground/80">
            {/* py-0.5 matches the InlineTextarea button's padding, so "Screen —"
                and the value share the same first-line baseline. */}
            <span className="shrink-0 py-0.5 text-muted-foreground/60">
              Screen —
            </span>
            <span className="min-w-0 flex-1">
              <InlineTextarea
                value={task.screen_context}
                ariaLabel="On-screen context"
                className="text-xs leading-relaxed text-muted-foreground/80"
                onCommit={(next) => onChange({ screen_context: next })}
              />
            </span>
            {changed("screen_context") && <FieldDot />}
          </div>
        )}
      </div>

      {/* TASK-58 — structural controls: reorder (up/down) on the left; revert-to-AI
          then delete on the right. Quiet by default (muted, low opacity), brighten
          on card hover / focus — a Linear-quiet rail, not a toolbar. The footer
          space is reserved so hovering never shifts the card's height. */}
      {(onMoveUp || onMoveDown || onDelete || taskEdited) && (
        <div className="mt-1 flex items-center justify-between opacity-60 transition-opacity duration-150 ease-out group-hover/card:opacity-100 focus-within:opacity-100">
          <div className="flex items-center gap-0.5">
            {(onMoveUp || onMoveDown) && (
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
          <div className="flex items-center gap-0.5">
            {taskEdited && (
              <ControlIcon
                label="Revert to AI"
                icon={RotateCcw}
                onClick={revertTask}
              />
            )}
            {onDelete && <DeleteControl title={task.title} onDelete={onDelete} />}
          </div>
        </div>
      )}
    </div>
  );
}

// The quiet per-field "edited" indicator (v1.1): a small muted dot that marks a
// field whose value differs from its AI baseline. Pure signal — no action (the
// revert is a single task-level control in the footer). Its top margin lines the
// dot up with the first line of the field's text.
function FieldDot() {
  return (
    <span
      className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50"
      aria-hidden
    />
  );
}

// A quiet reorder icon-button (up / down). Thin Lucide chevron, monochrome; a
// disabled end-of-list control dims and stops responding (ADR-004/005).
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
            className="rounded-sm p-1 text-muted-foreground transition-colors duration-150 ease-out hover:bg-background hover:text-foreground active:opacity-80 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        <Icon className="size-4" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// The per-task delete control + its confirmation (TASK-58). Reuses the same
// destructive Dialog pattern as the session delete (session-view.tsx) so the
// confirm reads consistently. Deleting is instant + autosaved by the parent, so
// there's no pending/deleting spinner — the card just disappears on confirm.
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

// A thin monochrome pill. Same visual language as the sidebar IncompleteBadge:
// outlined, uppercase, tracked — a label, not a colored chip. `trailing` tucks an
// affordance (the Edit-mode dropdown chevron) INSIDE the pill's border.
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

// TASK-33 AC#7 / ADR-018 — priority is the one place hue is allowed (a
// deliberate, restrained exception to ADR-004's monochrome rule). FILLED but
// still muted: a solid low-chroma tint (~0.09–0.11) with near-white text — high
// = soft brick red, med = soft amber, low stays neutral (a plain gray fill, no
// hue). Filled, not outlined, so the chip reads clearly without going loud.
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
  /** An affordance tucked INSIDE the pill (the Edit-mode dropdown chevron). */
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
