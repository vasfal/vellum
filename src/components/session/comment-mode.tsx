"use client";

// TASK-68.2 (parent TASK-68, ADR-024) — the Google-Docs-style commenting layer for
// the interactive report document. There is NO comment MODE anymore: commenting is
// always available on the live document. This module is the toolkit the document
// (report-document.tsx) composes:
//
//   • useDocumentTextSelection — watch for a text selection and resolve it to the
//     tightest scope it covers: a text RANGE (one field/overview), a WHOLE task, or
//     a GROUP of tasks (item 2) — with the rect to anchor a floating affordance to.
//   • SelectionCommentButton — the floating "Comment" button shown at a fresh text
//     selection (step 1); clicking it opens the composer (step 2).
//   • CommentComposer — the popover to type a new comment (range OR whole-task OR
//     task-group OR global), anchored near the selection / trigger, flipped above
//     when it would overflow the viewport bottom (item 6).
//   • CommentThreadPopover — click a highlighted span (or a task's comment badge) to
//     read/edit/delete the comment(s) attached there (the click→view affordance).
//   • CommentsPanel — the ONE collapsible bottom bar (item 5): a slim "N comments"
//     bar + the comment→AI-revise controls, expanding into a scrollable list of
//     every comment (row → scroll+flash its anchor, edit, delete); it also hosts the
//     whole-task / group-selection actions, replacing the old floating overlay.
//   • useCommentHighlights — paints saved range highlights via the CSS Custom
//     Highlight API (Chromium; the app's target) and resolves a click to its comment.
//     Block targets (task/group) can't be painted by a text Highlight — the document
//     tints their section instead (.comment-section) and flashes it from the panel.
//
// Restrained (ADR-004): highlights use the muted comment-highlight yellow (the
// sanctioned ADR-018/019 hue exception, token-based so both themes hold); popovers
// read off popover/border tokens; motion is ease-out 150ms (ADR-005).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Trash2,
  Wand,
  X,
} from "lucide-react";

import {
  commentQuote,
  resolveCommentAnchor,
  type AnchorTarget,
  type Comment,
  type CommentTarget,
  type CommentTaskField,
} from "@/lib/comments/comment";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { InlineTextarea } from "./inline-edit";

// ---- the selection → anchor seam -------------------------------------------
// Each commentable text field carries `data-comment-anchor="<scope>::<field>"`,
// where <scope> is a task id (or "overview") and <field> is the task field name
// (or "overview"). A text selection resolves back to its target through this.
const ANCHOR_ATTR = "data-comment-anchor";
const ANCHOR_SEP = "::";

/** Build the anchor attribute value for a commentable field. */
export function commentAnchor(
  scope: string,
  field: CommentTaskField | "overview",
): string {
  return `${scope}${ANCHOR_SEP}${field}`;
}

/** A text-range target awaiting a comment (field range or overview range). */
export type RangeTarget = Extract<CommentTarget, { type: "field" | "overview" }>;

/** What a drag-selection can resolve to: a text RANGE (one field / the overview),
 *  a WHOLE task (a multi-field drag inside one task), or a GROUP of tasks (a drag
 *  spanning several). The whole session (global) is never a drag target — it's the
 *  header's "Global comment" button. */
export type SelectionTarget = Exclude<CommentTarget, { type: "global" }>;

/** A captured selection: its resolved target + the viewport rect to anchor a
 *  floating affordance to (fixed positioning). */
export interface PendingSelection {
  target: SelectionTarget;
  rect: { top: number; bottom: number; left: number; right: number };
}

/** The composer's quiet context line, per target kind — the quote for a range, or a
 *  plain description for a block target. */
export function composerContextLabel(target: CommentTarget): string {
  switch (target.type) {
    case "field":
    case "overview":
      return `“${target.quote}”`;
    case "task":
      return "This task";
    case "tasks":
      return `${target.taskIds.length} tasks`;
    case "global":
      return "The whole session";
  }
}

/** Is there a live, non-empty text selection right now? Inline editors read this to
 *  avoid entering edit mode when the user was actually selecting text to comment. */
export function hasActiveSelection(): boolean {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

/** From a node, the enclosing commentable field element (or null). */
function anchorElementOf(node: Node | null): HTMLElement | null {
  const el =
    node?.nodeType === Node.TEXT_NODE
      ? node.parentElement
      : (node as HTMLElement | null);
  return el?.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) ?? null;
}

/** Parse an anchor attribute + the selected quote into a range target. */
function targetFromAnchor(attr: string, quote: string): RangeTarget | null {
  const [scope, field] = attr.split(ANCHOR_SEP);
  if (!scope || !field) return null;
  if (scope === "overview") return { type: "overview", quote };
  return { type: "field", taskId: scope, field: field as CommentTaskField, quote };
}

// While `active`, watch for a mouse-driven text selection and resolve it to the
// TIGHTEST comment scope it covers (TASK-68.2 v2):
//   • both ends in ONE field           → a text-range comment on that field/overview
//   • across fields but ONE task        → a whole-task comment ({type:"task"})
//   • spanning several tasks            → a group comment ({type:"tasks"})
// A collapsed selection, one inside an editing textarea, or one that lands on no
// commentable field/task is ignored.
export function useDocumentTextSelection(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onSelect: (pending: PendingSelection) => void,
) {
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!active) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const quote = sel.toString().trim();
      if (!quote) return;

      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) return;

      // A selection inside an inline editor's textarea is native text editing, not a
      // comment anchor — ignore it.
      const startEl =
        range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement
          : (range.startContainer as HTMLElement);
      if (startEl?.closest("textarea, input")) return;

      const r = range.getBoundingClientRect();
      const rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };

      // 1) Both ends in the SAME field → a text-range comment (the original path).
      const startField = anchorElementOf(range.startContainer);
      const endField = anchorElementOf(range.endContainer);
      if (startField && startField === endField) {
        const attr = startField.getAttribute(ANCHOR_ATTR);
        const target = attr ? targetFromAnchor(attr, quote) : null;
        if (target) onSelectRef.current({ target, rect });
        return;
      }

      // 2) Otherwise resolve to the task section(s) the selection touches. One task
      //    → a whole-task comment; several → a group comment. (The overview isn't a
      //    task section, so a stray overview+task drag resolves to the task(s).)
      const taskIds = Array.from(
        container.querySelectorAll<HTMLElement>("[data-task-id]"),
      )
        .filter((sec) => range.intersectsNode(sec))
        .map((sec) => sec.getAttribute("data-task-id"))
        .filter((id): id is string => Boolean(id));

      if (taskIds.length === 1) {
        onSelectRef.current({ target: { type: "task", taskId: taskIds[0] }, rect });
      } else if (taskIds.length > 1) {
        onSelectRef.current({ target: { type: "tasks", taskIds }, rect });
      }
    };
    // Defer so the browser finalizes the selection before we read it.
    const handler = () => window.setTimeout(onMouseUp, 0);
    document.addEventListener("mouseup", handler);
    return () => document.removeEventListener("mouseup", handler);
  }, [active, containerRef]);
}

// ---- saved-range highlights (CSS Custom Highlight API) ---------------------

const HIGHLIGHT_NAME = "vellum-comment";
const HIGHLIGHT_OPEN_NAME = "vellum-comment-open";

/** A resolved highlight: the DOM Range of a range comment's quote + its id. */
interface HighlightHit {
  id: string;
  range: Range;
}

/** True when the browser supports the CSS Custom Highlight API (Chromium). */
function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

/** The field element a range comment lives in, within `container`. */
function fieldElementFor(
  container: HTMLElement,
  comment: Comment,
): HTMLElement | null {
  const t = comment.target;
  const anchor =
    t.type === "overview"
      ? commentAnchor("overview", "overview")
      : t.type === "field"
        ? commentAnchor(t.taskId, t.field)
        : null;
  if (!anchor) return null;
  return container.querySelector<HTMLElement>(
    `[${ANCHOR_ATTR}="${CSS.escape(anchor)}"]`,
  );
}

/** Build a Range spanning the first occurrence of `quote` in `fieldEl`'s text.
 *  Walks visible text nodes, so it works over rendered Markdown as well as plain
 *  text (ADR-024 quote-based; no character offsets stored). */
function rangeForQuote(fieldEl: HTMLElement, quote: string): Range | null {
  const walker = document.createTreeWalker(fieldEl, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let full = "";
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    nodes.push({ node: text, start: full.length });
    full += text.data;
    node = walker.nextNode();
  }
  const idx = full.indexOf(quote);
  if (idx === -1) return null;
  const end = idx + quote.length;

  const startEntry = [...nodes].reverse().find((n) => n.start <= idx);
  const endEntry = [...nodes].reverse().find((n) => n.start < end);
  if (!startEntry || !endEntry) return null;

  const range = document.createRange();
  range.setStart(startEntry.node, idx - startEntry.start);
  range.setEnd(endEntry.node, end - endEntry.start);
  return range;
}

/**
 * Paint saved range-comment highlights over `containerRef` and return a resolver
 * that maps a viewport point to the comment ids highlighted there (for click-to-
 * view). Re-runs whenever `deps` change (comments, the rendered text, the open
 * comment) so highlights track edits. A no-op where the API is unsupported — the
 * per-task comment badges still make every comment reachable.
 */
export function useCommentHighlights(
  containerRef: RefObject<HTMLElement | null>,
  comments: Comment[],
  openId: string | null,
  deps: unknown[],
): (x: number, y: number) => string[] {
  const hitsRef = useRef<HighlightHit[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !highlightsSupported()) {
      hitsRef.current = [];
      return;
    }

    const hits: HighlightHit[] = [];
    const all = new Highlight();
    const open = new Highlight();
    for (const comment of comments) {
      const quote = commentQuote(comment);
      if (!quote) continue; // task / tasks / global carry no range
      const fieldEl = fieldElementFor(container, comment);
      if (!fieldEl) continue;
      const range = rangeForQuote(fieldEl, quote);
      if (!range) continue; // degraded (quote no longer present) — not painted
      hits.push({ id: comment.id, range });
      (comment.id === openId ? open : all).add(range);
    }
    hitsRef.current = hits;
    CSS.highlights.set(HIGHLIGHT_NAME, all);
    CSS.highlights.set(HIGHLIGHT_OPEN_NAME, open);

    return () => {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(HIGHLIGHT_OPEN_NAME);
      hitsRef.current = [];
    };
    // deps is the caller's explicit dependency list (comments + rendered text).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Resolve a click point to the comment ids whose highlighted range contains it.
  return useCallback((x: number, y: number): string[] => {
    const caret = document.caretRangeFromPoint(x, y);
    if (!caret) return [];
    const ids: string[] = [];
    for (const hit of hitsRef.current) {
      // comparePoint === 0 → the caret sits within [start, end] of the range.
      try {
        if (hit.range.comparePoint(caret.startContainer, caret.startOffset) === 0) {
          ids.push(hit.id);
        }
      } catch {
        // A stale range (its nodes were replaced by a re-render) can throw
        // WrongDocumentError — skip it; the next effect run rebuilds the ranges.
      }
    }
    return ids;
  }, []);
}

// ---- popover positioning ---------------------------------------------------

const POPOVER_WIDTH = 340;

/** Where to place a floating popover relative to an anchor rect (item 6): below it
 *  by default, FLIPPED above when it would overflow the viewport bottom, and clamped
 *  so it never spills off the right edge. `height` is the popover's approximate
 *  height (so the flip math knows when it won't fit below). */
function popoverPosition(
  rect: { top?: number; bottom: number; left: number },
  height = 200,
): { top: number; left: number } {
  const margin = 12;
  const left = Math.max(
    margin,
    Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - margin),
  );
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) {
    const above = (rect.top ?? rect.bottom) - height - 8;
    top = above > margin ? above : Math.max(margin, window.innerHeight - height - margin);
  }
  return { top, left };
}

// ---- step 1: the floating "Comment" button ---------------------------------

// Shown at a fresh text selection. Clicking it opens the composer (step 2). A
// pointerdown elsewhere dismisses it (handled by the parent clearing the selection).
export function SelectionCommentButton({
  rect,
  onClick,
}: {
  rect: { top: number; bottom: number; left: number; right: number };
  onClick: () => void;
}) {
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - 140));
  const top = Math.min(rect.bottom + 8, window.innerHeight - 60);
  return createPortal(
    <div style={{ position: "fixed", top, left }} className="z-50">
      <Button
        size="sm"
        // Commit the click on mousedown so the browser's selection teardown (which
        // fires between mousedown and click) can't swallow it.
        onMouseDown={(e) => {
          e.preventDefault();
          onClick();
        }}
        className="shadow-md duration-150 animate-in fade-in-0 zoom-in-95"
      >
        <MessageSquarePlus strokeWidth={1.5} />
        Comment
      </Button>
    </div>,
    document.body,
  );
}

// ---- step 2: the composer --------------------------------------------------

// The floating popover to type a NEW comment. `contextLabel` describes what's being
// commented (the quote for a range, "this task" / "N tasks" for a task-group), so
// the popover stays meaningful for the non-range targets too.
export function CommentComposer({
  rect,
  contextLabel,
  onSave,
  onCancel,
}: {
  rect: { top?: number; bottom: number; left: number };
  contextLabel: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const save = useCallback(() => {
    const next = body.trim();
    if (next) onSave(next);
  }, [body, onSave]);

  const { top, left } = popoverPosition(rect);

  return createPortal(
    <>
      {/* Invisible backdrop — a click outside dismisses the composer. */}
      <div className="fixed inset-0 z-40" onMouseDown={onCancel} />
      <div
        role="dialog"
        aria-label="Add comment"
        style={{ position: "fixed", top, left, width: POPOVER_WIDTH }}
        className="z-50 flex flex-col gap-2 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-md duration-150 animate-in fade-in-0 zoom-in-95"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="line-clamp-2 border-l-2 border-border pl-2 text-[11px] italic leading-snug text-muted-foreground">
          {contextLabel}
        </p>
        <textarea
          ref={ref}
          rows={3}
          value={body}
          placeholder="Add a comment…"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="w-full resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:border-foreground/30"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={save} disabled={body.trim().length === 0}>
            Comment
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ---- view: the click-to-read thread ----------------------------------------

/** A quiet one-line label for what a comment targets, for the thread + context. */
export function targetLabel(
  comment: Comment,
  tasks: AnchorTarget[],
  overview: string,
): string {
  const t = comment.target;
  const status = resolveCommentAnchor(comment, tasks, overview);
  const title = (id: string) => tasks.find((x) => x.id === id)?.title ?? "task";
  switch (t.type) {
    case "global":
      return "Session";
    case "overview":
      return status === "anchored" ? `“${t.quote}”` : "Overview (unanchored)";
    case "field":
      return status === "anchored"
        ? `“${t.quote}”`
        : `${title(t.taskId)} (unanchored)`;
    case "task":
      return status === "orphan" ? "Task (deleted)" : title(t.taskId);
    case "tasks":
      return `${t.taskIds.length} tasks`;
  }
}

// The popover shown when a highlighted span or a task's comment badge is clicked:
// the comment(s) attached there, each inline-editable, with a hover delete. A click
// outside closes it.
export function CommentThreadPopover({
  rect,
  comments,
  tasks,
  overview,
  onEdit,
  onDelete,
  onClose,
}: {
  rect: { top?: number; bottom: number; left: number };
  comments: Comment[];
  tasks: AnchorTarget[];
  overview: string;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const { top, left } = popoverPosition(rect, 240);
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-label="Comments"
        style={{ position: "fixed", top, left, width: POPOVER_WIDTH }}
        className="z-50 flex max-h-[60vh] flex-col overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md duration-150 animate-in fade-in-0 zoom-in-95"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {comments.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">No comment here.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="group/comment flex flex-col gap-1 rounded-md bg-sidebar px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted-foreground">
                    {targetLabel(comment, tasks, overview)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onDelete(comment.id)}
                    aria-label="Delete comment"
                    className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:text-destructive active:opacity-80 group-hover/comment:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  </button>
                </div>
                <InlineTextarea
                  value={comment.body}
                  ariaLabel="Comment"
                  className="text-[13px] leading-relaxed text-foreground"
                  onCommit={(body) => onEdit(comment.id, body)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>,
    document.body,
  );
}

// ---- panel row context -----------------------------------------------------

/** A comment's context for a PANEL row (item 5): a label that leads with the task
 *  number/title (or Overview / Session / the group), and the quoted anchor text for
 *  a range comment (shown even when degraded — the highlight just won't paint). */
export function commentContext(
  comment: Comment,
  tasks: AnchorTarget[],
): { label: string; quote?: string } {
  const t = comment.target;
  const num = (id: string) => {
    const i = tasks.findIndex((x) => x.id === id);
    return i >= 0 ? String(i + 1).padStart(2, "0") : "–";
  };
  const title = (id: string) => tasks.find((x) => x.id === id)?.title ?? "task";
  switch (t.type) {
    case "global":
      return { label: "Session" };
    case "overview":
      return { label: "Overview", quote: t.quote };
    case "field":
      return { label: `Task ${num(t.taskId)} · ${title(t.taskId)}`, quote: t.quote };
    case "task":
      return { label: `Task ${num(t.taskId)} · ${title(t.taskId)}` };
    case "tasks":
      return { label: `${t.taskIds.length} tasks · ${t.taskIds.map(num).join(", ")}` };
  }
}

// ---- the comment → AI revise footer ----------------------------------------

/** The comment→AI-revise UI state, mirrored structurally to avoid a session-view
 *  import cycle (session-view imports this module). */
export type ReviseUiState =
  | { status: "idle" }
  | { status: "running"; flavor: "text" | "video" }
  | { status: "error"; message: string };

// The sticky document footer for commenting (TASK-68.2 v2) — ONE bottom bar that is
// collapsible into a full comments panel, and that ALSO hosts the group-selection
// actions (replacing the old floating TaskSelectionBar). Three states:
//   • a revise in flight        → progress + Cancel (owns the whole bar)
//   • ≥1 whole task picked       → "N tasks selected · Comment on group · Clear"
//   • otherwise                  → the collapsible panel: a slim "N comments" bar +
//     the run actions, expanding UP into a scrollable list of every comment (each
//     row → scroll+flash its anchor, edit, delete). The GLOBAL comment affordance
//     moved to the pane header, so it's no longer here.
export function CommentsPanel({
  comments,
  tasks,
  state,
  blocked,
  taskSelectionCount,
  onCommentGroup,
  onClearSelection,
  onProcess,
  onReRunWithVideo,
  onCancel,
  onRowActivate,
  onEditComment,
  onDeleteComment,
}: {
  comments: Comment[];
  tasks: AnchorTarget[];
  state: ReviseUiState;
  blocked: boolean;
  /** How many WHOLE tasks are picked for a group comment (item 5). */
  taskSelectionCount: number;
  onCommentGroup: (rect: { top: number; bottom: number; left: number }) => void;
  onClearSelection: () => void;
  onProcess: () => void;
  onReRunWithVideo: () => void;
  onCancel: () => void;
  /** Reveal a comment's anchor on the canvas (scroll + flash) — the panel↔canvas
   *  bidirectional twin of the highlights. */
  onRowActivate: (comment: Comment) => void;
  onEditComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = comments.length;

  if (state.status === "running") {
    return (
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-background px-4 py-2.5">
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          {state.flavor === "text" ? "Processing comments…" : "Re-running with video…"}
        </span>
        <Button variant="ghost" onClick={onCancel}>
          <X strokeWidth={1.5} />
          Cancel
        </Button>
      </div>
    );
  }

  // A group selection REPLACES the bar's normal content (item 5).
  if (taskSelectionCount > 0) {
    return (
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-4 py-2.5">
        <span className="text-[13px] font-medium">
          {taskSelectionCount} {taskSelectionCount === 1 ? "task" : "tasks"} selected
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onCommentGroup({ top: r.top, bottom: r.bottom, left: r.left });
            }}
          >
            <MessageSquarePlus strokeWidth={1.5} />
            {taskSelectionCount === 1 ? "Comment on task" : "Comment on group"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClearSelection}
          >
            Clear
          </Button>
        </div>
      </div>
    );
  }

  const runActions = count > 0 && (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              disabled={blocked}
              onClick={onReRunWithVideo}
            />
          }
        >
          <RefreshCw strokeWidth={1.5} />
          Re-run with video
        </TooltipTrigger>
        <TooltipContent>
          Slower — re-watches the recording and extracts fresh screenshots
        </TooltipContent>
      </Tooltip>
      <Button size="sm" disabled={blocked} onClick={onProcess}>
        <Wand strokeWidth={1.5} />
        Process comments
      </Button>
    </div>
  );

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-background">
      {/* Expanded list sits ABOVE the bar so the bar stays pinned to the column's
          bottom edge. */}
      {expanded && count > 0 && (
        <ul className="flex max-h-[40vh] flex-col divide-y divide-border/60 overflow-y-auto border-b border-border">
          {comments.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              tasks={tasks}
              onActivate={() => onRowActivate(comment)}
              onEdit={(body) => onEditComment(comment.id, body)}
              onDelete={() => onDeleteComment(comment.id)}
            />
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => count > 0 && setExpanded((v) => !v)}
          disabled={count === 0}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 rounded-sm text-[13px] text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {count > 0 ? (
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-150 ease-out",
                expanded ? "" : "-rotate-90",
              )}
              strokeWidth={1.5}
            />
          ) : (
            <MessageSquare className="size-3.5" strokeWidth={1.5} />
          )}
          {count === 0
            ? "No comments yet"
            : `${count} ${count === 1 ? "comment" : "comments"}`}
        </button>
        {runActions}
      </div>
      {state.status === "error" && (
        <p className="px-4 pb-2.5 text-[11px] leading-snug text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}

// One comment in the expanded panel: a context tag (task number/title · Overview ·
// Session · group), the quoted anchor (range comments), and the editable body.
// Clicking the tag or the quote reveals the anchor on the canvas (scroll + flash).
function CommentRow({
  comment,
  tasks,
  onActivate,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  tasks: AnchorTarget[];
  onActivate: () => void;
  onEdit: (body: string) => void;
  onDelete: () => void;
}) {
  const { label, quote } = commentContext(comment, tasks);
  return (
    <li className="group/row flex flex-col gap-1 px-4 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onActivate}
          className="min-w-0 flex-1 truncate text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80 transition-colors hover:text-foreground active:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {label}
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete comment"
          className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out hover:text-destructive active:opacity-80 group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Trash2 className="size-3.5" strokeWidth={1.5} />
        </button>
      </div>
      {quote && (
        <button
          type="button"
          onClick={onActivate}
          className="line-clamp-1 border-l-2 border-border pl-2 text-left text-[11px] italic leading-snug text-muted-foreground transition-colors hover:text-foreground"
        >
          “{quote}”
        </button>
      )}
      <InlineTextarea
        value={comment.body}
        ariaLabel="Comment"
        className="text-[13px] leading-relaxed text-foreground"
        onCommit={onEdit}
      />
    </li>
  );
}

/** How many comments are attached to a given whole task (for its badge): a `task`
 *  comment on it, or a `tasks` group that includes it. Range comments live in the
 *  text (highlighted) so they're excluded here. */
export function taskLevelComments(comments: Comment[], taskId: string): Comment[] {
  return comments.filter((c) => {
    const t = c.target;
    return (
      (t.type === "task" && t.taskId === taskId) ||
      (t.type === "tasks" && t.taskIds.includes(taskId))
    );
  });
}
