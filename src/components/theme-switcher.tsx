"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Theme control (ADR-019): a static horizontal two-way toggle — Light / Dark —
// pinned to the right of the wordmark in the sidebar logo band. Dark is the
// default for everyone (no System option), so this is just a straight pick
// between the two. Monochrome box: the active mode sits on the raised surface,
// the other stays muted (ADR-004).
//
// `mounted` gates the active highlight — on the server `theme` is undefined, so
// deferring it to after mount avoids a hydration mismatch.
const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5">
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = mounted && theme === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setTheme(value)}
                  aria-label={label}
                  aria-pressed={active}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-md transition-colors duration-150 ease-out active:opacity-80",
                    active
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                />
              }
            >
              <Icon className="size-3.5" strokeWidth={1.5} />
            </TooltipTrigger>
            <TooltipContent side="top">{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
