# Vellum — Architecture Decision Records

This file is an append-only log of architectural decisions. Each decision is dated, has context, the decision itself, and consequences. We don't delete old decisions — if a decision is superseded, we add a new ADR that references the old one.

Format:
```
## ADR-NNN: <Short title>

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Superseded by ADR-NNN | Deprecated

### Context
Why this question came up. What forces are at play.

### Decision
What we decided to do.

### Consequences
What this means downstream — both good and constraining. What this decision rules out.
```

---

## ADR-001: Local-first architecture, no backend in v1

**Date:** 2026-06-30
**Status:** Accepted

### Context
Vellum's use case (designer reviewing their own work) doesn't require server-side state. Recordings are private and machine-local. Building backend infrastructure would add weeks of work, ongoing costs, and a permission model — none of which serve the v1 goal of "shipping a working tool for a small design team."

### Decision
Vellum v1 runs entirely on the user's machine. Each user clones the git repo and runs `npm run dev` to start a local Next.js server at `localhost:3000`. All persistence is on the user's filesystem. Each user has their own Gemini API key in `.env.local`. No database, no authentication, no deploy.

### Consequences
- ✅ Zero infrastructure cost, zero deploy complexity
- ✅ Maximum privacy — recordings never leave the user's machine except for the Gemini API call
- ✅ Distribution is `git clone` — trivial for the immediate team
- ❌ Cannot share live sessions between users
- ❌ Onboarding requires terminal comfort (mitigated with strong README + simple shell scripts)
- ❌ Future SaaS pivot requires reworking storage, auth, and team model
- ❌ Browser-only — File System Access API limits to Chrome / Edge / Arc / Brave

---

## ADR-002: Google Gemini 2.5 Pro as the analysis model

**Date:** 2026-06-30
**Status:** Accepted

### Context
The core value of Vellum is extracting structured tasks from a video review. The model must process both the visual (what's on the screen) and the audio (what the designer is saying) simultaneously — otherwise descriptions are mutually disconnected and task quality degrades. Alternatives considered: OpenAI (Whisper + GPT-5 with image sampling) and Anthropic (no native video input).

### Decision
Use Google Gemini 2.5 Pro via the `@google/genai` SDK and File API.

### Consequences
- ✅ Single API call processes the full video with vision + audio
- ✅ 1M+ token context easily holds a 1-hour recording
- ✅ Native structured output via `responseSchema`
- ✅ ~$1–3 per hour of video, cheapest of the three options
- ❌ Lock-in to one provider for the AI layer (acceptable in v1; abstraction can come later)
- ❌ Timestamps drift ±5–15s — we tolerate this for v1
- ❌ Transcript as side-product is lower quality than dedicated Whisper

---

## ADR-003: Recording via native browser APIs, no Electron

**Date:** 2026-06-30
**Status:** Accepted

### Context
Screen recording could be implemented natively (Swift / Electron + ffmpeg) for higher quality and system audio support, OR via the browser's `getDisplayMedia` and MediaRecorder for far simpler distribution.

### Decision
Use browser-native `getDisplayMedia` (screen) + `getUserMedia` (microphone) + MediaRecorder. Output WebM (VP9 + Opus).

### Consequences
- ✅ Zero native code, zero permissions plumbing on macOS (no TCC dance)
- ✅ Cross-platform identical (macOS, Windows, Linux)
- ✅ Distribution stays at `git clone`
- ❌ Cannot capture system audio when sharing full screen (browser limitation, not ours to fix)
- ❌ WebM is good-enough quality, not perfect
- ❌ Recording stops if the browser tab is closed mid-session

This is acknowledged as the right tradeoff for v1. Use case is "designer alone with mic + Figma," not "meeting transcription with multiple audio sources."

---

## ADR-004: Visual identity — dark-only, monochrome, Vercel/Linear direction

**Date:** 2026-06-30
**Status:** Accepted

### Context
Vellum is a tool for designers; its surface is part of the value proposition. We needed to lock a visual direction before building any UI so components stay coherent. Options ranged from a warm-neutral palette with an accent color (terracotta / olive / molten orange) to strict monochrome.

### Decision
Dark theme only in v1 (light deferred to v2). Strictly monochrome — no accent color; hierarchy comes from contrast and typography. Inter for UI, Geist Mono for timestamps/code, no separate editorial serif. Linear-like density (dense, information-forward, restrained whitespace). No emojis, no gradients, minimal intentional elevation, Lucide icons.

### Consequences
- ✅ A single, opinionated, hard-to-get-wrong visual language; fewer per-component decisions
- ✅ Reads as "Vercel/Linear", which matches the target audience's taste
- ❌ No light mode for users who prefer it until v2
- ❌ Monochrome leaves less room for category color-coding; categories must be distinguished by label/iconography instead of hue

---

## ADR-005: UI animation governed by the emil-design-eng skill

**Date:** 2026-06-30
**Status:** Accepted

### Context
Agents frequently pick wrong animation ingredients (ease-in on enter, scaling from 0, animating `all`). Rather than hand-specify every animation, we wanted a single source of craft truth that any session can consult.

### Decision
Install Emil Kowalski's skills (`emil-design-eng`, `animation-vocabulary`, `review-animations`) into the project (`.agents/skills/`, symlinked into `.claude/skills/`). All UI animation decisions defer to this skill. Defaults: `ease-out` for enter animations, animate specific properties (never `all`), scale from `0.95` not `0`, `:active` states on interactive elements, durations 150–250ms.

### Consequences
- ✅ Consistent, tasteful motion without re-deriving rules each session
- ✅ A reviewable standard (`review-animations`) to check UI against
- ❌ External skill dependency; if it changes upstream we re-pin manually (`skills-lock.json`)

---

## ADR-006: Multi-step Gemini pipeline with a two-axis task model

**Date:** 2026-06-30
**Status:** Accepted

### Context
Task quality is the v1 proof-of-concept gate. A single comprehensive prompt is cheaper and faster, but quality per step is lower. Separately, reviews come in different formats (Figma UI review, dev-vs-design review, documentation actuality review), each surfacing different findings — risking either an unstable, AI-invented category set per video, or categories hard-wired to format.

### Decision
Use a **multi-step** pipeline from the start: (1) structural overview + detect `review_type`, (2) task extraction with that context, (3) screenshot timestamp selection. Model task types on **two independent axes**: a fixed `category` enum identical for every video (`problem | idea | question | decision | followup | praise`) describing the nature of the item, and a `review_type` metadata field (`ui_design | dev_vs_design | documentation | mixed | other`) inferred in step 1 that tunes the prompt's attention but never changes the category enum. Descriptions are rich; tasks are always in English.

### Consequences
- ✅ Quality is maximized at the validation gate where it matters most
- ✅ Stable category set → consistent schema, filtering, and UI across all video formats
- ✅ Format-awareness preserved without fragmenting taxonomy
- ❌ ×2–3 cost and latency vs a single prompt (accepted for v1)
- ❌ More orchestration code and more failure points to handle

---

## ADR-007: Floating recording controls via Document Picture-in-Picture

**Date:** 2026-06-30
**Status:** Accepted

### Context
The user records while working in another app (Figma), so they need Loom-style always-on-top recording controls. A normal web page cannot draw an overlay above native OS windows, and a global OS hotkey is impossible in-browser without a native helper — both of which conflict with the no-Electron, no-native-code constraint.

### Decision
Use the Document Picture-in-Picture API (Chromium-only) to render a floating window with recording controls (pause / stop / mic toggle / elapsed timer / rec indicator) that stays above all windows. Drop the global hotkey; the PiP widget replaces it. Clicks on the widget work even when the main tab is not focused.

### Consequences
- ✅ True always-on-top controls with zero native code, within the browser constraint
- ✅ Fits the existing Chromium-only requirement (already implied by File System Access API)
- ❌ No keyboard-driven stop when the browser is fully unfocused
- ❌ Document PiP is Chromium-only and relatively new; another reason Firefox/Safari are unsupported

---

## ADR-008: Workspace and session identity via on-disk markers

**Date:** 2026-06-30
**Status:** Accepted

### Context
The web UI is tuned to a specific on-disk folder structure. If the UI assumes that structure and the user points it at an arbitrary folder (or foreign files sit alongside sessions, or a session is partially deleted), naive rendering would crash or display garbage.

### Decision
Never assume structure — verify it via markers. Write `.vellum-workspace.json` to the workspace root on first adoption. Treat a first-level subfolder as a Vellum session only if it contains a `tasks.json` marker. Ignore unmarked files/folders entirely. Show a session with `tasks.json` but missing `recording.webm`/`report.md` with an `incomplete` badge. A folder with no markers shows a friendly empty state (and the first recording adopts it), never an error.

### Consequences
- ✅ Robust against random folders, foreign content, and partial deletions
- ✅ Vellum never renders or touches files it didn't create
- ❌ A session is invisible if its `tasks.json` marker is deleted, even if other files remain
- ❌ Slightly more scanning/validation logic than a naive directory listing

---

## ADR-009: Report and task versioning; manual edits preserved

**Date:** 2026-06-30
**Status:** Accepted

### Context
Users will re-run analysis on a session with an improved prompt, and may hand-edit `report.md` (adding notes) before doing so. We must not silently destroy prior outputs or the user's manual edits.

### Decision
The current report is always `report.md` (stable link); prior versions are archived alongside as `report-<timestamp>.md`. Likewise `tasks.json` current + `tasks-<timestamp>.json` archives. Before a re-analysis overwrites `report.md`, the existing file (including any manual edits) is archived first. Edits are never silently overwritten.

### Consequences
- ✅ Full history; the "main" report link never breaks
- ✅ Manual annotations are always recoverable
- ❌ Session folders accumulate archived versions over time (acceptable; user can prune manually)

---

## ADR-010: No export integrations or extension points in v1

**Date:** 2026-06-30
**Status:** Accepted

### Context
Notion was floated as a possible export target, with the question of whether to build a format-agnostic export abstraction now. The v2 export target is genuinely undecided (could be Notion, Jira, or something else). Building abstraction for an unknown requirement is exactly the frameworks-over-shipping pattern this project guards against.

### Decision
No export integrations and no extension points built for them in v1. The only output is a Markdown report on disk. Revisit when a concrete v2 target is chosen.

### Consequences
- ✅ Keeps v1 minimal and focused on the validation gate
- ✅ Avoids premature abstraction over an undefined need
- ❌ A future export target may require refactoring report generation (accepted; cheaper than guessing wrong now)

---

## ADR-011: Spec-driven backlog — single-sourced spec, phase milestones, just-in-time detail

**Date:** 2026-06-30
**Status:** Accepted

### Context
The initial Phase 0/1 tasks read as thin — agreed behaviors (error philosophy, report versioning, markers, progress granularity) lived only in ARCHITECTURE.md/DECISIONS.md and were not traceable to any acceptance criterion. The pull was toward full Spec-Driven Development: write detailed, frozen specs for every phase up front. But Phase 1 is a validation gate precisely because it will change downstream assumptions (the task schema, screenshot reliability, report shape) — detailed specs for later phases would be rewritten, moving rework from code into specs.

### Decision
Keep the spec single-sourced in ARCHITECTURE.md + DECISIONS.md (DRY). Model the six phases as Backlog.md milestones (m-0..m-5). Each task gets a `References` line pointing at the governing ADR/section plus crisp, checkable acceptance criteria for its slice. Detail tasks just-in-time, one phase ahead; later phases exist as thin stubs so the whole arc and its dependencies are visible. Prevent cross-stage rework with a `Pipeline contracts` section in ARCHITECTURE.md (stable stage signatures), not with fat per-task specs. Encode phase gates as task dependencies (e.g. TASK-2 depends on TASK-5).

### Consequences
- ✅ Behaviors are traceable from tasks to the spec without duplicating it
- ✅ The full plan is visible (milestones + stubs + deps) so ordering problems surface early
- ✅ The "realize it's wrong" moment happens cheaply at the stub/contract level, not after frozen specs or code
- ✅ Guards against the frameworks-over-shipping pull (no premature detail for unvalidated phases)
- ❌ Stubs must be enriched before each phase starts — a recurring step, not one-time
- ❌ Spec and tasks can still drift if `References` aren't kept honest when docs change

---

## ADR-012: Independent verification gate before a task is Done

**Date:** 2026-06-30
**Status:** Accepted

### Context
TASK-3 (Gemini upload) was committed and closed as "verified end-to-end", but the documented command (`npm run upload -- video.webm`) did not actually work for anyone who set their key only in `.env.local` — nothing loaded `.env.local` into the environment. It passed in the implementing session only because that session had `GEMINI_API_KEY` exported in its shell, which masked the gap. The defect surfaced only because a separate orchestration session re-ran the acceptance criteria independently. Our workflow had acceptance criteria but no step that forced them to be exercised in a representative environment before Done; the Definition-of-Done field went unused, and v1 intentionally has no automated tests.

### Decision
Add an `In Review` status between `In Progress` and `Done`. The implementer sets `In Review` with evidence (command + output in the notes) and never marks its own work Done. A separate verifier — the orchestration session — independently exercises every acceptance criterion and is the only one that sets `Done`. Verification follows a clean-env rule: secrets come only from `.env.local`, never from shell-exported variables, mirroring a fresh `git clone`. A short per-task Definition of Done is filled in the backlog (typecheck clean, documented command actually run, clean-env, every AC exercised with evidence). This is a discipline, not a test harness, and does not override the "no automated tests in v1" stance.

### Consequences
- ✅ Catches "works in my shell" defects that self-review and code-review miss
- ✅ Reuses the two-session structure (implementer ≠ orchestrator) already in use — near-zero new infrastructure
- ✅ Evidence trail (command + output) lives in the task notes
- ❌ Adds a handoff: a task isn't Done until the orchestration session verifies it (slight latency)
- ❌ Relies on the verifier being disciplined about the clean-env rule; if the verifier also pollutes its env, the gate leaks
- ❌ Not a substitute for real tests once behavior stabilizes (revisit per CLAUDE.md)

---

## ADR-013: Screenshot ↔ task pairing by replayed naming; dual-seek semantics

**Date:** 2026-07-01
**Status:** Accepted

### Context
The session view (Phase 4) must show each task's extracted screenshot and let a click seek the player. Two problems surfaced. (1) `tasks.json` stores each task's `screenshot_timestamp` but not the screenshot's filename — the extractor (TASK-8/`extract-screenshots.ts`) derives `frame-MM-SS.png` from the timestamp, walking tasks in order and suffixing `-2`, `-3`… when two tasks land on the same whole second. Matching a task back to its file naïvely (derive the base name per task) would mis-pair any same-second collision. (2) A task carries two distinct moments — `timestamp` (when it was *discussed*) and `screenshot_timestamp` (when it is *visible*) — and it was ambiguous which one a click should seek to.

### Decision
Pair task → file by **replaying the extractor's exact naming algorithm** on the read side (`lib/filesystem/screenshots.ts`), a deliberate client-safe mirror of `extract-screenshots.ts` (which is Node-only). The two are a coupled contract: the naming lives in two places and must change together; a short comment in each points at the other. A derived name with no file on disk resolves to `null` → the view shows a placeholder, never crashes. Seek is **dual**: clicking a task row seeks to `timestamp` (hear the reasoning); clicking its screenshot seeks to `screenshot_timestamp` (see the frame). To keep this valid, accessible HTML the row is not a button wrapping the screenshot button — the row's primary action is a full-bleed overlay button and the screenshot is a sibling button layered above it.

### Consequences
- ✅ Same-second collisions pair correctly; verified 10/10 against `calendar-review` and on the 3×`00:00` `figma-flow-incomplete` fixture (collision + missing-file paths both exercised)
- ✅ Both moments are reachable without a mode toggle; the interaction reads as "row = talk, picture = look"
- ✅ Missing/duplicated screenshots degrade gracefully (ADR-008 spirit) instead of crashing
- ❌ Naming logic is duplicated across two modules (can't import the Node extractor into the client); a silent mismatch is possible if one side changes without the other — mitigated by cross-referencing comments and the ARCHITECTURE §Screenshot-strategy note, not by a shared module
- ❌ The read side can't clamp a past-the-end `screenshot_timestamp` the way the extractor does (no duration on the client), so such a task would show "no preview"; acceptable because `screenshot_timestamp` is by construction within the recording

---

## ADR-014: In-app analysis bridges the browser workspace and the Node pipeline via a stateless /api/analyze

**Date:** 2026-07-01
**Status:** Accepted

### Context
Phases 1–4 built the analysis pipeline as Node/CLI code — ffmpeg via `child_process`, `node:fs` writes to absolute paths, the Gemini key read server-side — while the product UI manages the workspace through the browser File System Access API, whose directory handle never exposes an absolute path to JS or the server (by browser design). So the in-app record→analyze→view loop was never wired: the recorder lives on a test page saving to a re-picked folder, analysis is CLI-only writing to `./vellum-sessions/`, and the UI can only *view* sessions that already exist in the workspace. The original Data-flow sketch ("the browser POSTs the file path to /api/analyze") can't work — there is no path to POST.

### Decision
The browser reads `recording.webm` through its directory handle and POSTs the **bytes** to `POST /api/analyze`. That route is a **stateless pipeline runner**: it writes the bytes to a temp file, runs `uploadVideo` → `analyze` (`analyzeLong` for large files) → `extractScreenshots` on that temp copy, and returns the validated `AnalysisResult` plus the screenshot PNGs, streaming progress (upload% → analyzing → extracting N/M → writing). The browser then writes `report.md`, `tasks.json`, and `screenshots/` into the workspace session through the handle — a **browser-side writeReport** mirroring TASK-7's logic (including ADR-009 archiving). The server never touches the workspace folder. The CLI (`npm run cli`) stays a dev/power-user path writing to `./vellum-sessions/`.

### Consequences
- ✅ Keeps the File System Access workspace model (TASK-12/15) intact; the server stays stateless (no workspace path, no persisted state)
- ✅ Local-first preserved: the key and ffmpeg stay server-side; no filesystem path ever leaks to the server
- ❌ The recording bytes are POSTed to the local server even though they already sit on disk — redundant I/O, acceptable at localhost
- ❌ `writeReport` now exists in two variants (Node for the CLI, browser for the app) — a coupled contract like the screenshot naming (ADR-013), kept in sync by cross-referencing comments, not a shared module
- ❌ Streaming progress + structured errors add API surface vs a single blocking call

---

## ADR-015: Report format single-sourced via render-report.ts (refines ADR-014)

**Date:** 2026-07-01
**Status:** Accepted

### Context
ADR-014 introduced a second (browser) writeReport and said the two variants are "kept in sync by cross-referencing comments, not a shared module" — the same posture as ADR-013's screenshot naming. But unlike the screenshot naming (a few lines that genuinely can't be shared because the Node extractor pulls in `child_process`), the report **format** is ~120 lines of pure string rendering with no Node dependency — cheap and safe to actually share. A comment-only sync would invite drift on the exact byte format, which AC#2 of TASK-27 requires to stay identical between the CLI and the app.

### Decision
Extract all pure render/format logic into a client-safe module `src/lib/report/render-report.ts` (no `node:*` imports). Both writeReport variants import it: the Node `write-report.ts` (with `node:fs` I/O) and the browser `write-report-browser.ts` (with File System Access `createWritable`/`removeEntry` I/O). Only the file-I/O halves differ; the format lives in exactly one place. `node:path` calls in the shared code are replaced by tiny POSIX string helpers (`relativize` is a hand-rolled `path.relative` for our descendant-only inputs). This **narrows** ADR-014's "not a shared module": for the render layer there now IS one; the I/O halves stay separate by necessity.

### Consequences
- ✅ The report format cannot drift between CLI and app — one source, verified byte-identical against the pre-refactor output (0-diff regression)
- ✅ `node:path` replaced by small POSIX string helpers, byte-identical on macOS/Linux
- ❌ `relativize` is a hand-rolled POSIX `path.relative` (fine for our descendant-only session paths; not a general cross-platform path lib)
- ❌ The screenshot-naming contract (ADR-013) stays comment-synced — only the report format got a shared module, so that coupling risk remains where it was

---

## ADR-016: Unanalyzed recordings are surfaced in the sidebar (refines ADR-008)

**Date:** 2026-07-01
**Status:** Accepted

### Context
ADR-008 made `tasks.json` the sole session marker: the sidebar scan shows only folders that carry it. But TASK-25 (record) and TASK-30 (import) create a `<timestamp>/recording.webm` folder that has **no** `tasks.json` until the user runs analysis. With the strict rule, a just-recorded session was invisible in the sidebar and reachable only by the URL the record flow navigated to — so navigating away **orphaned the recording** (a "never lose data" violation, caught in live validation of TASK-25).

### Decision
The sidebar scan (`scanSessions`) now also surfaces a folder that has a real recording (`recording.webm`/`.mp4`, non-zero bytes) but no `tasks.json`, as an `unanalyzed` session row (its own badge, alongside `incomplete`). Recency for such rows is the recording's own mtime. This does **not** loosen ADR-008's anti-foreign-folder stance: we still only surface folders holding a Vellum artifact (a recording or the marker), never arbitrary content. A **0-byte** `recording.webm` (a crash stub) is deliberately skipped — that is the crash-recovery scan's domain (TASK-24, keyed on the `.crswap` orphan), not a session row.

### Consequences
- ✅ A recorded/imported-but-not-yet-analyzed session is always reachable from the sidebar — no orphaned recordings
- ✅ Analysis stays a deliberate, explicit step (its cost/latency warrants a gate), without hiding the recording in the meantime
- ❌ The sidebar can now show two non-terminal states (`incomplete`, `unanalyzed`); the session view must render the unanalyzed state (recording + Analyze CTA), which it does (TASK-25)
- ❌ A cleanly-recorded folder whose analysis never runs lingers as `unanalyzed` until the user analyzes or deletes it (acceptable; deletion is TASK-19)

---

## ADR-017: Session naming is a display name, not a folder rename (refines ARCHITECTURE §Session naming)

**Date:** 2026-07-01
**Status:** Accepted

### Context
ARCHITECTURE §Local storage layout / §Session naming specified **combo naming**: after analysis, Gemini suggests a meaningful name and *the folder is renamed* (`2026-…/` → `onboarding-step-2-review/`), with a `-N` collision suffix, user-overridable. That model was written when the Node CLI owned writing. But since ADR-014 the **browser** owns all session writes through a File System Access directory handle — and that API **cannot rename a directory** (`move()` exists for files only; a session also has a `screenshots/` subfolder that can't be moved either). Renaming in-browser would mean recreating the folder and moving every file, fragile and pointless.

### Decision
Names are a **display concern**, not a folder operation. The session folder keeps its timestamp forever as the stable identity and URL slug (`/session/<timestamp>`). The effective display name resolves, in `render-report.ts` (shared, ADR-015), as:

```
override (name.txt)  >  suggested_name (tasks.json)  >  folder timestamp
```

- `suggested_name` — kebab-case English, produced by the Gemini overview step, validated in the schema (optional so pre-TASK-22 `tasks.json` still parses — ADR-008), persisted as a field of the `AnalysisResult` marker.
- A **manual override** is a separate `name.txt` sidecar in the session folder — deliberately NOT in `tasks.json`, so a re-analysis (which rewrites `tasks.json`) never clobbers it. The header offers inline rename.
- The sidebar, session-view header, and report title all read the effective name; the scan reads it best-effort (corrupt/absent → folder fallback, session still lists — ADR-008 spirit). The `-N` collision suffix is moot: display names may repeat, the folder timestamp is the unique key.

Both the CLI and the browser use this one model (the CLI does not rename its folders either), so naming is identical everywhere.

### Consequences
- ✅ Works within the File System Access API; no fragile directory moves or large-file copies
- ✅ Stable folder = stable URL and identity across renames and re-analysis; manual overrides survive re-analysis by construction (separate sidecar)
- ✅ One naming model for CLI and app, resolved in the shared render module
- ❌ The on-disk folder name stays a timestamp (not the pretty name) — a cosmetic gap if a user inspects the filesystem directly (the report title + UI carry the real name)
- ❌ The scan now reads `tasks.json`/`name.txt` per folder (best-effort) instead of only checking marker presence — slightly more I/O, and a second place the effective-name rule is consumed (kept single-sourced in `render-report.ts`)

---

## ADR-018: Task priority is the one place muted color is allowed (refines ADR-004)

**Date:** 2026-07-01
**Status:** Accepted

### Context
ADR-004 locked a strictly monochrome UI — hierarchy from contrast and typography, never hue. In the redesigned task list (TASK-33) the priority indicator (high/med/low) read weakly as three monochrome pills; Vasyl asked for color on priority specifically, "but muted, in the app's style," to make urgency scannable without turning the UI into loud status badges.

### Decision
Priority — and only priority — may carry a **muted, low-chroma** hue, a deliberate, narrow exception to ADR-004's monochrome rule. The tints are low chroma (≈0.09–0.10 in oklch) so they read as quiet, app-styled chips on the dark surface: high = a soft brick red, med = a soft amber, low stays neutral (a faint outline, no hue). Everything else stays monochrome — the category pill, badges, and all other chrome. Color is reserved for this single, meaningful signal.

### Consequences
- ✅ Urgency is scannable at a glance without a legend, while the UI stays restrained
- ✅ The exception is scoped to one element and one enum — it doesn't reopen "add accent color" generally
- ❌ ADR-004's "strictly monochrome, no hue" is no longer literally true; future color requests must clear the same bar (a single meaningful signal, muted, app-styled) rather than treating this as a precedent for decorative color

---

## ADR-019: Light theme + a Light/Dark toggle (reverses ADR-004's dark-only lock)

**Date:** 2026-07-02
**Status:** Accepted (reverses the dark-only clause of ADR-004)

### Context
ADR-004 locked a **dark-only** v1, with light deferred to v2, on the reasoning that a single opinionated palette is hard to get wrong. In practice the token system was already built theme-ready (a semantic layer over a 12-step gray ramp; shadcn primitives ship `dark:` variants), and Vasyl wanted a light option now. The cost was real but bounded — not a rewrite: rebuild the ramp for a light surface, retune the literal (non-ramp) tokens, and add a toggle.

### Decision
Ship **both** light and dark themes with a **Light/Dark** toggle in the sidebar footer (on the key-status row). **Dark is the default for everyone**; there is no System option (deliberately dropped as an unneeded third state). Mechanics:

- `next-themes` with the class strategy (`.light` / `.dark` on `<html>`), a blocking pre-paint script (no FOUC), `defaultTheme="dark"`, `enableSystem={false}`, `disableTransitionOnChange` (so a switch doesn't cross-fade every element at once). `<html suppressHydrationWarning>` because the class is client-applied.
- Dark tokens live under `:root, .dark` (dark stays the pre-JS default); a `.light` block overrides. The light ramp is **not a naive inversion** — it is Vercel/Geist-anchored: white content, light-gray panels (`~#f2f2f2`), generous low-end tonal steps so a selected row/card reads on white (the dark gray-1→3 step is ~0.06; the light ramp matches it, not ~0.02), subtle **black-alpha** hairlines (heavier borders read as boxes on white), a light-tuned `--destructive`, and light-surface priority tints.
- The ADR-018 priority tints were moved from inline `oklch(...)` in the task list into CSS tokens (`--priority-high/med` + `-foreground`) so they theme per surface.

This **narrows ADR-004**: the dark-only clause is reversed, but the rest of ADR-004 (monochrome — hierarchy from contrast/typography, not hue) still governs **within each theme**, and ADR-018's priority-color exception holds in both.

### Consequences
- ✅ Light and dark are both first-class; the switch is instant and flash-free
- ✅ The theme-ready token layer paid off — most of the change was one `.light` block; shadcn `dark:` variants became meaningful instead of dead
- ✅ Priority tints are now single-sourced tokens (themeable), tidying the ADR-018 inline values
- ❌ Every screen must now be validated in **both** themes (a standing cost on new UI), and any hardcoded color (e.g. the video letterbox `bg-black`) must be a deliberate both-theme choice
- ❌ ADR-004's "dark theme only in v1" is no longer true; this is the documented reversal. Future palette work must keep both themes coherent

---

## ADR-020: App shell is a floating content panel on the sidebar surface; one PageHeader everywhere

**Date:** 2026-07-02
**Status:** Accepted

### Context
The original shell was a flush sidebar + an edge-to-edge content area. Moving toward a Linear/Factorial feel (especially now that light mode exists, ADR-019), the content should read as a card floating on the sidebar's background. Separately, the top bar had drifted into two implementations — a shared `PageHeader` (home, settings) and a bespoke `<header>` inside the session view — which silently diverged (the session view got a shorter, lighter header; the others stayed tall/bold).

### Decision
1. **Floating inset shell.** Use shadcn's `variant="inset"` sidebar: the shell wrapper takes `bg-sidebar`, and the content is a rounded panel that floats with an even margin on all sides (a hairline border + a light shadow), clipped corners. The wrapper is pinned to `h-svh` and the session view fills the panel with `h-full` (not `h-svh`) so the panel's bottom margin isn't overshot. The sidebar's horizontal inset padding is stripped (`px-0!`) so it sits flush with the base; its logo band matches the header height (`h-12`) so the wordmark aligns with the page title across the boundary.
2. **One header.** `PageHeader` is the single top-bar component for every screen. It accepts a string title (wrapped in `FadeText`) **or** a custom title node (the session view passes its editable title), plus trailing `children` for badges/menus. The session view no longer builds its own `<header>`. Header height, title style (`h-12`, `text-[15px] font-medium`), and the divider live in one place and can't drift again.

### Consequences
- ✅ The content reads as a floating card on the sidebar surface in both themes; the look matches the Linear reference
- ✅ The header can't diverge — height/title/border are single-sourced in `PageHeader`; new screens get it for free
- ✅ Session-view keeps its editable title + actions menu while sharing the shell (title-node slot)
- ❌ Relies on shadcn's `inset` variant classes; the few overrides (`px-0!`, `m-2!`, `shadow-xs!`) are important-flagged and would need revisiting if the sidebar primitive changes
- ❌ Any screen that needs a top bar must go through `PageHeader` — a bespoke `<header>` would reintroduce the drift this ADR removes

---

## ADR-021: Background, cancellable analysis + Gemini overload resilience (retry → model fallback)

**Date:** 2026-07-02
**Status:** Accepted (extends ADR-002, ADR-014; refines ARCHITECTURE §Error handling)

### Context
Analysis state lived inside `SessionView` (`useAnalyze`) and aborted on unmount, so navigating between sessions killed the run and there was no Cancel. Separately, `gemini-2.5-pro` is frequently overloaded (503 "high demand"): a first analysis failed almost every time and only a manual Retry (minutes later) succeeded — each failed call is *slow* (~30s), so a single-shot pipeline hangs then fails. The record flow also stopped at an un-analyzed session (manual Analyze), and import ran a **separate** analysis in a modal — two divergent flows for the same thing.

### Decision
1. **App-level analysis controller.** `AnalysisProvider` (mounted above the router, above `SessionActionsProvider`) owns the single in-flight run, keyed by session name, exposing `analyze(name)` / `cancelAnalyze()` / `analysis` / `errors` / `completions`. One run at a time (the CTA blocks elsewhere). A run survives navigation; the session view and each sidebar row read it. Cancel asks for confirmation and aborts the client stream **and** the server pipeline (`/api/analyze` now honours `req.signal`, checking between stages). A page reload aborts (nothing persisted server-side — stateless, ADR-014).
2. **Auto-analyze + one flow.** Finishing a recording auto-starts analysis in the background (Cancel is always available). Import was consolidated onto the same controller: pick → copy (a spinner on the trigger, no progress modal) → navigate → `analyze(name)`. A modal shows only on a terminal pick/copy error; analysis errors live in the session view (Retry there), exactly like a recording.
3. **Overload resilience.** `runStructured` (every model call) retries transient 503/429 with bounded exponential backoff, then **falls back down a model chain**: `gemini-2.5-pro` → `gemini-2.5-flash` → `gemini-2.5-flash-lite` (ADR-002's model is always tried first; each fallback trades quality for capacity). Fallback fires only for transient overload; auth / empty / bad-output fail loud. **Every model id is live-verified against the API before use** — a model that merely appears in `models.list` can still be retired (`gemini-2.0-flash` was, and a non-transient "no longer available" error broke the whole chain). Fallback tiers are `GEMINI_FALLBACK_MODELS`-overridable.

### Consequences
- ✅ Analysis is a real background job: survives navigation, cancellable, visible in the sidebar + header; record and import share one flow and one progress surface
- ✅ The common pro-overload spike is absorbed automatically (retry + fallback) instead of failing the first run; analysis completes even when both 2.5 tiers are saturated
- ✅ Cancel actually stops server work (req.signal), not just the client read
- ❌ Extends ARCHITECTURE's "no silent retries / one model" stance: bounded transient retries + a quality-degrading fallback now exist. A fallback run is currently **not** surfaced to the user (which model produced it) — deferred to TASK-44 (badge + re-analyze-with-pro)
- ❌ Model ids are an external contract that can be retired without notice; adding a tier requires a live `generateContent` check, not just `models.list`
- ❌ The worst case (every tier transiently down) still fails after ~6 attempts — acceptable, and Cancel is available to bail

---

## ADR-022: Output language is selectable (English default, Ukrainian normalizes) — extends ADR-006

**Date:** 2026-07-02
**Status:** Accepted (extends ADR-006 §Language)

### Context
ADR-006 / ARCHITECTURE hard-wired all extracted output to English, even for Ukrainian speech. But not every review is convenient in English, and the team is ~90% Ukrainian with some Russian / surzhyk. A naïve "keep the original language" option is a trap: on surzhyk/Russian speech it would emit surzhyk/Russian, which reads as messy, inconsistent task text.

### Decision
Make the output language a **selectable, per-analysis dimension** (alongside model + mode — TASK-47), threaded into the prompts: `en` (default, byte-identical to before) or `uk`. `uk` does **not** preserve the "original" — it instructs Gemini to **normalize** whatever was spoken (Ukrainian / Russian / surzhyk) into **clean standard Ukrainian** for the natural-language fields (overview, task title/description, screen_context). The fixed schema codes (`category`, `review_type`, `priority`) and `suggested_name` (kebab-ASCII folder id) stay language-independent. The chosen language is recorded in the run metadata (TASK-45). English remains the default.

### Consequences
- ✅ Ukrainian-first team gets native-language tasks; the surzhyk/Russian input problem is solved by normalizing to clean Ukrainian rather than preserving it
- ✅ English stays a first-class, default option (cross-team, consistent); the `en` prompt path is unchanged
- ✅ Language is captured per run, so the info tab (TASK-48) can show it
- ❌ ADR-006's "always English" is no longer literally true; task-quality iteration (TASK-21) now has a second axis (language) to spot-check
- ❌ Only two languages are wired (`en`/`uk`); adding more is a prompt + enum change, but each needs its own quality check

---

## ADR-023: Per-run screenshot archiving + a unified run stamp (extends ADR-009)

**Date:** 2026-07-02
**Status:** Accepted (extends ADR-009; enables TASK-51 run-switching)

### Context
TASK-51 lets the user view an older analysis run (its archived `tasks-<stamp>.json` + `report-<stamp>.md`) against the same recording. But ADR-009 archived only `report.md` and `tasks.json` on a re-analysis — `screenshots/` always held just the LATEST run's frames. So an older run's report showed "no preview" for every frame that had since changed, gutting the value of the version history (comparing runs is the whole point). Two smaller problems compounded it: (1) each artifact was archived under its OWN `lastModified` second, so a run's `report-<stamp>.md` and `tasks-<stamp>.json` could carry different stamps (a manual edit or a second-boundary split) — the read side then had to *guess* the pairing; (2) there was no per-run home for frames at all.

### Decision
1. **Archive screenshots per run.** On a re-analysis, before the new frames are written, the live `screenshots/` folder is archived to `screenshots-<stamp>/` (Option B). The latest run's frames stay in `screenshots/`; every superseded run keeps its own `screenshots-<stamp>/`. The browser writer (`write-report-browser.ts`) — the real in-app re-analysis path — owns this: it writes frames itself, so it can copy the prior `screenshots/` into the stamped folder then remove it (the File System Access API has **no atomic directory rename**, so it's copy-every-file-then-remove, and the fresh run recreates `screenshots/`).
2. **One unified run stamp.** A re-analysis computes a SINGLE canonical stamp for the run being superseded — the current `report.md`'s last-modified second, falling back to `tasks.json`'s, then now — and uses it for all three archives: `report-<stamp>.md`, `tasks-<stamp>.json`, `screenshots-<stamp>/`. A same-second re-analysis reserves one shared `-N` suffix across all three (never a per-artifact divergence). The read side (`loadArchivedRun`) now pairs report ↔ tasks ↔ screenshots by that exact shared stamp — no more mtime guessing.
3. **Node/CLI writer** (`write-report.ts`) mirrors the unified stamp for `report`/`tasks`. It deliberately does **not** archive screenshots: in the Node contract the new frames are extracted into `screenshots/` *before* `writeReport` runs, and the CLI always writes a fresh session dir — so there is never a prior `screenshots/` to archive, and archiving there would misfile the current run. The naming (`screenshotsArchiveName`) is single-sourced in `render-report.ts` so both writers and the reader agree (ADR-015).

### Consequences
- ✅ Older runs show their OWN screenshots; the run-switcher (TASK-51) is genuinely useful for comparing model/mode/language across runs
- ✅ report ↔ tasks ↔ screenshots pair by one exact stamp — the pairing fragility flagged in TASK-51 Option A is gone
- ✅ Naming is single-sourced; browser + Node + reader can't drift
- ❌ Storage grows by a FULL frame set per historical run (each `screenshots-<stamp>/` duplicates every PNG). Accepted — sessions are local and the user can prune archives manually (ADR-009 already accepted archive accumulation)
- ❌ The browser archive is copy-then-remove (no atomic dir rename); a crash mid-archive could leave a partially-copied `screenshots-<stamp>/` beside an intact `screenshots/`. Non-fatal: the read side treats any missing frame as "no preview" (ADR-013), and the live run is untouched
- ❌ Legacy runs archived before this ADR have no `screenshots-<stamp>/` (and possibly divergent report/tasks stamps) — those older runs degrade to "no preview" / a hidden Markdown tab, exactly as under Option A. Only runs archived from here on carry frames

## ADR-024: Editable analysis results — three modes (View / Edit / Comment) + a comment→AI-revise loop

**Date:** 2026-07-02
**Status:** Accepted (refines ADR-009 versioning; extends ADR-006 pipeline; the v1.1 headline)

### Context
v1's output is entirely **read-only**: `tasks.json` → `report.md` → session view, with no path back to editing. The roadmap's v1.1 headline is making the generated content user-editable/annotatable — a blocker for real use (a reviewer must correct, augment, and annotate the extracted tasks, not just consume them). Two distinct needs surfaced, and conflating them was the first planning mistake: (1) **direct manual correction** of what Gemini got wrong (fast, precise, no AI cost), and (2) **plannotator-style annotation that feeds back INTO Gemini** for regeneration.

### Decision
The session view gains a **mode switcher**: **View** (read-only, current behavior), **Edit**, **Comment**.

- **Edit mode — direct manual editing.** Inline editing of all task fields + `category`/`priority` (enum dropdowns) + `overview`. `tasks.json` and `report.md` stay **synchronized on every edit** (autosave on blur). Edited fields carry a quiet **"edited" marker** with a per-field **"revert to AI"**, diffed against an immutable **AI baseline of the current run** held in a sidecar `tasks.ai.json`. Manual structural edits (**add / delete / reorder** tasks) live here too. Edit-mode edits are **in-place on the current version — they do NOT create a new run**; a **non-archiving save path** writes `tasks.json` + re-renders `report.md`.

- **Comment mode — the plannotator loop.** Select text (anchored to `taskId` + field + quote) or add a **global** comment; comments accumulate in a `comments.json` sidecar for the current version. A **"Process comments"** action sends the current tasks + all comments **in bulk to Gemini**, which regenerates a revised `AnalysisResult` (may restructure — add / remove / rewrite tasks). This creates a **new run/version**; the prior version (with its comments) is archived as-is.

- **Two revise flavors.** "Process comments" defaults to a **text-only** Gemini call (current tasks + comments, **no video re-upload** — fast/cheap; a genuinely-new timestamp with no existing frame degrades to "no preview"). A **separate explicit action re-runs the revision WITH video** (full grounding + fresh screenshot extraction, slower/costly).

- **Versioning.** Versions are created **only by AI actions** (Process comments, Re-analyze). **Re-analyze always creates a new version by default, no dialog**; the prior version is preserved exactly as at click-time (existing ADR-009/023 archiving already does this — an earlier plan draft invented an unneeded confirm dialog; dropped).

### Consequences
- ✅ A reviewer can both correct directly (Edit) and steer Gemini via annotations (Comment); the annotate→regenerate loop is the plannotator essence and the thing that makes Vellum a working tool, not a one-shot generator
- ✅ Manual edits are cheap/in-place; AI regenerations are versioned and comparable via the run switcher
- ✅ Text-only revise keeps the feedback loop light and cheap; a video re-run is available when grounding matters
- ❌ Introduces stored task identity + provenance sidecars (schema/ids in ADR-025); `tasks.json` becomes **user-owned** while `tasks.ai.json` holds the AI baseline (inverts the `name.txt` precedent, ADR-017)
- ❌ Comment anchoring across structured fields is **best-effort** (quote-based); an Edit that changes the quoted text degrades a comment to task-level rather than span-level
- ❌ Adds a Gemini **"revise"** entry point (text-only) distinct from "analyze"; run telemetry (ADR-021, TASK-45/48) must record revise runs

---

## ADR-025: Stored task identity + screenshots paired by stored filename (refines ADR-013)

**Date:** 2026-07-02
**Status:** Accepted (refines ADR-013; extends ADR-006 schema; enables ADR-024)

### Context
ADR-013 pairs each task to its screenshot by **replaying** the extractor's naming algorithm (`frame-MM-SS.png`, walked in **array order** with `-N` collision suffixes) on the read side — deliberately **not** storing the filename. That is correct only while task order and membership are fixed. Editing (reorder / add / delete — ADR-024) changes both, so a replay **mis-pairs**. Separately, editable content needs **stable per-task identity** for provenance (edited markers, revert), comment anchoring, and structural edits — but `VellumTask` (the Gemini contract) has no `id`.

### Decision
- **A storage layer over the Gemini contract.** `VellumTask`/`AnalysisResult` stay the model's **output** shape (so `assertSchemasAgree()` and `ANALYSIS_RESPONSE_SCHEMA` are untouched). New `StoredVellumTask`/`StoredAnalysisResult` layer on top and are what `tasks.json` actually holds. `StoredVellumTask` adds: `id` (assigned **at write time**, never by Gemini), `origin` (`ai` | `human`), `screenshot` (the resolved frame filename), `note` (per-task human annotation). `StoredAnalysisResult` adds a session-level `note`. Human-added tasks **relax optionals** (`timestamp`/`screenshot_timestamp`/`screen_context` optional; `title` stays required, `.min(1)`).
- **Screenshots pair by the stored `task.screenshot` filename, not by replay.** The derive-by-replay algorithm (`screenshots.ts`) is used **only once — at initial analysis write** — to assign each task's filename; thereafter reorder/add/delete just move the array and the filename stays attached. The reader uses `task.screenshot` with a **derive-fallback** for legacy `tasks.json`.
- **Back-compat / lazy upgrade.** Legacy `tasks.json` (no `id`/`screenshot`/provenance) still parses. On the **first edit** it is upgraded in place: assign `id`s, snapshot the AI baseline into `tasks.ai.json`, resolve `screenshot` filenames via one last replay. Sessions that are never edited are left untouched.

### Consequences
- ✅ Reorder / add / delete are safe; the order-dependent replay fragility (ADR-013's flagged risk) is gone for stored tasks
- ✅ Stable `id`s enable provenance, comment anchoring, and structural edits
- ✅ The Gemini contract and the two-representation schema check are unchanged
- ❌ `tasks.json` grows per-task fields; a second schema (`Stored*`) is layered over the Gemini one
- ❌ The derive-by-replay mirror (ADR-013) survives only as the initial-write **namer** + a legacy fallback; the coupling comment stays but its blast radius shrinks
- ❌ Orphaned PNGs (from deleted tasks) linger unreferenced on disk (harmless; not pruned in v1.1)

---

## ADR-026: v1.1 editing UI — comment-highlight is a second sanctioned tint; revise actions share the analysis config gate

**Date:** 2026-07-03
**Status:** Accepted (extends ADR-018 monochrome exception; extends ADR-024 the revise loop; refines ADR-047/TASK-47 config)

### Context
While building the v1.1 editing UI (ADR-024's View/Edit/Comment modes) two cross-cutting decisions surfaced in design review and are worth recording. (1) Comment mode needs commented / selected text to *read as highlighted* — the plannotator convention — which a monochrome `<mark>` didn't convey. (2) The two AI-spending revise actions (**Process comments**, **Re-run with video**) initially fired **without** the pre-analysis config (model / mode / language + estimated cost) that a normal analysis always shows — breaking the "always ask before a model call" consistency.

### Decision
- **Comment-highlight yellow — the second sanctioned hue.** Commented spans, the in-progress (pending) selection while a composer is open, and the live `::selection` in Comment mode carry a **muted yellow** highlight, driven by CSS tokens (`--comment-highlight` / `-foreground`, low-chroma, per-theme) exactly like the ADR-018 priority tints. This is the **second** exception to ADR-004's monochrome rule and clears the same bar ADR-018 set: a **single meaningful signal** (this text is / will be annotated), muted and app-styled, not decorative. The highlight lives on the **card text**, not the popover — the composer's quote excerpt stays plain.
- **Revise shares the analysis config gate.** Both Process comments (text-only) and Re-run with video route through the **same** pre-analysis config dialog as analyze — one parameterized component, `variant: "analyze" | "revise-text" | "revise-video"`. `revise-video` shows the full config (model + mode + language, full-video cost, it IS the analyze pipeline); `revise-text` shows **model + language only** (mode is moot for a single text pass) with a text-only cost estimate; both seed their defaults from the current run. No model-spending action fires without the config step.

### Consequences
- ✅ Comment annotation reads like a highlighter in both themes; the only colors in the UI are the meaningful signals (priority, edited-marker, comment-highlight)
- ✅ Every model call — analyze and both revise flavors — is preceded by an explicit model/language(/mode) + cost choice; no surprise spend
- ✅ One config dialog, three variants — no forked UI
- ❌ ADR-004's monochrome now has **two** documented tint exceptions (priority, comment-highlight); a third must clear the same bar
- ❌ The `revise-text` cost estimate is approximate (a token-count heuristic over the tasks+comments payload, not a metered count)

---

## ADR-027: Public launch form — npx-launched local app, home-config key, MIT/open-source

**Date:** 2026-07-03
**Status:** Accepted (prepares the TASK-52 "one tool, two surfaces" direction; supersedes the README's prior "Private — not for redistribution" stance)

### Context
Vellum's web loop (record → analyze → review → edit → comment) is a complete product on its own; the CLI (TASK-52/53) is an amplifier, not a missing half. To ship publicly as an open-source product for strangers without waiting on the shared-core refactor, three decisions were made and are worth recording. The gating one: the API key lived in a repo-local `.env.local` read at server start — which cannot work for a globally-installed app run from an arbitrary folder.

### Decision
- **The web app is the tool; `vellum` is just its front door.** A small plain-ESM bin (`bin/vellum.mjs`, TASK-62) provides `vellum ui`: load `~/.vellum/.env` → grab a free port (prefers 4270) → `next start` on the prebuilt `.next` → open the browser. Distribution is npm-native (`npx vellum ui`), **not** `curl | sh` (an anti-pattern for a browser-driven local app). The tarball ships a clean production build only — `prepack` does `rm -rf .next && next build`, because an all-of-`.next` `files` whitelist otherwise packs the ~1 GB dev cache and `.npmignore` is ignored under `files`. `vellum analyze` is reserved (TASK-53).
- **The Gemini key moves to `~/.vellum/.env`, edited in-app (TASK-64).** `POST /api/key` persists it there (0600, non-destructive merge) **and** sets `process.env.GEMINI_API_KEY` on the running server, so it takes effect with no restart (the pipeline reads the key at request time). The setup screen becomes a real input, not file-editing instructions. Real env / a dev checkout's `.env.local` still wins over the home file.
- **The repo goes MIT and public (TASK-63).** `private: true` removed, `LICENSE` added, README rewritten for a stranger (constraints box up top, npx quickstart, image slots, contribution templates). Internal onboarding docs (BOOTSTRAP, README-FOR-VASYL) relocated under `docs/internal/`; ARCHITECTURE/DECISIONS/SCENARIOS stay public as build signal.

### Consequences
- ✅ A stranger installs and runs Vellum in one line with no file editing; the public launch is decoupled from the TASK-52/53 CLI epic
- ✅ Key handling now works for a global install and stays private (home dir, 0600, never logged/echoed); TASK-52 later folds this bin into the shared "two surfaces" entry point
- ⚠️ `prepack` is macOS/Linux-only (`rm -rf`) and rebuilds on every pack/publish; the actual `npm publish` is a deliberate maintainer action, still pending
- ⚠️ The README's hero screenshot + demo GIF are unshipped placeholders (`docs/assets/`) — the one launch item that needs a human's visual asset

---

## ADR-028: API-key management for the public launch — validate on save, source-aware removal, soft first-run gate

**Date:** 2026-07-03
**Status:** Accepted

### Context
Before the open-source launch, key handling had gaps (TASK-65): the sidebar key status was mount-only (stale after an in-app add/remove) and, when a key was present, a dead `<div>` with no way to change or remove it; a wrong/revoked key read as "present" and only failed loud during a long analyze upload; a first run with no key dropped the user into the app with no next step; and source precedence was invisible — if an env var *and* `~/.vellum/.env` both existed, the env var won but the UI wrote/showed the file ("I removed it but it still works").

### Decision
1. **Validate on save, not at analyze.** `POST /api/key` probes a candidate with a free `models.get` call (auth required, never `generateContent` — that bills) before persisting, rejecting an authentication-invalid key with a clear, non-echoing error. A transient/unreachable failure does *not* reject (don't block a valid key over a blip).
2. **Effective removal + source awareness.** New `DELETE /api/key` strips the key from `~/.vellum/.env` *and* `process.env`, no restart. `GET /api/key-status` gains `source: "env" | "file" | null` (heuristic: effective key byte-matches the file ⇒ `file`/removable; else ⇒ `env`/shadowed, not UI-removable). The sidebar offers Remove only for `file` keys and explains the `env` case in a tooltip.
3. **Live, event-driven status.** A shared `useKeyStatus()` hook + `notifyKeyChanged()` broadcast (`vellum:key-changed` window event, refetch on focus) — no polling. Saving or removing a key flips every consumer (sidebar row, first-run gate) with no reload. Removal confirmation is a modal (not inline).
4. **Soft first-run gate.** With no key, the sessions empty state rebuilds into a single "add your key" step (one CTA → `/settings/key`), not a second competing surface; Record/Import stay in the sidebar so the app is still navigable. Loading/error degrade to the normal empty state.

### Consequences
- ✅ A typo'd/revoked key is caught at setup; the whole key lifecycle (add → validate → change → remove) is doable from the UI with no file editing or restart — the newcomer story for `npx vellum ui`.
- ✅ The `env` vs `file` distinction makes "I removed it but it still works" impossible to hit silently.
- ✅ Free probe only — no billed call anywhere in the key flow.
- ❌ Source detection is a heuristic (byte-match against the file); an exported var identical to the file value would read as `file`. Acceptable — pathological and harmless (removal still clears `process.env`).
- ❌ Validate-on-save adds one network round-trip (bounded by an 8s timeout) to saving a key.

---

## ADR-NNN: <Next decision here>

<!-- Add new decisions below as they happen. Number sequentially. Don't reuse numbers. -->
