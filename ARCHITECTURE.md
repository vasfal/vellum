# Vellum — Architecture

**Status:** Current locked state. This file is authoritative for what the system looks like NOW. It is overwritten as the system evolves, not appended. For history of decisions, see `DECISIONS.md`.

**Last updated:** 2026-07-03

---

## System overview

Vellum is a local-first Next.js application that runs at `localhost:4270` on the user's own machine. It records the screen + microphone, sends the recording to Google Gemini 2.5 Pro for analysis, extracts screenshots via ffmpeg, and writes a Markdown report to a user-chosen folder on disk.

There is no backend service, no database, and no authentication. Each user runs their own copy — installed from npm (`npx @vasfal/vellum ui`) or run from a git checkout — with their own Gemini API key.

## Components

### Frontend (browser)

Runs in the user's browser at `localhost:4270`. Built on Next.js 16 App Router, TypeScript strict, Tailwind v4, shadcn/ui.

Key responsibilities:
- Folder picker (File System Access API), handle persisted in IndexedDB
- Screen + mic capture via `getDisplayMedia` + `getUserMedia`
- Recording via MediaRecorder
- Floating recording controls via the Document Picture-in-Picture API (stays above all native windows)
- Writing recordings directly to the chosen folder
- Listing sessions by reading folder contents via the directory handle
- Displaying session reports with embedded video player and task list

Required browser: Chrome / Edge / Arc / Brave (File System Access API + Document Picture-in-Picture). Firefox and Safari are not supported.

### Backend (Next.js API routes)

Runs in the same Node process as the dev server. It is **stateless** and never touches the workspace folder — the browser has no filesystem path to hand it (ADR-014). Its filesystem access is limited to its own OS temp dir.

Key responsibilities:
- Receiving the recording **bytes** POSTed from the browser (not a path — ADR-014)
- Uploading recordings to the Gemini File API
- Calling Gemini with the multi-step analysis prompt + structured output schema
- Spawning ffmpeg-static to extract screenshots at timestamps
- Reporting whether a Gemini key is configured (presence only)

Reading/writing session artifacts is the **browser's** job, through the File System Access handle (there is no server-side session API — the server can't see the workspace). Session listing/reading = `lib/filesystem` (`scanSessions`, `session-data`); writing the report = the browser-side `writeReport` (ADR-014).

API routes (built):
- `POST /api/analyze` — stateless pipeline on posted bytes: temp file → `uploadVideo` → `analyze`/`analyzeLong` → `extractScreenshots`; streams NDJSON progress and returns the `AnalysisResult` + screenshot PNGs (base64). Never writes the workspace; temp dir always cleaned (TASK-26, ADR-014). Honours `req.signal` — a client Cancel aborts the pipeline between stages (ADR-021). The Gemini calls inside absorb transient 503/429 overload with bounded retry + a model fallback chain (ADR-021).
- `GET /api/key-status` — returns `{ present: boolean, source: "env" | "file" | null }` for `GEMINI_API_KEY`, read server-side; the key value is never serialized (TASK-29). `source` distinguishes a removable saved key (`file` = `~/.vellum/.env`) from one provided by an env var / `.env.local` (`env`, wins per `bin/vellum.mjs` precedence, not UI-removable) so the sidebar can offer or withhold Remove (TASK-65.1).
- `POST /api/key` — validates a candidate key with a **free** `models.get` probe (never `generateContent`, which bills) before persisting it to `~/.vellum/.env` (0600) + `process.env`, so a typo'd/revoked key is caught at setup, not mid-analyze; rejects with a non-echoing error. `DELETE /api/key` clears the `GEMINI_API_KEY` line (keeping other lines) + `process.env`, effective with no restart. Key material is never logged or echoed (TASK-64, TASK-65.1).

### External dependencies

- **Google Gemini 2.5 Pro** via `@google/genai` SDK. Cost ~$1–3 per hour of video.
- **ffmpeg-static** npm package. Binary is bundled in `node_modules/`, no system install required.

### Local storage layout

Inside the user's chosen workspace folder:

```
<workspace>/
├── .vellum-workspace.json      ← workspace marker (schema version, created date)
├── <session-name>/
│   ├── recording.webm          ← raw recording
│   ├── report.md               ← Markdown report (the current deliverable)
│   ├── report-<timestamp>.md   ← archived previous report versions
│   ├── tasks.json              ← current analysis (session marker; STORED shape, ADR-025)
│   ├── tasks-<timestamp>.json  ← archived previous task versions
│   ├── tasks.ai.json           ← immutable AI baseline of the live run (ADR-024; edited-markers/revert)
│   ├── tasks.ai-<timestamp>.json ← archived baselines (per run)
│   ├── comments.json           ← reviewer's comments on the live run (ADR-024, Comment mode)
│   ├── comments-<timestamp>.json ← archived comments (per run)
│   ├── name.txt                ← manual display-name override (ADR-017)
│   ├── screenshots/            ← latest run's frames
│   │   ├── 00-03-42.png
│   │   ├── 00-07-15.png
│   │   └── ...
│   └── screenshots-<timestamp>/ ← archived previous run's frames (ADR-023, per-run)
├── <another-session>/
└── ...
```

**Session naming:** Combo strategy. Folder is created with a timestamp name (`2026-06-30-14-30/`) at record time. After analysis, Gemini suggests a meaningful name (`onboarding-step-2-review/`) and the folder is renamed, with a name collision suffix (`-2`) if needed. The user can override the name manually at any point.

**Identity via markers (never assume structure):**
- The UI scans only the first level of the workspace folder.
- A subfolder is treated as a Vellum session only if it contains a `tasks.json` marker.
- The workspace root is marked with `.vellum-workspace.json`, written on first adoption.
- Foreign files/folders without markers are ignored — never rendered, never touched.
- A session folder with `tasks.json` but missing `recording.webm` or `report.md` is shown with an `incomplete` badge rather than hidden or crashing.
- Selecting a folder with no markers (e.g. a random folder) shows a friendly empty state, not an error; the first recording adopts it as a workspace.

## Locked decisions from intake brainstorm

### Aesthetic and UI direction
- **Dark + light themes** (ADR-019, reverses ADR-004's original dark-only lock). **Dark is the default**; a Light/Dark toggle sits in the sidebar footer. No System option. Light is Vercel/Geist-anchored (white content, light-gray panels, subtle black-alpha hairlines), built on the same semantic token layer as dark.
- **Monochrome** — no accent color. Visual hierarchy comes from contrast and typography (Vercel / Linear direction), not hue. (Applies within each theme; the sole hue exceptions remain `--destructive` and the ADR-018 priority tints.)
- **Typography:** Inter for UI, Geist Mono for timestamps and code. No separate editorial serif.
- **Density:** Linear-like — dense, information-forward, restrained whitespace.
- **Shell:** the content is a floating rounded panel on the sidebar-coloured base (shadcn `inset` variant); every screen's top bar is the single `PageHeader` component (ADR-020).
- **Animation:** governed by the installed `emil-design-eng` skill. Defaults: `ease-out` for enter animations, animate specific properties (never `all`), scale from `0.95` (not `0`), `:active` states on interactive elements, durations 150–250ms. Linear-style precision.
- No emojis in production UI, no gradients, minimal intentional elevation. Icons: Lucide, thin strokes.

### Recording defaults
- **Video codec:** VP9. **Audio codec:** Opus. Container: WebM.
- **Target bitrate:** ~2.5 Mbps (balance of UI-text legibility vs file size; ~1.1 GB per hour).
- **Resolution:** native screen resolution, capped at 1440p on the long side (sharp screenshots without 5K bloat).
- **Microphone:** ON by default, user can toggle off.
- **Pause/Resume + Stop** in v1.
- **Floating controls** via the Document Picture-in-Picture API: pause / stop / mic toggle / elapsed timer / rec indicator, floating above all windows. No global OS hotkey (impossible in-browser without a native helper; the PiP widget replaces it).
- **Long recordings (> ~1.8 h / approaching the 2 GB Gemini File API limit):** segment into parts with ~10–15 s overlap and a running-summary carried between segments to preserve timestamps and context. Treated as a normal path, not an error. (Tracked as a dedicated Phase 1 task.)

### Workspace folder strategy
- One folder per session (see layout above). Single workspace in v1.
- Combo naming (timestamp → Gemini-renamed → user-overridable).
- Report versioning: current `report.md` always points to the latest; prior versions archived with a timestamp suffix. Manual edits to a report are archived (never silently overwritten) when a re-analysis runs.

### Gemini prompt strategy
- **Multi-step pipeline** from the start (task quality is the v1 proof-of-concept gate):
  1. Structural overview of the video — what it is, detected `review_type`, overall context.
  2. Task extraction using that context.
  3. Screenshot timestamp selection.
- **Two-axis task model:**
  - `category` — fixed, exhaustive enum, identical for every video, describing the *nature* of the item: `problem | idea | question | decision | followup | praise`.
  - `review_type` — session metadata inferred in step 1, does **not** change the category enum: `ui_design | dev_vs_design | documentation | mixed | other`. The prompt adapts its attention to `review_type` while always emitting the same category set.
- **Verbosity:** rich descriptions (what was on screen + what was said + why it matters).
- **Language:** prompts default to **English** output; a per-analysis option (ADR-022) can instead emit **Ukrainian** (normalizing ukr/rus/surzhyk to clean Ukrainian). Fixed enum codes + `suggested_name` stay language-independent.

### Screenshot strategy
- Each task carries its own `screenshot_timestamp` — the moment the issue is best *visible* on screen, which may differ from when it was *spoken about*.
- **One** screenshot per task in v1.
- **Full frame** — no cropping in v1 (bounding-box crop is a possible later extension).
- **PNG** (sharp UI edges, crisp text), at the recording resolution (1440p cap).
- **Pairing task → file is by derived name, not a stored path.** `tasks.json` stores `screenshot_timestamp` but NOT the filename. The extractor (`lib/ffmpeg/extract-screenshots.ts`) names files `frame-MM-SS.png` from the timestamp's whole seconds, walking tasks in array order and suffixing `-2`, `-3`… on same-second collisions. The session view recovers the pairing by **replaying that exact algorithm** over the same tasks in the same order (`lib/filesystem/screenshots.ts` — the read-side mirror, kept client-safe). Deriving a name per task in isolation would mis-pair same-second collisions, so the two modules are a coupled contract: change the naming in one, change it in both (ADR-013). A derived name with no file on disk degrades to "no preview", never a crash.

### Session naming and management
- Combo naming as above. Sidebar sorts by recency (most recent session first). Names are user-editable.

### Error handling philosophy
- **Fail loud, never lose data, no silent retry loops.**
- Gemini fails mid-analysis (timeout / rate limit / model error): persist whatever was produced, show an explicit error with cause, offer a **Retry** button. Transient overload (503 "high demand" / 429) is absorbed automatically — bounded exponential-backoff retry, then a fallback down a model chain (pro → flash → flash-lite, ADR-021); only a non-transient failure surfaces to the user. Analysis runs in the app-level controller (ADR-021), so it survives navigation and is cancellable.
- Recording tab crash: MediaRecorder writes chunks via `timeslice` and each is streamed to disk through `createWritable()` as it arrives (TASK-12), so the partial recording survives rather than being lost. **Caveat (File System Access API):** `createWritable()` writes to a temporary swap file (`recording.webm.crswap`) and only renames it onto `recording.webm` on `close()`. A hard renderer crash therefore leaves the partial bytes in the `.crswap` sibling while `recording.webm` stays 0-byte — recoverable by renaming, and the WebM plays back truncated (verified at ~13 MB / 1881 frames after a `chrome://crash`). A *graceful* tab close instead aborts the stream and discards the swap, so only a real crash is recoverable. On workspace open, orphaned `.crswap` files are detected and surfaced for one-click recovery — a rename of the swap onto `recording.webm` (TASK-24, `lib/filesystem/recovery.ts` + the main-area recovery prompt). This is a **separate scan from the session list**: a crashed recording has no `tasks.json` marker, so it never appears in the ADR-008 session scan; the recovery scan keys off the `.crswap` orphan (present, with `recording.webm` missing/0-byte) instead.
- Missing / invalid API key: a strong, step-by-step screen (where to get a key, where to paste it), not a bare 401 toast.
- Folder permission revoked (browser restart → File System Access API re-grant): silently attempt to restore the handle from IndexedDB; if the browser requires confirmation, show a soft one-click "confirm access" screen, not an error.
- Workspace folder deleted/moved: invalid handle → "workspace unavailable, pick again", no crash.
- **Detailed analysis progress** (upload % → analyzing → extracting screenshot N/M → writing report), not a single opaque spinner.

### Privacy stance to surface in UI
- Onboarding states plainly: recordings and reports stay on your machine; the only data that leaves is the video sent to the Gemini API for analysis, under your own API key. No backend, no telemetry, no account.

## Data flow — happy path

1. User opens `localhost:4270`. On first run, picks a workspace folder. Handle stored in IndexedDB; `.vellum-workspace.json` written to the folder.
2. User clicks "New recording". Browser shows native screen picker (via `getDisplayMedia`). Microphone is captured separately (`getUserMedia`), on by default. A Document Picture-in-Picture window shows floating controls.
3. MediaRecorder runs, blob streams in via `dataavailable` events with timeslice to avoid OOM on long recordings.
4. User clicks Stop (in-page or on the PiP widget). Blob is finalized and written to a new timestamp-named session folder as `recording.webm`.
5. User clicks Analyze. The browser reads `recording.webm` through the workspace handle and POSTs the **bytes** to `POST /api/analyze` — the server has no path to a File-System-Access folder (ADR-014).
6. Server writes the bytes to a temp file, uploads to the Gemini File API, polls until ACTIVE. For long videos, segments with overlap.
7. Server runs the multi-step prompt (overview → tasks → screenshot timestamps) with `responseSchema`. Receives a validated JSON list of tasks.
8. Server spawns ffmpeg-static on the temp file to extract a PNG at each task's `screenshot_timestamp`.
9. Server streams progress and returns the validated `AnalysisResult` + the screenshot PNGs; the temp file is discarded. It never touches the workspace folder (ADR-014).
10. The browser writes `tasks.json`, `report.md`, and `screenshots/*.png` into the workspace session through the handle (a browser-side writeReport, ADR-009 archiving), then navigates to the session view.
11. Session view loads `report.md` data / `tasks.json` and the video file via the directory handle, renders interactive player + the report document.

## Editing the analysis (v1.1)

The session view's right pane is a **single interactive report document** (`report-document.tsx`, TASK-68.1) — the structured `tasks.json` (overview + each task) rendered as a markdown-like reading experience where every field is directly editable, always (the Google-Docs model). This **replaced** both the earlier Tasks/Markdown view switcher and the View/Edit/Comment **mode switcher** — there are no modes. `tasks.json` stays the source of truth; `report.md` remains a generated export (`render-report.ts`), re-rendered on each save.

- **Editing is always-on when `canEdit`** — the **live** run with a parsed analysis. Title / screen_context are plain inline text; **description** and the session **overview** are markdown-aware (edit raw markdown, render on blur, reusing react-markdown/remark-gfm via `markdown-text.tsx`); category (type) / priority are pills that open the shared `EnumSelect` dropdown. Each task's screenshot renders inline (resolved from its stored `screenshot` filename); clicking it seeks the player to the **visible** timecode. Discussed/visible **timecode chips** each seek (discussed = `task.timestamp`, visible = `screenshot_timestamp`). Hovering a task section reveals reorder / revert-to-AI / delete. Edits autosave on blur via a **non-archiving** save (`saveSessionEdits`): it writes `tasks.json` and re-renders `report.md` so the two never drift, and does **not** create a run. A field diverging from the run's immutable AI baseline (`tasks.ai.json`) shows a quiet edited-dot; one **task-level** "revert to AI" restores a task. Manual edits are in-place — they never version.
- An **archived / malformed** run renders the same document **read-only** (static pills, rendered markdown, no controls); the screenshot + timecode seeks still work. A "Go to latest run" button and the download kebab (Save as MD/JSON) live in the pane's header row.

Commenting was retired with the mode switcher and returns as **select-to-comment directly on the document** in a sibling task; its persistence (`comments-browser.ts`) and the comment→AI-revise loop (`run-revise.ts`) remain in the codebase, unwired, and each task section carries a `data-task-id` seam.

**The revise loop** turns comments into a new run. **Process comments** (default, text-only) sends the current tasks + comments to Gemini via the stateless `POST /api/revise` (no video) and writes a new versioned run; **Re-run with video** re-runs the full grounded pipeline + comments for fresh screenshots. Both **gate on the same pre-analysis config dialog** as a normal analysis (one component, `variant` = analyze / revise-text / revise-video — revise-text shows model + language only, ADR-026). Creating a run archives the prior run's `report.md` / `tasks.json` / `screenshots/` / `tasks.ai.json` / `comments.json` under one unified stamp (ADR-009/023); the new run starts edit- and comment-free. Runs carry an `origin` (`analyze` | `revise-text` | `revise-video`, telemetry only) and a stable short id (deterministic slug of the run stamp); the Details/Runs switcher shows both, marks the selected+edited live run "Edited", and offers "Go to latest run" while viewing an archive. **Re-analyze always creates a new version, no dialog; the prior version is preserved as-was.** See ADR-024/025/026.

Storage is layered over the untouched Gemini contract: `VellumTask`/`AnalysisResult` are the model's output shape; `StoredVellumTask`/`StoredAnalysisResult` (`tasks.json`) add `id`, `origin`, the resolved `screenshot` filename, and `note` (ADR-025). Screenshots pair by the stored filename, not by replayed derivation, so reorder/add/delete can't mis-pair frames.

## Pipeline contracts (Phase 1)

These are the seams between the CLI pipeline stages. They exist so the stages
(built as separate tasks, possibly in separate sessions) compose without
rework. The signatures are the stable surface — change them deliberately,
because a change here ripples across stages. The bodies are free to evolve.

```ts
// Shared types (TASK-4 owns the authoritative Zod schema)
type ReviewType = "ui_design" | "dev_vs_design" | "documentation" | "mixed" | "other";
type Category = "problem" | "idea" | "question" | "decision" | "followup" | "praise";

interface VellumTask {
  timestamp: string;            // "mm:ss" — when it was discussed
  screenshot_timestamp: string; // "mm:ss" — when it is best visible (may differ)
  title: string;
  description: string;
  screen_context: string;
  category: Category;
  priority: "low" | "med" | "high";
}

interface AnalysisResult {
  review_type: ReviewType;      // inferred in the overview step
  overview: string;
  tasks: VellumTask[];
}

// TASK-3 — upload. Throws on bad key / invalid file / timeout (max 1 retry).
uploadVideo(videoPath: string): Promise<{ fileUri: string }>;

// TASK-5 — multi-step analysis (overview -> tasks -> screenshot timestamps).
analyze(fileUri: string): Promise<AnalysisResult>;

// TASK-9 — long videos. Same output contract as analyze(); segmentation and
// global-timestamp remapping are hidden behind this boundary.
analyzeLong(videoPath: string): Promise<AnalysisResult>;

// TASK-6 — screenshots. Timestamps in seconds; PNGs at recording resolution.
extractScreenshots(videoPath: string, timestampsSec: number[], outDir: string): Promise<string[]>;

// TASK-7 — report. Archives any existing report.md first; writes tasks.json marker.
writeReport(input: {
  sessionDir: string;
  videoPath: string;            // relative link in the report
  result: AnalysisResult;
  screenshotPaths: string[];    // parallel to result.tasks
}): Promise<{ reportPath: string; tasksJsonPath: string }>;
```

The glue command (TASK-8) is the only place that orchestrates these:
`uploadVideo`/`analyzeLong` → `analyze` → map `screenshot_timestamp` to seconds
→ `extractScreenshots` → `writeReport`, emitting granular progress between steps.

## Constraints

- No persistent server state between dev server restarts
- All file I/O is on the user's local machine; we never proxy user data through a third party except for Gemini API calls
- API key never leaves the user's machine (`~/.vellum/.env`, or a dev checkout's `.env.local`)
- Workspace folder access is permission-granted by the user per session via File System Access API; permission is re-requested when handle is restored from IndexedDB

## Performance targets

- 30-minute recording → full report in under 5 minutes
- Recording UI must not stutter the screen capture (use a Web Worker for any browser-side processing during recording)
- Session list loads in under 200ms for workspaces with up to 100 sessions

## What's intentionally NOT here

- Backend services
- Database
- Authentication
- Cloud sync
- Multi-user
- Mobile UI
- Real-time transcription
- System audio capture
- Native macOS app
- Export integrations (Notion / Jira / etc.) and any extension point built for them — v2 territory, format undecided

If you find yourself adding any of the above, stop — these are v2 territory.
