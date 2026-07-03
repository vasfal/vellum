"use client";

// TASK-59 (ADR-024) — Comment mode's UI: the plannotator annotation layer.
//
//   • CommentableText — renders a task field / the overview with quiet highlights
//     on already-commented spans, and carries the data-attributes that let a text
//     selection resolve back to { taskId, field }.
//   • useCommentSelection — while Comment mode is active, watches for a text
//     selection scoped to ONE commentable field and surfaces a pending anchor.
//   • CommentComposer — the small popover near the selection to type the comment.
//   • CommentsPanel — the list of all comments (quote / "Session" / "General"),
//     with a global "comment on this session" affordance + inline edit / delete.
//
// Restrained (ADR-004): commented spans carry the muted comment-highlight yellow
// (v1.1 — the second sanctioned hue exception, same bar as the ADR-018 priority
// tints; token-based so both themes hold, ADR-019); the popover/panel read off
// popover/border tokens. Motion is ease-out 150ms (ADR-005).

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Trash2,
  Wand,
  X,
} from "lucide-react";

import {
  resolveCommentAnchor,
  type AnchorTarget,
  type Comment,
  type CommentField,
} from "@/lib/comments/comment";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InlineTextarea } from "./inline-edit";

// ---- data attributes (the selection → anchor seam) -------------------------
const FIELD_ATTR = "data-comment-field";
const TASK_ATTR = "data-comment-taskid";
/** DOM id for a task card, so clicking a comment can scroll to its anchor. */
export const taskCardDomId = (taskId: string) => `task-card-${taskId}`;

// ---- highlight -------------------------------------------------------------

interface Segment {
  text: string;
  mark: boolean;
}

// Split `text` so every occurrence-worth quote is wrapped. We highlight the FIRST
// occurrence of each distinct quote and skip overlaps — enough for a quiet visible
// layer without character-offset bookkeeping (ADR-024 quote-based anchoring).
function buildSegments(text: string, quotes: string[]): Segment[] {
  const distinct = Array.from(new Set(quotes.filter((q) => q.length > 0)));
  const intervals: Array<{ start: number; end: number }> = [];
  for (const quote of distinct) {
    const start = text.indexOf(quote);
    if (start === -1) continue; // quote no longer present (degraded — not shown)
    intervals.push({ start, end: start + quote.length });
  }
  intervals.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const { start, end } of intervals) {
    if (start < cursor) continue; // overlaps an earlier highlight — skip
    if (start > cursor) segments.push({ text: text.slice(cursor, start), mark: false });
    segments.push({ text: text.slice(start, end), mark: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mark: false });
  return segments;
}

// A commentable text node: highlights commented spans and carries the anchor
// data-attributes. `taskId` is omitted for the session overview (a session-level
// field). Renders as a span by default so it flows inside the card's existing text.
export function CommentableText({
  text,
  taskId,
  field,
  comments,
  pendingQuote,
  className,
}: {
  text: string;
  taskId?: string;
  field: CommentField;
  /** Comments that anchor to THIS field (already filtered by the caller). */
  comments: Comment[];
  /** The quote of the OPEN composer's anchor when it targets THIS field — the
   *  in-progress selection, shown with the SAME yellow as saved highlights so the
   *  user sees on the page the span they're commenting on. Resolves to a saved
   *  highlight on save, or vanishes on cancel (the parent clears the anchor). */
  pendingQuote?: string;
  className?: string;
}) {
  const quotes = useMemo(() => {
    const saved = comments.map((c) => c.quote ?? "").filter(Boolean);
    return pendingQuote ? [...saved, pendingQuote] : saved;
  }, [comments, pendingQuote]);
  const segments = useMemo(() => buildSegments(text, quotes), [text, quotes]);

  return (
    <span
      {...{ [FIELD_ATTR]: field, [TASK_ATTR]: taskId }}
      className={className}
    >
      {segments.map((seg, i) =>
        seg.mark ? (
          <mark
            key={i}
            className="rounded-[2px] bg-[var(--comment-highlight)] px-[1px] text-[var(--comment-highlight-foreground)]"
          >
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </span>
  );
}

// ---- selection detection ---------------------------------------------------

export interface PendingAnchor {
  taskId?: string;
  field: CommentField;
  quote: string;
  /** Viewport rect of the selection, for popover placement (fixed positioning). */
  rect: { top: number; bottom: number; left: number; right: number };
}

/** From a selection node, find the enclosing commentable field element (or null). */
function fieldElementOf(node: Node | null): HTMLElement | null {
  const el =
    node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null);
  return el?.closest<HTMLElement>(`[${FIELD_ATTR}]`) ?? null;
}

// While `active`, watch for a mouse-driven text selection that sits inside ONE
// commentable field and hand back the pending anchor. A selection that spans
// outside a single field (or is collapsed / empty) is ignored.
export function useCommentSelection(
  active: boolean,
  onAnchor: (anchor: PendingAnchor) => void,
) {
  const onAnchorRef = useRef(onAnchor);
  useEffect(() => {
    onAnchorRef.current = onAnchor;
  }, [onAnchor]);

  useEffect(() => {
    if (!active) return;
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const quote = sel.toString().trim();
      if (!quote) return;

      const range = sel.getRangeAt(0);
      const fieldEl = fieldElementOf(range.commonAncestorContainer);
      // Require both ends inside the same field — a cross-field drag doesn't anchor.
      if (
        !fieldEl ||
        !fieldEl.contains(range.startContainer) ||
        !fieldEl.contains(range.endContainer)
      ) {
        return;
      }

      const field = fieldEl.getAttribute(FIELD_ATTR) as CommentField | null;
      if (!field) return;
      const taskId = fieldEl.getAttribute(TASK_ATTR) ?? undefined;
      const r = range.getBoundingClientRect();
      onAnchorRef.current({
        taskId,
        field,
        quote,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      });
    };
    // Defer to let the browser finalize the selection before we read it.
    const handler = () => window.setTimeout(onMouseUp, 0);
    document.addEventListener("mouseup", handler);
    return () => document.removeEventListener("mouseup", handler);
  }, [active]);
}

// ---- composer (the selection popover) --------------------------------------

const POPOVER_WIDTH = 380;

// The floating popover to type a comment on a selection. Fixed-positioned under the
// selection rect, clamped to the viewport. Cmd/Ctrl+Enter or Save commits; Escape
// or the backdrop cancels.
export function CommentComposer({
  anchor,
  onSave,
  onCancel,
}: {
  anchor: PendingAnchor;
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

  const left = Math.max(
    12,
    Math.min(anchor.rect.left, window.innerWidth - POPOVER_WIDTH - 12),
  );
  const top = Math.min(anchor.rect.bottom + 8, window.innerHeight - 180);

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
        {/* A quiet muted excerpt of the selection — the yellow highlight lives on
            the ACTUAL text in the card behind this popover (the pending anchor),
            not here, so the popover stays a plain reference. */}
        <p className="line-clamp-2 border-l-2 border-border pl-2 text-[11px] italic leading-snug text-muted-foreground">
          “{anchor.quote}”
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

// ---- comments panel --------------------------------------------------------

// The list of all comments for the session, with a global-comment affordance and
// per-comment inline edit / delete. Docked below the task list in Comment mode.
/** The comment→AI-revise UI state, mirrored structurally to avoid a session-view
 *  import cycle (session-view imports this module). */
export type ReviseUiState =
  | { status: "idle" }
  | { status: "running"; flavor: "text" | "video" }
  | { status: "error"; message: string };

export function CommentsPanel({
  comments,
  tasks,
  overview,
  onAddGlobal,
  onEdit,
  onDelete,
  onFocus,
  reviseState,
  reviseBlocked,
  onProcessComments,
  onReRunWithVideo,
  onCancelRevise,
}: {
  comments: Comment[];
  /** Current tasks (for resolving each anchor's status + its task title). */
  tasks: AnchorTarget[];
  overview: string;
  onAddGlobal: (body: string) => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  /** Scroll to a comment's anchored task (nice-to-have). */
  onFocus: (comment: Comment) => void;
  // TASK-60 — the comment→AI-revise loop (ADR-024): a text-only revise and a
  // separate re-run-with-video, offered once there are comments to process.
  reviseState: ReviseUiState;
  reviseBlocked: boolean;
  onProcessComments: () => void;
  onReRunWithVideo: () => void;
  onCancelRevise: () => void;
}) {
  const [addingGlobal, setAddingGlobal] = useState(false);

  return (
    <div className="flex max-h-[42%] shrink-0 flex-col border-t border-border bg-background">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <span className="text-[13px] font-medium text-foreground">
          {comments.length} {comments.length === 1 ? "comment" : "comments"}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setAddingGlobal((v) => !v)}
              />
            }
          >
            <MessageSquarePlus strokeWidth={1.5} />
            Global comment
          </TooltipTrigger>
          <TooltipContent>Comment on this session</TooltipContent>
        </Tooltip>
      </div>

      {addingGlobal && (
        <div className="shrink-0 px-4 pb-3">
          <GlobalComposer
            onSave={(body) => {
              onAddGlobal(body);
              setAddingGlobal(false);
            }}
            onCancel={() => setAddingGlobal(false)}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {comments.length === 0 ? (
          <p className="py-3 text-xs leading-relaxed text-muted-foreground">
            Select text in a task or the overview to attach a comment, or comment on
            the whole session.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {comments.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                status={resolveCommentAnchor(comment, tasks, overview)}
                taskTitle={
                  comment.taskId
                    ? tasks.find((t) => t.id === comment.taskId)?.title
                    : undefined
                }
                onEdit={(body) => onEdit(comment.id, body)}
                onDelete={() => onDelete(comment.id)}
                onFocus={() => onFocus(comment)}
              />
            ))}
          </ul>
        )}
      </div>

      <ReviseBar
        commentCount={comments.length}
        state={reviseState}
        blocked={reviseBlocked}
        onProcess={onProcessComments}
        onReRunWithVideo={onReRunWithVideo}
        onCancel={onCancelRevise}
      />
    </div>
  );
}

// The action bar that closes the plannotator loop (TASK-60): a primary text-only
// "Process comments" and a secondary, clearly costlier "Re-run with video". Shown
// only when there are comments to act on; a running revise shows progress + Cancel.
function ReviseBar({
  commentCount,
  state,
  blocked,
  onProcess,
  onReRunWithVideo,
  onCancel,
}: {
  commentCount: number;
  state: ReviseUiState;
  blocked: boolean;
  onProcess: () => void;
  onReRunWithVideo: () => void;
  onCancel: () => void;
}) {
  if (commentCount === 0) return null;

  if (state.status === "running") {
    return (
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2.5">
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

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-4 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
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
        <Button disabled={blocked} onClick={onProcess}>
          <Wand strokeWidth={1.5} />
          Process comments
        </Button>
      </div>
      {state.status === "error" && (
        <p className="text-[11px] leading-snug text-destructive">{state.message}</p>
      )}
    </div>
  );
}

// One comment: a quiet context line (quote / "Session" / "General") + the body,
// which is inline-editable; a hover trash removes it (undo-less quiet remove).
function CommentRow({
  comment,
  status,
  taskTitle,
  onEdit,
  onDelete,
  onFocus,
}: {
  comment: Comment;
  status: ReturnType<typeof resolveCommentAnchor>;
  taskTitle: string | undefined;
  onEdit: (body: string) => void;
  onDelete: () => void;
  onFocus: () => void;
}) {
  // The context label above the body: the quoted span for a live anchor, "Session"
  // for a global note, "General" for an orphan (its task was deleted). A degraded
  // anchor keeps its quote but is tagged so it reads as no-longer-attached.
  const context =
    comment.kind === "global" || status === "orphan" ? (
      <span className="text-muted-foreground">
        {comment.kind === "global" ? "Session" : "General"}
      </span>
    ) : (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate italic text-muted-foreground">
          “{comment.quote}”
        </span>
        {status === "degraded" && (
          <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
            unanchored
          </span>
        )}
      </span>
    );

  return (
    <li className="group/comment flex flex-col gap-1 rounded-lg bg-sidebar px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onFocus}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] transition-opacity duration-150 ease-out active:opacity-80"
        >
          {taskTitle && status !== "orphan" && (
            <span className="shrink-0 truncate font-medium text-muted-foreground/80">
              {taskTitle}
            </span>
          )}
          {context}
        </button>
        <button
          type="button"
          onClick={onDelete}
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
        onCommit={onEdit}
      />
    </li>
  );
}

// The inline global-comment composer (in the panel header). A plain expanding
// textarea rather than the floating popover — a global note has no selection to
// anchor to.
function GlobalComposer({
  onSave,
  onCancel,
}: {
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-popover p-2.5">
      <textarea
        ref={ref}
        rows={3}
        value={body}
        placeholder="Comment on this session…"
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
          <X strokeWidth={1.5} />
          Cancel
        </Button>
        <Button onClick={save} disabled={body.trim().length === 0}>
          Comment
        </Button>
      </div>
    </div>
  );
}
