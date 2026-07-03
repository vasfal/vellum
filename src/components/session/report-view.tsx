"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff, Loader2 } from "lucide-react";

import {
  loadReportContent,
  screenshotKeyFromSrc,
} from "@/lib/filesystem/report-content";

// TASK-34 — the Markdown side of the session view's Tasks/Markdown switcher.
// Renders the on-disk report.md (authored by render-report.ts) as formatted
// Markdown, resolving its relative screenshot links against the live workspace
// handle. Dark/monochrome, restrained (ADR-004): the report should read like the
// document it is, not a loud page. Only mounted when the session has a report.md.

type ReportState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; markdown: string; screenshots: Map<string, File> };

export function ReportView({
  workspace,
  name,
  reportFile = "report.md",
  screenshotsDir = "screenshots",
  reloadToken = 0,
}: {
  workspace: FileSystemDirectoryHandle;
  name: string;
  /** Which report to render: the live report.md, or an ADR-009 archive
   *  (report-<stamp>.md) when viewing an older run (TASK-51). */
  reportFile?: string;
  /** Which frames folder to resolve images against: the live screenshots/, or a
   *  run's screenshots-<stamp>/ when viewing an older run (ADR-023). */
  screenshotsDir?: string;
  /** TASK-57 — bumped after a manual edit is saved so this pane re-reads the
   *  freshly re-rendered report.md (keeps tasks.json ↔ report.md in sync on screen). */
  reloadToken?: number;
}) {
  const [state, setState] = useState<ReportState>({ status: "loading" });

  // On-demand: only reads the report + screenshots when this pane is mounted
  // (i.e. the user switched to Markdown). Re-loads if the session, the selected
  // run (reportFile / screenshotsDir), or a save (reloadToken) changes.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadReportContent(workspace, name, reportFile, screenshotsDir)
      .then(({ markdown, screenshots }) => {
        if (!cancelled) setState({ status: "ready", markdown, screenshots });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, name, reportFile, screenshotsDir, reloadToken]);

  if (state.status === "loading") {
    return (
      <PaneShell>
        <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
          Loading report…
        </div>
      </PaneShell>
    );
  }

  if (state.status === "error") {
    return (
      <PaneShell>
        <p className="px-1 py-3 text-sm text-muted-foreground">
          Couldn&apos;t read <code className="font-mono">report.md</code> for this
          session.
        </p>
      </PaneShell>
    );
  }

  return (
    <PaneShell>
      <Report markdown={state.markdown} screenshots={state.screenshots} />
    </PaneShell>
  );
}

// The scroll container for the Markdown pane — matches TaskListPane's surface so
// the switch between views doesn't shift the column's background.
function PaneShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background px-5 py-4">
      {children}
    </div>
  );
}

function Report({
  markdown,
  screenshots,
}: {
  markdown: string;
  screenshots: Map<string, File>;
}) {
  const urls = useScreenshotUrls(screenshots);

  // Memoize the component map so react-markdown doesn't re-instantiate renderers
  // on every keystroke-less re-render; it only changes when the URLs do.
  const components = useMemo<Components>(
    () => ({
      // Resolve each relative screenshot link to its object URL by basename. A
      // frame with no matching file on disk degrades to a quiet placeholder.
      img: ({ src, alt }) => {
        const key = typeof src === "string" ? screenshotKeyFromSrc(src) : "";
        const url = urls.get(key);
        if (!url) return <MissingImage alt={typeof alt === "string" ? alt : ""} />;
        return (
          // eslint-disable-next-line @next/next/no-img-element -- object URL from a local File, not a remote asset next/image can optimize
          <img
            src={url}
            alt={typeof alt === "string" ? alt : ""}
            className="my-4 w-full rounded-md border border-border"
          />
        );
      },
      // report.md's only link is the recording ([recording.webm](recording.webm)).
      // There's nothing to navigate to in-app, so links render as plain, inert
      // text rather than dead anchors.
      a: ({ children }) => (
        <span className="text-foreground">{children}</span>
      ),
      h1: ({ children }) => (
        <h1 className="mt-1 mb-3 text-xl font-semibold tracking-tight text-foreground">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="mt-7 mb-2 text-base font-semibold tracking-tight text-foreground">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="mt-5 mb-2 text-sm font-semibold tracking-tight text-foreground">
          {children}
        </h3>
      ),
      p: ({ children }) => (
        <p className="my-3 text-[13px] leading-relaxed text-muted-foreground">
          {children}
        </p>
      ),
      strong: ({ children }) => (
        <strong className="font-medium text-foreground">{children}</strong>
      ),
      ul: ({ children }) => (
        <ul className="my-3 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-muted-foreground/50">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="my-3 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-muted-foreground/50">
          {children}
        </ol>
      ),
      blockquote: ({ children }) => (
        <blockquote className="my-4 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground/90">
          {children}
        </blockquote>
      ),
      code: ({ children }) => (
        <code className="rounded bg-sidebar px-1 py-0.5 font-mono text-[12px] text-foreground">
          {children}
        </code>
      ),
      pre: ({ children }) => (
        <pre className="my-4 overflow-x-auto rounded-md bg-sidebar p-3 font-mono text-[12px] leading-relaxed text-foreground">
          {children}
        </pre>
      ),
      hr: () => <hr className="my-6 border-border" />,
    }),
    [urls],
  );

  return (
    <div className="mx-auto max-w-2xl">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

// A dropped screenshot — the file the report references isn't on disk. Quiet, in
// the aspect the frames render at, so the report doesn't jump or crash.
function MissingImage({ alt }: { alt: string }) {
  return (
    <span className="my-4 flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-card text-muted-foreground">
      <ImageOff className="size-5" strokeWidth={1.5} />
      <span className="px-4 text-center text-xs text-muted-foreground/70">
        {alt || "Screenshot not found"}
      </span>
    </span>
  );
}

// Build one object URL per screenshot File and revoke them all when the file set
// changes or the pane unmounts (the useObjectUrl pattern, for a whole Map). A
// report can reference a dozen frames; leaking their blobs would add up.
function useScreenshotUrls(files: Map<string, File>): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    const next = new Map<string, string>();
    for (const [key, file] of files) {
      next.set(key, URL.createObjectURL(file));
    }
    setUrls(next);
    return () => {
      for (const url of next.values()) URL.revokeObjectURL(url);
    };
  }, [files]);

  return urls;
}
