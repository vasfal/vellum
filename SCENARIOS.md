# Vellum — Core user scenarios

The end-to-end flows v1 must support. Backlog tasks reference these as `Scenario SN`.
This is a spec of intended behaviour; `ARCHITECTURE.md` §Data flow is the canonical happy path (S2→S3→S4).

Status legend: ✅ done · 🔨 task(s) exist, not done · ❌ gap (no task) — resolved where noted.

| ID | Scenario | Covered by | Status |
|----|----------|-----------|--------|
| **S1** | **Onboarding.** First run → pick a workspace folder + see the privacy stance → persist the handle → restore on restart (soft re-grant if the browser requires it). | TASK-15 | ✅ |
| **S2** | **Record a review.** "New recording" → screen picker + mic + Document PiP controls → Stop → the recording is saved into the *workspace* as a new timestamp session folder. | primitives TASK-10/11/12/13/16 ✅; product flow TASK-25 ✅ (records into adopted workspace; unanalyzed session surfaced in sidebar, ADR-016) | ✅ |
| **S3** | **Analyze.** "Analyze" on a session → pipeline (upload→analyze→screenshots→report) → granular progress → writes tasks.json/report.md/screenshots into the session → navigate to the session view. Failure → explicit error + Retry (persist partial, no silent loop). Missing key → friendly screen. | pipeline TASK-3–9 ✅; TASK-26/27/28 ✅ (in-app analyze + progress + error/Retry); friendly key screen = TASK-29 | 🔨 |
| **S4** | **View a session.** Click a session → session view: video player + interactive task list + click-to-seek + screenshot previews + INCOMPLETE badge. | TASK-14/17/18 | ✅ |
| **S5** | **Re-analyze.** Re-run analysis on a session; prior report.md/tasks.json archived (ADR-009), manual edits preserved. | TASK-7 logic ✅; trigger in TASK-28 | 🔨 |
| **S6** | **Session naming.** Timestamp name → Gemini suggests a meaningful name → rename (collision suffix) → user can override. | TASK-22 ✅ (display-name model, ADR-017: folder stays a timestamp ID; Gemini `suggested_name` + manual `name.txt` override resolved for display; override survives re-analysis) | ✅ |
| **S7** | **Long recordings.** A recording over ~2 GB is segmented for Gemini with overlap + running summary. | TASK-9 | ✅ |
| **S8** | **Crash recovery.** A recording interrupted by a crash → orphaned `.crswap` → recovery-on-open card → one-click restore. | TASK-24 | ✅ |
| **S9** | **Session management.** Search across sessions; archive; delete a session. | TASK-19 (search/archive + delete) | 🔨 |
| **S10** | **Export.** Export the report to Notion / plain text. NOTE: the Markdown *is* already exported by design — `report.md` is a real file in the user's workspace folder (ADR-010); Notion/text integrations are the deferred v2 extension. | TASK-20 (gated, ADR-010) | 🔨 |
| **S11** | **API key / Settings.** Set up / check the Gemini key; a strong step-by-step screen if missing/invalid; a Settings area (key status, workspace, re-pick). | TASK-29 ✅ (/api/key-status presence-only; step screen; Settings + workspace re-pick). Key stays in `.env.local` (ADR-001); in-UI key config is deferred v2 (the git-clone+dev barrier, not the key, is what gates non-technical users). | ✅ |
| **S12** | **Validation gate.** Vasyl judges task quality on ≥3 real recordings across review types ("I would use these"). Informally passed once (calendar-review, first-draft prompt). | TASK-21 (In Progress, 1/3) | 🔨 |
| **S13** | **Analyze an existing video.** Import a pre-recorded `.webm`/`.mp4` (not record new) → copied into the workspace as a session → analyzed. The non-record entry point; today only possible via the CLI. | TASK-30 ✅ (webm+mp4; mp4 mime threaded through analyze) | ✅ |

## Two entry points to a session (both feed S3)

```
S2 record new   (TASK-25) ┐
S13 import video (TASK-30) ┘→ session in workspace → S3 analyze (TASK-26→27→28) → S4 view
```

## The bridge that makes S2/S3 real (ADR-014)

The pipeline is Node-only (ffmpeg, node:fs, server-side Gemini key); the workspace is a browser File System Access handle with no server-visible path. So analysis runs via a **stateless `/api/analyze`**: the browser POSTs the recording *bytes*, the server runs the pipeline on a temp copy and returns tasks + screenshot PNGs, and the browser writes the results into the workspace via the handle (browser-side writeReport). See ADR-014.
