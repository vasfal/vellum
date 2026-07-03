"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleDashed, Film, Loader2 } from "lucide-react";

import { useAnalysis } from "@/components/analysis/analysis-provider";
import { FadeText } from "@/components/fade-text";
import { useSessions } from "@/hooks/useSessions";
import { formatRelativeTime } from "@/lib/time";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { matchesQuery, type SessionRow } from "@/lib/filesystem/sessions";

// TASK-14 — the session list inside the sidebar. Scans the workspace via
// useSessions and renders one row per marked session, most-recent first.
//
// TASK-17 — rows are now navigable: each links to /session/<name> (the session
// view). The active row is highlighted from the current path.
//
// TASK-19 — a live client-side filter: `query` (from the sidebar search box)
// narrows the list to sessions whose display name or content matches. An empty
// query shows everything; a query with no matches shows a friendly notice.
export function SessionList({ query = "" }: { query?: string }) {
  const state = useSessions();

  if (state.status === "loading") {
    return (
      <SidebarMenu>
        {/* A couple of placeholder rows while we read the directory. */}
        {[0, 1, 2].map((i) => (
          <SidebarMenuItem key={i}>
            <SidebarMenuSkeleton showIcon />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }

  if (state.status === "error") {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">
        Couldn&apos;t read this workspace.
      </p>
    );
  }

  if (state.sessions.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">No sessions yet</p>
    );
  }

  const matches = state.sessions.filter((session) => matchesQuery(session, query));

  if (matches.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">No matches</p>
    );
  }

  return (
    <SidebarMenu>
      {matches.map((session) => (
        <SessionMenuItem key={session.name} session={session} />
      ))}
    </SidebarMenu>
  );
}

function SessionMenuItem({ session }: { session: SessionRow }) {
  const pathname = usePathname();
  // The route param is encoded; compare against the encoded name so the active
  // row still matches when the folder name has spaces or other URL-unsafe chars.
  const href = `/session/${encodeURIComponent(session.name)}`;
  const isActive = pathname === href;

  // TASK-42 — if THIS session is the one being analyzed, the row reports live
  // progress: a spinner in place of the film icon, the phase in the meta slot,
  // and a thin determinate bar along the bottom edge.
  const { analysis } = useAnalysis();
  const analyzing = analysis?.name === session.name ? analysis : null;

  // Status is now tooltip-only (badges removed): the row conveys it through the
  // icon (dashed ring vs. film) and the tooltip spells it out.
  const status = analyzing
    ? "Analyzing…"
    : session.unanalyzed
      ? "Unanalyzed"
      : session.incomplete
        ? "Incomplete"
        : "Analyzed";

  return (
    <SidebarMenuItem>
      {/* TASK-43 — a row-level tooltip surfaces the on-disk folder name (a
          timestamp; ADR-017 never renames it) alongside the display name, so
          app-name <-> Finder folder is mappable without opening the session.
          FadeText's own overflow tooltip is suppressed here (tooltip={false}) so
          the two don't stack. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              render={<Link href={href} />}
              isActive={isActive}
              // Selected row: a stronger fill than hover (gray-5) so the current
              // session reads clearly — darker than the panel in light, lighter in
              // dark (the ramp inverts). No hover change on the active row (hold
              // gray-5 on hover too). Keep the same font weight (override
              // data-active:font-medium).
              className="data-active:bg-[var(--gray-5)] data-active:font-normal data-active:hover:bg-[var(--gray-5)]"
            />
          }
        >
          {/* Muted so the icon sits behind the name — hierarchy from contrast,
              not weight (ADR-004). The spinner keeps full contrast so a live run
              still reads at a glance. */}
          {analyzing ? (
            <Loader2 className="animate-spin" strokeWidth={1.5} />
          ) : session.unanalyzed || session.incomplete ? (
            // Not-yet-analyzed / incomplete sessions read as a dashed ring; the
            // film icon is reserved for a real, analyzed session.
            <CircleDashed className="text-muted-foreground opacity-80" strokeWidth={1.5} />
          ) : (
            <Film className="text-muted-foreground opacity-80" strokeWidth={1.5} />
          )}
          {/* Effective display name (TASK-22): fades at the end when it overflows.
              Tooltip suppressed — the row tooltip below carries the full name.
              text-clip! cancels the SidebarMenuButton's `[&>span:last-child]:truncate`
              ellipsis (this is now the last child), leaving only the fade mask. */}
          <FadeText tooltip={false} className="min-w-0 flex-1 text-clip!">
            {session.displayName}
          </FadeText>
          {/* The row stays quiet: no status badge and no timestamp. Both live in
              the tooltip now so the list reads as a clean column of names. */}
        </TooltipTrigger>
        <TooltipContent side="right" className="flex max-w-64 flex-col gap-0.5">
          <span className="truncate text-popover-foreground">
            {session.displayName}
          </span>
          {/* Folder name only when it adds information — for an unanalyzed row
              the display name IS the folder name, so showing it would just echo
              the line above. Kept for analyzed rows where the app-name <-> Finder
              folder mapping is otherwise invisible (TASK-43). */}
          {session.name !== session.displayName && (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {session.name}
            </span>
          )}
          {/* Status + recency, moved off the row and into the tooltip. */}
          <span className="text-[11px] text-muted-foreground">
            {status} · {formatRelativeTime(session.lastModified)}
          </span>
        </TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
}

