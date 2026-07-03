"use client";

import { useEffect, useRef, useState } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Single-line text that fades out at its end when it overflows (the .fade-end
// mask, replacing the truncate ellipsis) and reveals the full text in a tooltip
// ONLY while it's actually truncated. Pass a plain string so the tooltip has
// something to show. Overflow is measured with a ResizeObserver so the tooltip
// appears/disappears as the container (e.g. the resizable panes) changes width.
export function FadeText({
  children,
  className,
  tooltip = true,
}: {
  children: string;
  className?: string;
  // Set false when a parent already provides its own tooltip for this row (e.g.
  // the sidebar row shows name + folder id together — TASK-43), so we don't stack
  // a second popup on top of it. The fade-on-overflow mask still applies.
  tooltip?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  const span = (
    <span
      ref={ref}
      className={cn(
        "overflow-hidden whitespace-nowrap",
        // The fade mask is applied ONLY while the text overflows, so text
        // that fits isn't dissolved at the end.
        overflowing && "fade-end",
        className,
      )}
    >
      {children}
    </span>
  );

  if (!tooltip) return span;

  // Always wrap in the Tooltip so the trigger span is stable (no remount when
  // overflow toggles); the popup is only rendered when the text is truncated, so
  // a name that fits shows no tooltip.
  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      {overflowing && <TooltipContent>{children}</TooltipContent>}
    </Tooltip>
  );
}
