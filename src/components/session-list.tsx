"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "@base-ui/react/menu";
import {
  CircleDashed,
  Film,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";

import { useAnalysis } from "@/components/analysis/analysis-provider";
import { FadeText } from "@/components/fade-text";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { useSessions } from "@/hooks/useSessions";
import { formatRelativeTime } from "@/lib/time";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  writeNameSidecar,
  writeOverrideName,
} from "@/lib/filesystem/session-name";
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
  const router = useRouter();
  // The route param is encoded; compare against the encoded name so the active
  // row still matches when the folder name has spaces or other URL-unsafe chars.
  const href = `/session/${encodeURIComponent(session.name)}`;
  const isActive = pathname === href;

  // TASK-69 — per-session actions (Rename / Delete) revealed on row hover. They
  // reuse the SAME filesystem flows as the session-view header: writeOverrideName
  // + writeNameSidecar for rename (name.txt override, survives re-analysis), and
  // handle.removeEntry(recursive) for delete. refreshSessions re-scans the list so
  // the change shows without a reload.
  const { handle, refreshSessions } = useWorkspace();
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(session.displayName);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Seed the draft from the CURRENT name each time the dialog opens, so it always
  // reflects a fresh suggested_name / prior rename without a sync effect.
  const openRename = useCallback(() => {
    setRenameValue(session.displayName);
    setRenameOpen(true);
  }, [session.displayName]);

  // Mirror session-view's onRename: persist the manual override (name.txt), then
  // refresh the Finder sidecar and re-scan the sidebar. Empty / unchanged names
  // keep the current one. A write failure keeps the dialog open to retry.
  const commitRename = useCallback(async () => {
    const next = renameValue.trim();
    if (!next || next === session.displayName) {
      setRenameOpen(false);
      return;
    }
    setRenaming(true);
    try {
      const dir = await handle.getDirectoryHandle(session.name);
      await writeOverrideName(dir, next);
      await writeNameSidecar(dir, next);
      refreshSessions();
      setRenameOpen(false);
    } catch {
      // Write failed — leave the dialog open with the typed value so the user can
      // retry rather than silently losing the edit.
    } finally {
      setRenaming(false);
    }
  }, [renameValue, session.displayName, session.name, handle, refreshSessions]);

  // Mirror session-view's onDelete: remove the whole folder (recording + report +
  // screenshots), re-scan, and — if this is the open session — navigate home so we
  // don't sit on a now-gone view. An already-removed folder (NotFoundError) is not
  // an error; we still refresh and (if needed) navigate.
  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await handle.removeEntry(session.name, { recursive: true });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotFoundError")) {
        // Unexpected failure — keep the confirm open so the user can retry.
        setDeleting(false);
        return;
      }
    }
    refreshSessions();
    if (isActive) router.push("/");
    setDeleteOpen(false);
    setDeleting(false);
  }, [handle, session.name, refreshSessions, isActive, router]);

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

      {/* TASK-69 — the row's actions kebab. It's a SIBLING of the nav Link above
          (not nested inside it), so a click here never triggers navigation. Hidden
          at rest; revealed on row hover / keyboard focus-within (showOnHover) and
          held open while the menu is (aria-expanded). Base UI Menu portals the
          popup, so it sits above the row without affecting layout. */}
      <Menu.Root>
        {/* Reveal the kebab on row hover, while the menu is open, or on KEYBOARD
            focus — deliberately NOT the primitive's `showOnHover`, whose
            `group-focus-within` reveal also fires for the mouse-click focus the
            trigger keeps after the menu closes, leaving the kebab stuck visible.
            `focus-visible` matches keyboard focus only, so a click-then-close
            hides it again while Tab access still works. */}
        <Menu.Trigger
          render={
            <SidebarMenuAction
              aria-label="Session actions"
              className="opacity-100 transition-opacity group-hover/menu-item:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 md:opacity-0 [&>svg]:size-3.5"
            />
          }
        >
          <MoreHorizontal strokeWidth={1.5} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className="min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none [&_svg]:size-4 [&_svg]:shrink-0">
              <Menu.Item
                onClick={openRename}
                className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent"
              >
                <Pencil strokeWidth={1.5} />
                Rename
              </Menu.Item>
              <Menu.Item
                onClick={() => setDeleteOpen(true)}
                className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10"
              >
                <Trash2 strokeWidth={1.5} />
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      {/* Rename dialog — a small form over the name.txt override. Enter commits
          (native form submit); the current name is pre-filled and selected. */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void commitRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
              <DialogDescription>
                This sets a display name only — the recording and its folder stay
                as they are.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-4">
              <Label htmlFor={`rename-${session.name}`}>Name</Label>
              <Input
                id={`rename-${session.name}`}
                autoFocus
                value={renameValue}
                disabled={renaming}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" disabled={renaming} />}>
                Cancel
              </DialogClose>
              <Button type="submit" disabled={renaming}>
                {renaming && <Loader2 className="animate-spin" strokeWidth={1.5} />}
                {renaming ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — same destructive copy + recursive folder removal as
          the session-view header (TASK-19). */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{session.displayName}”?</DialogTitle>
            <DialogDescription>
              This removes the recording, report and screenshots. Can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleting} />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <Loader2 className="animate-spin" strokeWidth={1.5} />
              ) : (
                <Trash2 strokeWidth={1.5} />
              )}
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarMenuItem>
  );
}

