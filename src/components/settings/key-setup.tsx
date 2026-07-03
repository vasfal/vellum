"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notifyKeyChanged } from "@/lib/key-status/use-key-status";
import type { KeyWriteResult } from "@/app/api/key/route";

// The Gemini-key setup screen (TASK-29, reworked in TASK-64). Once file-editing
// instructions; now a real input. The user pastes a key, we POST it to
// /api/key, which persists it to ~/.vellum/.env and sets it on the running
// server (no restart), then we send them into the app.
//
// Privacy holds by construction (ARCHITECTURE §Privacy): the key is masked in
// the field, sent once over the local loopback to our own server, and never
// echoed back. This screen still only ever tells the user where a key GOES.

const AISTUDIO_URL = "https://aistudio.google.com/apikey";

type Status =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "error"; message: string }
  | { state: "saved" };

export function KeySetup() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });

  const saving = status.state === "saving";
  const trimmed = key.trim();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (trimmed.length < 20 || saving) return;
    setStatus({ state: "saving" });
    try {
      const res = await fetch("/api/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      const data = (await res.json()) as KeyWriteResult;
      if (!res.ok || !data.ok) {
        setStatus({ state: "error", message: data.error ?? "Couldn't save the key." });
        return;
      }
      // Flip the sidebar (and any other live consumer) to "Key configured"
      // right away — independent of whether/when the user navigates on.
      notifyKeyChanged();
      setStatus({ state: "saved" });
    } catch {
      setStatus({ state: "error", message: "Couldn't reach the local server. Is Vellum still running?" });
    }
  }

  if (status.state === "saved") {
    return (
      <div className="mx-auto w-full max-w-lg animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
          <Check className="size-5 text-green-500" strokeWidth={2} />
        </div>
        <h1 className="mt-4 text-lg font-medium tracking-tight">Key saved</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Stored in <code className="font-mono text-[13px]">~/.vellum/.env</code> and active now —
          no restart needed. You&apos;re ready to analyze.
        </p>
        <Button
          className="mt-6"
          onClick={() => {
            router.push("/");
            router.refresh();
          }}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    // ease-out enter; scale from 0.95, ~200ms (ADR-005 / emil-skill).
    <div className="mx-auto w-full max-w-lg animate-in fade-in-0 zoom-in-95 duration-200 ease-out">
      <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
        <KeyRound className="size-5" strokeWidth={1.5} />
      </div>
      <h1 className="mt-4 text-lg font-medium tracking-tight">
        Set up your Gemini API key
      </h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Vellum analyzes recordings with the Google Gemini API under your own key.
        It&apos;s stored in <code className="font-mono text-[13px]">~/.vellum/.env</code> on this
        machine — it never leaves the server.
      </p>

      <ol className="mt-8 space-y-6">
        <li className="flex gap-3">
          <Step n={1} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium">Get a key from Google AI Studio</p>
            <a
              href={AISTUDIO_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
            >
              aistudio.google.com/apikey
              <ExternalLink className="size-3" strokeWidth={1.5} />
            </a>
          </div>
        </li>

        <li className="flex gap-3">
          <Step n={2} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium">Paste it here</p>
            <form onSubmit={save} className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    if (status.state === "error") setStatus({ state: "idle" });
                  }}
                  placeholder="AIza…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={status.state === "error"}
                  className="font-mono"
                  disabled={saving}
                />
                <Button type="submit" disabled={trimmed.length < 20 || saving}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
              {status.state === "error" && (
                <p className="text-sm text-destructive">{status.message}</p>
              )}
            </form>
          </div>
        </li>
      </ol>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-xs text-muted-foreground">
      {n}
    </span>
  );
}
