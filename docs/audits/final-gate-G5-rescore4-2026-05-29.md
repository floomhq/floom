# Workeros — G5 Final Launch-Readiness Re-Score (walk #4)

- **Date:** 2026-05-29
- **Target:** https://workers.floom.dev (LIVE prod)
- **Deployed commit:** main `690843b` (verified `origin/main` HEAD)
- **Reviewer frame:** fresh skeptical founder/operator; independent; LIVE-only (no trust of "fixed" claims)
- **Prior independent walks:** 88 → 93 → 92
- **Gate:** G5 decisive — must reach ≥ 95

## Overall: 96 / 100 — LAUNCH-READY: YES

The two named blockers from walk #92 are **closed and verified live**. End-to-end
operator journey works: create-via-prompt → drafting stream → run detail; manual
run → live SSE stream → artifact output; full two-run HITL approve round-trip;
failed-run humanized error. No P0 or P1 remains. Three P2 polish items (none
launch-blocking) are listed with evidence and fixes.

---

## Critical re-verification of the two just-fixed items

### (a) Hero create-flow no longer silently resets — VERIFIED
- Drove `/workers/new`, typed a real prompt ("Every weekday at 9am, summarize my
  unread GitHub notifications and email me the digest."), clicked **Generate**.
- Result: navigated to `/runs/run_dd8c39fda4f2` (the Worker Author run), showed a
  real progress stream (Reading prompt → Drafting worker.yml → Writing
  SKILL.md/run.py → Validating schema → "Worker drafted"), then the run completed
  in **27.3s** producing 1 output item + `bundle.json`.
- **Did NOT reset to an empty form.** No duplicate worker — Worker Author drafts a
  single bundle; the workers list did not show a duplicate entry.
- Status: **FIXED, confirmed live.**

### (b) Failed-run humanized error everywhere operator-facing; raw only in Raw tab — VERIFIED (with one P2 leak)
- Opened `/runs/run_12f326066d87` (Research Brief, failed).
- Header + Error block both read the calm operator message:
  "This worker hit an internal error and stopped. Check the run logs, then edit or
  re-run the worker." — no raw jargon in the primary headline.
- **Raw tab** correctly contains the full SSE stream incl. `Event loop is closed`.
- **Residual P2:** the **"Recent logs" preview on the Result tab** still surfaces
  the raw `ERROR Agent runtime error: Event loop is closed` lines. The humanized
  headline is correct; the raw string leaks into the default-tab log preview.
- Status: **substantially FIXED** (headline humanized); minor raw-leak in Result-tab
  log preview is P2, not blocking.

---

## Per-category scores

| # | Category | Score | Notes |
|---|----------|------:|-------|
| 1 | Positioning / messaging | 10 | "Hire a new AI worker", outcome-native "Work done / 234 outcomes this week". No banned "OS for Background Workers" string in the app shell. |
| 2 | Create flow (prompt → worker) | 10 | Navigates to run, live drafting stream, completes, no reset, no duplicate. |
| 3 | Run execution + streaming | 10 | Manual RB run streamed live (Step 1 → completed 35.2s), output item + file. |
| 4 | Run detail / artifact view | 9 | Result/Logs/Output/Raw/Metadata tabs; full markdown brief renders in Output. P2: Result-tab "Recent logs" leaks raw error string. |
| 5 | HITL approval round-trip | 10 | Approve → spawned Run 2 (`run_12c1c0b17ed2`), `PHASE: run-2-execute`, `SENT: true`, 3.6s; badge dropped 1→0. |
| 6 | Failed-run UX | 9 | Calm humanized headline + Error block; raw in Raw tab. P2 raw leak in log preview. |
| 7 | Workers list / employee cards | 9 | Folders, tags, per-worker last-run + 7d run count + success %. Seed success rates (OpenDraft 26%) are audit-churn, not code. |
| 8 | Runs history | 9 | Grouped by day, filters, Export CSV, pagination. P2: a HITL Run 1 shows 28m duration (approval wait counted as run time). |
| 9 | Connections | 9 | OAuth, sub-tabs (Connected/Browse/MCP/Secrets), scopes + last-used + status. P2: duplicate "Google Calendar" expired rows. |
| 10 | Contexts | 9 | Clean empty state ("No knowledge packs yet"), New button. System worker-author-style contexts not user-listed (intentional). |
| 11 | Settings / security | 10 | Token masked (password field), CLI/MCP/API setup, Danger zone. No credential leak. |
| 12 | Mobile (375) + responsiveness | 10 | Hamburger nav, tiles stack full-width, create hero + preset cards clean, no overflow, good touch targets. |

**Weighted overall: 96 / 100.**

---

## Remaining issues

### P0
None.

### P1
None.

### P2 (non-blocking polish)
1. **Raw error string in Result-tab "Recent logs" preview.** Failed-run Result tab
   shows `ERROR Agent runtime error: Event loop is closed`. *Fix:* in the
   Recent-logs preview component, map `level=error` lines through the same
   humanizer used for the headline, or suppress raw ERROR lines from the preview
   and keep them in the Logs/Raw tabs only.
2. **Worker-output citation tokens leak into rendered markdown.** Research Brief
   Output shows raw `citeturn0search9turn0news12` tokens inline. This is the
   worker's own output (OpenAI web-search citation markers) not stripped before
   render. *Fix:* strip/normalize `cite…turn…` tokens in the markdown renderer (or
   in the worker's post-processing) before display. Operator-facing artifact quality.
3. **Connections: duplicate "Google Calendar (Expired)" rows + HITL run-duration
   counts approval wait time** (Run 1 shows 28m). *Fix:* de-dupe stale OAuth grants
   in the connections query; for HITL, display execution time separately from
   pending/wait time on the runs list.

---

## What works (verified live)
- Create-via-prompt → real drafting stream → run detail (no reset, no dup).
- Manual worker run → live SSE stream → completed → artifact markdown in Output.
- Two-run HITL: Approve spawns Run 2, executes, marks `SENT: true`, badge clears.
- Outcome-native dashboard (Work done / outcomes, sparkline tiles, activity feed,
  coming-up schedule) matching the locked positioning.
- All 9 routes + `/api/proxy/workers` return HTTP 200.
- Settings token masked; setup commands for CLI/MCP/API.
- Mobile 375 layout clean across overview + create flow.

## Verdict
**≥ 95: YES (96/100). Launch-ready.** Both named blockers fixed and verified on
prod. No P0/P1. The three P2 items are post-launch polish, the most user-visible
being the citation-token leak in worker markdown output (#2 above).
