"use client";

// TASK-57 (ADR-024) — the inline-edit primitives Edit mode is built from. Modeled
// on the SessionTitle inline rename (session-view.tsx): click a value to turn it
// into a field, commit on Enter/blur, cancel on Escape, an empty value is rejected
// (keeps the prior value) so schema .min(1) fields never go blank.
//
// Monochrome + restrained (ADR-004): a resting value is a quiet button that only
// hints it's editable on hover; the field it becomes borrows the same border/focus
// treatment as the rename input. Motion is ease-out 150ms on specific properties
// (ADR-005). Everything reads off theme tokens so both themes hold (ADR-019).

import { useLayoutEffect, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { Select } from "@base-ui/react/select";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A single-line editable value (title). Enter or blur commits; Escape cancels;
// empty or unchanged keeps the prior value (AC#6 — rejects an empty title). The
// display and the input share `className` so the text doesn't shift on entry.
export function InlineText({
  value,
  onCommit,
  ariaLabel,
  className,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  /** Text style shared by the resting value and the input, so entry is seamless. */
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const start = () => {
    // Don't hijack a text selection meant for commenting (TASK-68.2): a drag-select
    // that ends on this value shouldn't flip it into an editor. A plain (collapsed)
    // click still enters edit mode.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
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
      <input
        autoFocus
        value={draft}
        aria-label={ariaLabel}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className={cn(
          "w-full rounded-sm border border-border bg-transparent px-1 py-0.5 outline-none focus:border-foreground/30",
          className,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      // select-text so a drag-select of the value can be made into a comment
      // (TASK-68.2) — a <button>'s text isn't selectable by default in Chromium.
      className={cn(
        "-mx-1 select-text rounded-sm px-1 py-0.5 text-left transition-colors duration-150 ease-out hover:bg-sidebar active:opacity-80",
        className,
      )}
    >
      {value}
    </button>
  );
}

// A multi-line editable value (description, screen_context, overview). Enter
// inserts a newline; Cmd/Ctrl+Enter or blur commits; Escape cancels. Empty or
// unchanged keeps the prior value (these fields are schema-required). Auto-grows
// to fit its content so there's no inner scrollbar.
export function InlineTextarea({
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

  // Grow the textarea to its content on entry and on every keystroke.
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

// An enum value edited via a small dropdown constrained to `options` (category /
// priority). The trigger reuses the field's own pill visual (`renderPill`) so it
// reads as the same chip, just clickable. The dropdown chevron lives INSIDE the
// pill as a trailing affordance (the caller renders it when `opts.trigger`) — not
// floating outside the chip. Uses the same base-ui Select + animation classes as
// the analysis-config model picker.
export function EnumSelect<T extends string>({
  value,
  options,
  onChange,
  renderPill,
  ariaLabel,
}: {
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  /** Render one enum value as its pill (the shared TaskListItem visuals). `opts.
   *  trigger` marks the closed-trigger pill, so the caller can tuck the chevron
   *  inside it; the dropdown's list items call this without opts (no chevron). */
  renderPill: (value: T, opts?: { trigger?: boolean }) => React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <Select.Root
      value={value}
      onValueChange={(next) => {
        // base-ui hands back the selected value; guard the nullable clear path.
        if (next) onChange(next as T);
      }}
    >
      <Select.Trigger
        aria-label={ariaLabel}
        className="inline-flex items-center rounded-full outline-none transition-opacity duration-150 ease-out hover:opacity-80 active:opacity-70 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Select.Value>{(v) => renderPill(v as T, { trigger: true })}</Select.Value>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-50"
        >
          <Select.Popup
            className={cn(
              "min-w-36 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none",
              "origin-(--transform-origin) duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  key={option}
                  value={option}
                  className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm outline-none transition-colors data-highlighted:bg-muted"
                >
                  <Select.ItemText>{renderPill(option)}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check className="size-3.5" strokeWidth={2} />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

// The quiet provenance marker (ADR-024): a field whose value differs from its AI
// baseline shows a small muted dot; a thin "revert to AI" control reveals on hover
// of the enclosing `group/field`. Deliberately NOT a loud badge — a dot + an
// on-hover undo glyph, monochrome. Renders nothing when the field is unchanged.
export function EditMarker({
  edited,
  onRevert,
}: {
  edited: boolean;
  onRevert: () => void;
}) {
  if (!edited) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 align-middle">
      <span
        className="size-1 rounded-full bg-muted-foreground/50"
        aria-hidden
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onRevert}
              aria-label="Revert to AI"
              className="text-muted-foreground/50 opacity-0 transition-opacity duration-150 ease-out hover:text-foreground active:opacity-80 group-hover/field:opacity-100"
            />
          }
        >
          <RotateCcw className="size-3" strokeWidth={1.5} />
        </TooltipTrigger>
        <TooltipContent>Revert to AI</TooltipContent>
      </Tooltip>
    </span>
  );
}
