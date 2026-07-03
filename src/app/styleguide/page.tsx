import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  WorkspaceOnboarding,
  WorkspaceRegrant,
  WorkspaceUnavailable,
} from "@/components/workspace/workspace-screens";

// /styleguide — the component workbench for ALL Phase 3 UI (TASK-2). Every new
// component is built and iterated here, in isolation (no app shell), before
// being wired into real screens. It renders the design tokens (palette, type
// scale, spacing, radius) and the shadcn primitives in their key states.
//
// The primitives are not re-authored per component: they read the semantic
// tokens defined in globals.css, so retheming happens at the token layer. The
// Vellum aesthetic (ADR-004 dark/monochrome) flows through automatically.

export const metadata = {
  title: "Styleguide — Vellum",
};

const NAV = [
  { href: "#color", label: "Color" },
  { href: "#type", label: "Type" },
  { href: "#spacing", label: "Spacing" },
  { href: "#radius", label: "Radius" },
  { href: "#components", label: "Components" },
  { href: "#workspace", label: "Workspace" },
];

// Monochrome surface ramp — kept in sync with :root in globals.css.
const RAMP = [
  { name: "gray-1", role: "app background" },
  { name: "gray-2", role: "raised surface / card" },
  { name: "gray-3", role: "sidebar / inset" },
  { name: "gray-4", role: "hover / muted fill" },
  { name: "gray-5", role: "pressed / active" },
  { name: "gray-6", role: "strong border" },
  { name: "gray-7", role: "—" },
  { name: "gray-8", role: "disabled foreground" },
  { name: "gray-9", role: "focus ring / placeholder" },
  { name: "gray-10", role: "—" },
  { name: "gray-11", role: "muted foreground" },
  { name: "gray-12", role: "foreground" },
];

const SEMANTIC = [
  { token: "background", fg: "foreground" },
  { token: "card", fg: "card-foreground" },
  { token: "popover", fg: "popover-foreground" },
  { token: "primary", fg: "primary-foreground" },
  { token: "secondary", fg: "secondary-foreground" },
  { token: "muted", fg: "muted-foreground" },
  { token: "accent", fg: "accent-foreground" },
  { token: "destructive", fg: "background" },
];

const TYPE_SCALE = [
  { cls: "text-3xl font-semibold tracking-tight", label: "3xl · semibold" },
  { cls: "text-2xl font-semibold tracking-tight", label: "2xl · semibold" },
  { cls: "text-xl font-medium", label: "xl · medium" },
  { cls: "text-lg font-medium", label: "lg · medium" },
  { cls: "text-base", label: "base · regular" },
  { cls: "text-sm", label: "sm · regular (UI default)" },
  { cls: "text-xs text-muted-foreground", label: "xs · muted (labels)" },
];

// 4px base unit (Tailwind default --spacing). Shown as a representative subset.
const SPACING = [1, 2, 3, 4, 6, 8, 12, 16];

const RADII = [
  { cls: "rounded-sm", label: "sm" },
  { cls: "rounded-md", label: "md" },
  { cls: "rounded-lg", label: "lg" },
  { cls: "rounded-xl", label: "xl" },
];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 border-t border-border py-12">
      <div className="mb-8">
        <h2 className="text-lg font-medium tracking-tight">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

// A labeled cell — the small caption pattern used across the guide.
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-center rounded-lg border border-border bg-card p-4">
        {children}
      </div>
      <span className="text-center font-mono text-[0.7rem] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

export default function Styleguide() {
  return (
    <div className="mx-auto min-h-svh max-w-5xl px-6 pb-24">
      <header className="sticky top-0 z-10 -mx-6 mb-2 flex flex-col gap-3 border-b border-border bg-background/80 px-6 py-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">
            Vellum Styleguide
          </h1>
          <p className="text-xs text-muted-foreground">
            Component workbench · dark-only · monochrome (ADR-004)
          </p>
        </div>
        <nav className="flex flex-wrap gap-1">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      {/* COLOR ------------------------------------------------------------ */}
      <Section
        id="color"
        title="Color"
        description="Strictly monochrome. Hierarchy comes from contrast, never hue. The surface ramp is the source of truth; semantic tokens alias onto it."
      >
        <h3 className="mb-3 text-xs font-medium text-muted-foreground">
          Surface ramp
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {RAMP.map((step) => (
            <div key={step.name} className="flex flex-col gap-2">
              <div
                className="h-16 rounded-lg border border-border"
                style={{ background: `var(--${step.name})` }}
              />
              <div className="leading-tight">
                <div className="font-mono text-xs">{step.name}</div>
                <div className="font-mono text-[0.7rem] text-muted-foreground">
                  {step.role}
                </div>
              </div>
            </div>
          ))}
        </div>

        <h3 className="mt-10 mb-3 text-xs font-medium text-muted-foreground">
          Semantic tokens
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SEMANTIC.map((item) => (
            <div
              key={item.token}
              className="flex h-20 flex-col justify-between rounded-lg border border-border p-3"
              style={{
                background: `var(--${item.token})`,
                color: `var(--${item.fg})`,
              }}
            >
              <span className="font-mono text-xs">{item.token}</span>
              <span className="font-mono text-[0.7rem] opacity-70">Aa</span>
            </div>
          ))}
        </div>
      </Section>

      {/* TYPE ------------------------------------------------------------- */}
      <Section
        id="type"
        title="Typography"
        description="Inter for UI, Geist Mono for timestamps and code. No editorial serif."
      >
        <div className="space-y-5">
          {TYPE_SCALE.map((row) => (
            <div
              key={row.label}
              className="flex flex-col gap-1 border-b border-border pb-5 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
            >
              <span className={row.cls}>The quick brown fox</span>
              <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">
                {row.label}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 text-xs font-medium text-muted-foreground">
            Geist Mono — timestamps & code
          </h3>
          <div className="space-y-2 font-mono text-sm">
            <p>
              <span className="tabular-nums">00:03:42</span>
              <span className="text-muted-foreground"> → screenshot_timestamp</span>
            </p>
            <p className="text-muted-foreground">
              const result = await analyze(fileUri);
            </p>
          </div>
        </div>
      </Section>

      {/* SPACING ---------------------------------------------------------- */}
      <Section
        id="spacing"
        title="Spacing"
        description="4px base unit (Tailwind's default scale). Density is Linear-like — dense, restrained whitespace."
      >
        <div className="space-y-3">
          {SPACING.map((step) => (
            <div key={step} className="flex items-center gap-4">
              <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                {step}
              </span>
              <div
                className="h-3 rounded-sm bg-foreground/80"
                style={{ width: `calc(var(--spacing) * ${step})` }}
              />
              <span className="font-mono text-[0.7rem] text-muted-foreground">
                {step * 4}px
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* RADIUS ----------------------------------------------------------- */}
      <Section
        id="radius"
        title="Radius"
        description="Base radius is 0.5rem (8px) — tighter than the shadcn default, closer to Linear."
      >
        <div className="flex flex-wrap gap-6">
          {RADII.map((r) => (
            <Cell key={r.label} label={r.label}>
              <div className={`size-16 bg-muted ${r.cls}`} />
            </Cell>
          ))}
        </div>
      </Section>

      {/* COMPONENTS ------------------------------------------------------- */}
      <Section
        id="components"
        title="Components"
        description="shadcn primitives reading the Vellum tokens, shown in their key states."
      >
        {/* Button — variants */}
        <h3 className="mb-4 text-xs font-medium text-muted-foreground">
          Button · variants
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
        </div>

        {/* Button — states (forced classes mirror button.tsx exactly) */}
        <h3 className="mt-10 mb-4 text-xs font-medium text-muted-foreground">
          Button · states
        </h3>
        <div className="flex flex-wrap gap-6">
          <Cell label="default">
            <Button>Button</Button>
          </Cell>
          <Cell label="hover">
            <Button className="bg-primary/80">Button</Button>
          </Cell>
          <Cell label="active">
            <Button className="translate-y-px bg-primary/80">Button</Button>
          </Cell>
          <Cell label="focus">
            <Button className="border-ring ring-3 ring-ring/50">Button</Button>
          </Cell>
          <Cell label="disabled">
            <Button disabled>Button</Button>
          </Cell>
        </div>

        {/* Input — states */}
        <h3 className="mt-10 mb-4 text-xs font-medium text-muted-foreground">
          Input · states
        </h3>
        <div className="grid max-w-2xl grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sg-default">Default</Label>
            <Input id="sg-default" placeholder="Session name" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sg-focus">Focus</Label>
            <Input
              id="sg-focus"
              placeholder="Session name"
              className="border-ring ring-3 ring-ring/50"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sg-disabled">Disabled</Label>
            <Input id="sg-disabled" placeholder="Session name" disabled />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sg-invalid">Invalid</Label>
            <Input id="sg-invalid" placeholder="Session name" aria-invalid />
          </div>
        </div>

        {/* Tabs (interactive) */}
        <h3 className="mt-10 mb-4 text-xs font-medium text-muted-foreground">
          Tabs
        </h3>
        <Tabs defaultValue="overview" className="max-w-md">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="disabled" disabled>
              Disabled
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="text-sm text-muted-foreground">
            Overview panel content.
          </TabsContent>
          <TabsContent value="tasks" className="text-sm text-muted-foreground">
            Tasks panel content.
          </TabsContent>
        </Tabs>

        {/* Card */}
        <h3 className="mt-10 mb-4 text-xs font-medium text-muted-foreground">
          Card
        </h3>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Onboarding review</CardTitle>
            <CardDescription>12 tasks · 24 min · ui_design</CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground">
            A representative session card — structure only.
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Open</Button>
            <Button size="sm" variant="ghost">
              Rename
            </Button>
          </CardFooter>
        </Card>

        {/* Separator + Skeleton + Dialog */}
        <h3 className="mt-10 mb-4 text-xs font-medium text-muted-foreground">
          Separator · Skeleton · Dialog
        </h3>
        <div className="flex max-w-md flex-col gap-6">
          <div>
            <p className="text-sm">Above</p>
            <Separator className="my-3" />
            <p className="text-sm text-muted-foreground">Below</p>
          </div>

          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>

          <Dialog>
            <DialogTrigger
              render={<Button variant="outline" className="w-fit" />}
            >
              Open dialog
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete session?</DialogTitle>
                <DialogDescription>
                  This removes the report and screenshots from disk. This cannot
                  be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" />}>
                  Cancel
                </DialogClose>
                <DialogClose render={<Button variant="destructive" />}>
                  Delete
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </Section>

      {/* WORKSPACE -------------------------------------------------------- */}
      <Section
        id="workspace"
        title="Workspace onboarding"
        description="First-run gate screens (TASK-15). Shown full-screen by WorkspaceProvider; framed here for review, with no handlers wired."
      >
        <div className="grid gap-6">
          <Frame label="onboarding (first run)">
            <WorkspaceOnboarding />
          </Frame>
          <Frame label="needs-permission (soft re-grant after restart)">
            <WorkspaceRegrant folderName="design-reviews" />
          </Frame>
          <Frame label="unavailable (folder moved / deleted)">
            <WorkspaceUnavailable folderName="design-reviews" />
          </Frame>
        </div>
      </Section>
    </div>
  );
}

// A fixed-height viewport for the full-screen gate screens, so they can be
// reviewed inline without taking over the page.
function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="h-[560px] overflow-hidden rounded-lg border border-border">
        {children}
      </div>
      <span className="font-mono text-[0.7rem] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
