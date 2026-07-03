import type { ReactNode } from "react";

import { FadeText } from "@/components/fade-text";
import { SidebarTrigger } from "@/components/ui/sidebar";

// The app's ONE top bar — the sidebar toggle + a page title + optional trailing
// actions. Every top-level screen (home, settings, the session view) renders
// through this so the header height, title style and border live in a single
// place and can't drift.
//
// `title` is usually a string (wrapped in FadeText so it fades on overflow); pass
// a node instead when the title needs custom behaviour — the session view passes
// its own editable title here. A custom node owns its own `min-w-0 flex-1` so it
// takes the space and pushes `children` to the right.
export function PageHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
      <SidebarTrigger className="-ml-1.5" />
      {typeof title === "string" ? (
        <FadeText className="min-w-0 flex-1 text-[15px] font-medium tracking-tight">
          {title}
        </FadeText>
      ) : (
        title
      )}
      {children}
    </header>
  );
}
