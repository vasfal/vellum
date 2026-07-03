import type { CSSProperties } from "react";

import { AnalysisProvider } from "@/components/analysis/analysis-provider";
import { AppSidebar } from "@/components/app-sidebar";
import { SessionActionsProvider } from "@/components/recording/session-actions";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { WorkspaceProvider } from "@/components/workspace/workspace-provider";

// The base app shell: sidebar + main area, structure only (TASK-2).
// `--sidebar-width` is driven from globals.css per breakpoint (240px ≥1200,
// 200px 768–1200) via a var() reference so the responsive cascade wins over
// the literal the provider would otherwise inline.
export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // WorkspaceProvider gates the shell: until a workspace is ready it renders
    // the onboarding / re-grant / unavailable screen instead of the sidebar +
    // content below (TASK-15).
    <WorkspaceProvider>
      <SidebarProvider
        className="h-svh"
        style={{ "--sidebar-width": "var(--app-sidebar-width)" } as CSSProperties}
      >
        {/* Analysis state lives above the router so a run survives session
            navigation and shows in the sidebar + session view (TASK-42). It sits
            ABOVE SessionActionsProvider so the record flow can auto-start an
            analysis the moment a recording is saved. */}
        <AnalysisProvider>
          {/* Owns the single recorder + import flow, so both the sidebar and the
              empty state trigger the same flows (TASK-40). Inside WorkspaceProvider,
              which only renders here once the workspace is ready — so the recorder
              always has a workspace handle. */}
          <SessionActionsProvider>
            <AppSidebar />
            {/* Floating content panel (Linear "card on the sidebar background").
                m-2! overrides the inset variant's ml-0 so it floats on every side
                (incl. a gap from the sidebar and the bottom); a hairline border +
                clipped corners + a lighter shadow than the variant's default. */}
            <SidebarInset className="m-2! overflow-hidden rounded-xl border border-border shadow-xs!">
              {children}
            </SidebarInset>
          </SessionActionsProvider>
        </AnalysisProvider>
      </SidebarProvider>
    </WorkspaceProvider>
  );
}
