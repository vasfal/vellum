"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";

import { ImportVideo } from "@/components/import-video";
import { NewRecording } from "@/components/recording/new-recording";
import { useSessionActions } from "@/components/recording/session-actions";
import { Logo } from "@/components/logo";
import { SessionList } from "@/components/session-list";
import { SidebarStatus } from "@/components/settings/sidebar-status";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// App version shown beside the wordmark. Bumped manually (per Vasyl) — do NOT
// auto-change it.
const APP_VERSION = "v1.0";

// The Vellum app sidebar. The session list reads the live workspace (TASK-14);
// New recording records into the adopted workspace (TASK-25). The footer surfaces
// the Gemini key status + active workspace with a re-pick action (TASK-38).
export function AppSidebar() {
  // TASK-19 — live filter over the session list. Purely client-side: state lives
  // here so the search box and the list share it; the list matches on the display
  // name (matchesQuery). The box is hidden behind a toggle next to the "Sessions"
  // label (progressive disclosure) and resets when closed.
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // While a recording is in progress, the controls fill the row and the Import
  // button is hidden. The active flag comes from the shared record/import context
  // (TASK-40), so the sidebar and the empty state agree on one recorder.
  const { recordingActive } = useSessionActions();

  const toggleSearch = () =>
    setSearchOpen((open) => {
      if (open) setQuery(""); // closing clears the filter
      return !open;
    });

  return (
    // `inset` variant: the shell background becomes the sidebar colour and the
    // main content floats as a rounded panel with margins on it — the Linear /
    // Factorial layout (ADR-019 era). px-0! strips the variant's horizontal
    // padding so the sidebar's dividers run full width; its 8px top padding
    // stays, aligning the logo band with the floating panel's header.
    <Sidebar variant="inset" className="px-0!">
      <SidebarHeader className="gap-2 p-0">
        {/* Logo band matches the PageHeader height (h-12) so the wordmark aligns
            with the page title across the sidebar / content boundary. The theme
            toggle is pinned to the right edge of this band (ADR-019). */}
        <div className="flex h-12 items-center justify-between pl-4 pr-3">
          {/* Version baseline-aligns to the foot of the wordmark (items-end +
              leading-none), the cluster stays vertically centred in the band. */}
          <div className="flex items-end gap-2">
            {/* TASK-70 — the wordmark links home (the start page). Kept to the
                logo itself (not the version) so the click target reads as the
                brand. rounded-sm + focus ring make it keyboard-reachable; the
                anchor's default pointer cursor signals it's clickable without
                any colour change (stays monochrome). */}
            <Link
              href="/"
              aria-label="Vellum home"
              className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Logo className="h-[18px]" />
            </Link>
            <span className="relative -top-px font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
              {APP_VERSION}
            </span>
          </div>
          <ThemeSwitcher />
        </div>
        <SidebarMenu className="px-3 pb-1.5">
          {/* One row: the primary "New recording" grows; Import (S13, the quieter
              second entry point — bg-background fill) sits beside it as a compact
              icon button with a hover tooltip. Import is hidden while a recording
              is in progress, when Record becomes the live controls. */}
          <SidebarMenuItem className="flex items-stretch gap-2.5">
            <div className="min-w-0 flex-1">
              <NewRecording />
            </div>
            {!recordingActive && <ImportVideo />}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* overflow-hidden here so the group below owns the scroll — the Sessions
          label + search box stay pinned and only the list scrolls. */}
      <SidebarContent className="overflow-hidden">
        <SidebarGroup className="min-h-0 flex-1">
          <div className="flex shrink-0 items-center justify-between">
            {/* Quiet Linear-style section label — tiny, uppercase, tracked and
                dimmed so it reads as a divider, not a heading (TASK-39). */}
            <SidebarGroupLabel className="h-7 text-[0.6875rem] font-medium uppercase tracking-wider text-sidebar-foreground/50">
              Sessions
            </SidebarGroupLabel>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={toggleSearch}
                    aria-label={searchOpen ? "Close search" : "Search sessions"}
                    aria-expanded={searchOpen}
                    className={`mr-1 rounded p-1 transition-colors ${
                      searchOpen
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  />
                }
              >
                <Search className="size-3.5" strokeWidth={1.5} />
              </TooltipTrigger>
              <TooltipContent>
                {searchOpen ? "Close search" : "Search sessions"}
              </TooltipContent>
            </Tooltip>
          </div>
          {searchOpen && (
            <div className="shrink-0 px-1 pb-2">
              {/* The positioning context is the input box ONLY (h-8) — no padding
                  here, or top-1/2 would center against a taller box and the icons
                  would sit high. */}
              <div className="relative h-8">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  strokeWidth={1.5}
                />
                <Input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search sessions"
                  aria-label="Search sessions"
                  className="h-8 pl-8 pr-8 text-sm"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3.5" strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </div>
          )}
          <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto">
            <SessionList query={searchOpen ? query : ""} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="py-0.5">
        <SidebarStatus />
      </SidebarFooter>
    </Sidebar>
  );
}
