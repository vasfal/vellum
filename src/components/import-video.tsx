"use client";

// TASK-30 / TASK-40 — the sidebar trigger for the non-record entry point (S13).
// The copy + analyze flow and its dialog live in SessionActionsProvider (so
// import can also be started from the empty state); this is the compact icon
// button beside New recording. Its fill is bg-background in both themes — the
// colour of the main content panel — reading as the quieter action while still
// sitting distinctly on the sidebar surface. A hover tooltip carries the label.

import { Import, Loader2 } from "lucide-react";

import { useSessionActions } from "@/components/recording/session-actions";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ImportVideo() {
  const { startImport, importing } = useSessionActions();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            onClick={startImport}
            disabled={importing}
            aria-label="Import video"
            className="bg-background dark:bg-background"
          />
        }
      >
        {importing ? (
          <Loader2 className="animate-spin" strokeWidth={1.5} />
        ) : (
          <Import strokeWidth={1.5} />
        )}
      </TooltipTrigger>
      <TooltipContent>Import video</TooltipContent>
    </Tooltip>
  );
}
