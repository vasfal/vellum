"use client";

import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// TASK-68.1 — the shared, read-only Markdown renderer for the interactive report
// document. Mined from the (removed) report-view.tsx component map so the rendered
// prose keeps its monochrome, restrained look (ADR-004): hierarchy from contrast +
// typography, no accent hue, thin rules. Used to render a task's description and
// the session overview after an inline edit blurs (raw markdown → rendered), while
// the raw text remains the source in tasks.json.
//
// Deliberately text-only: descriptions/overviews are prose, not image galleries
// (a task's screenshot is rendered separately, from its stored frame filename), so
// a stray relative <img> degrades to its alt text rather than a broken request.

// The component map is stable across renders (no external inputs), so build it once.
const COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-1 mb-2 text-base font-semibold tracking-tight text-foreground">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-sm font-semibold tracking-tight text-foreground">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-[13px] font-semibold tracking-tight text-foreground">
      {children}
    </h3>
  ),
  // Tight paragraph spacing so a single-paragraph description reads as one block,
  // not a loose stack. first/last margins are trimmed by the prose wrapper.
  p: ({ children }) => (
    <p className="my-2 text-[13px] leading-relaxed text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong className="font-medium text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children }) => <span className="text-foreground underline">{children}</span>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-muted-foreground/50 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-muted-foreground/50 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground/90 first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-sidebar px-1 py-0.5 font-mono text-[12px] text-foreground">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-sidebar p-3 font-mono text-[12px] leading-relaxed text-foreground first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-4 border-border" />,
  // Prose images (rare) degrade to their alt text — a report's real frames render
  // from the stored screenshot filename elsewhere, never through the description.
  img: ({ alt }) => (
    <span className="text-[13px] italic text-muted-foreground/70">
      {typeof alt === "string" ? alt : ""}
    </span>
  ),
};

export function MarkdownText({ text }: { text: string }) {
  // ReactMarkdown re-parses on every render otherwise; memoize on the text so a
  // parent re-render (e.g. a sibling field editing) doesn't re-parse every block.
  return useMemo(
    () => (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    ),
    [text],
  );
}
