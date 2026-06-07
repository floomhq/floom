# Final Gate G5 — Independent Confirmation Walk (2026-05-29)

**Scorer:** Independent second reviewer (fresh skeptical founder/operator frame).
**Target:** Live deployed product at https://workers.floom.dev
**Live build at audit:** main `891009e` (commits since — `ef1522d`, `a724601` — are audit-docs + P2 polish only; none touch the flow this audit blocks on, verified on HEAD).
**Mandate:** Independently confirm launch readiness; the gate requires two independent scorers to agree ≥95. A prior independent walk scored **96/100, no P0/P1**. This walk did NOT trust that number and re-derived its own.
**Positioning under test:** "Hire AI workers for your company — describe the job, connect tools, Floom runs it on schedule/webhook/approval." Workers = employees; audience = founders/operators/recruiters; benchmark = ChatGPT simplicity.

---

## VERDICT

**Overall: 78/100 — NOT launch-ready against its own headline promise.**
**≥95: NO. The two scorers do NOT agree.**

I cannot confirm the 96/100. I found **one P0** that the prior walk reported as having "no P0/P1": the single most-advertised flow — *describe a job in plain English → get a worker you can run* — **does not produce a runnable worker and offers no way to save the generated bundle as one.** For the named persona (founder/operator/recruiter, explicitly non-developer), the front-door journey dead-ends at a downloadable `bundle.json`.

Everything else I tested is genuinely strong (8.5–9.5/10): run execution, full HITL approval round-trip, humanized failure handling, connections (1,043-app catalog + live OAuth), responsive mobile. If the P0 is fixed, this product is a legitimate 95+. As deployed today, it is not, because the wedge flow is broken.

---

## FLAWS FIRST (anti-inflation discipline)

### P0 — Prompt-to-worker produces no usable worker (make-or-break flow #1)

**What I did (live):** On `/workers/new` I typed *"Every weekday at 8am, summarize the top 5 Hacker News stories and email me the digest."* and clicked **Generate**. Worker count before: **13**.

**What happened:**
1. A live "Worker Author" run streamed progress (good UX) for ~33s, then navigated to `/runs/run_30c63400ff6b`.
2. That run page shows a single output artifact: **`out/bundle.json` (2.8 KB)**. Actions available: Edit / Re-run / Download / Download all. The "Edit" link points to `/workers/worker-author` (the *meta-worker that authored the bundle*), NOT the drafted HN worker.
3. **No worker was created.** Worker count after: still **13**. No "HN digest" worker exists in the list, API, or anywhere.
4. **There is no "Save as worker" / "Create this worker" affordance** on the run page or anywhere downstream.

**The promise it breaks:** The `/workers/new` page copy states verbatim: *"Floom drafts the worker, picks the right integrations, and **opens the editor so you can review before running.**"* It does not open an editor. It opens a run that emits a JSON file.

**Root cause (verified at 3 layers — not inferred):**
- *Live behavior:* `POST /workers/new/from-prompt` with both `mode:"draft"` AND `mode:"create"` return `worker_id: "worker-author"` (the meta-worker) and complete with output `{"bundle": "out/bundle.json"}`. I called `mode:"create"` directly against the API; the run completed and the worker list **stayed at 13** with no new worker.
- *Frontend:* `apps/web/app/workers/new/page.tsx:118` hardcodes `mode:"draft"` and on completion does `router.push('/runs/${runId}')` with the comment "so user can see the bundle and save it" — but no save step exists. The run route (`apps/web/app/runs/[id]/page.tsx`) wires only Back/Replay/Cancel/Download; `RunDetailSplitPane.tsx` treats the bundle purely as a download URL.
- *Backend:* `workers/worker-author/run.py:303` **always** sets `"created_worker_id": None` and only writes `out/bundle.json`, in BOTH modes. `mode` only changes the LLM prompt phrasing ("Include the full bundle so it can be registered immediately") — nothing ever registers it.

**Why this is P0, not P2:** The only paths that DO create a listed, runnable worker are the file/zip/folder uploads (`draft-and-create` → `createFromBundle`), which require the user to hand-author or possess a `worker.yml`/`SKILL.md`/`run.py` bundle. That is a developer workflow. The advertised wedge for founders/operators/recruiters — type a sentence, get a worker — has no completion. A skeptical investor running this in 10 minutes types one sentence, gets a JSON download, and concludes the demo is a teaser. (This also echoes ISSUES.md #1 "Generated worker is empty after create" — same class of gap, previously logged.)

**Precise fix (smallest correct change):** Add a server-side finalize so `mode:"create"` actually persists the bundle as a worker, then have the prompt flow navigate to `/workers/<new_id>?edit=1` (the existing editor route the `draft-and-create` fallback already uses at `page.tsx:166`). Concretely, either:
- (a) Have `worker-author/run.py` POST the validated bundle to `/workers/draft-and-create` (files mode) when `mode == "create"`, populate `created_worker_id`, and surface it in the run output; then the frontend reads `created_worker_id` from the completed run and `router.push('/workers/${created_worker_id}?edit=1')`; OR
- (b) Switch the frontend primary path back to `api.workers.draftAndCreate({prompt})` (which already returns a real `worker_id` and opens the editor) and keep the streaming worker-author run only as the progress UI.
Option (b) is the smaller change and restores the promised "opens the editor" behavior immediately.

### P2 — Generated/completed run output not surfaced in the default Result tab
On a completed Research Brief run the **Result** tab shows only "Step 1 ✓" with no content; the actual 5.9 KB markdown brief renders only under the **Output** tab. The headline deliverable should be visible in the default view, not one click away. (Confirmed: Output tab renders the brief beautifully; this is a default-tab/IA nit, not data loss.)

### P2 — React hydration error (#418) in console on `/workers/new`
One console error captured: `Uncaught Error: Minified React error #418` (server/client text mismatch, almost certainly relative-time / locale timestamp rendering). React recovers client-side; no functional break and no 4xx/5xx on any route. Should be eliminated before launch (suppressHydrationWarning on the timestamp, or render relative times client-only).

### P2 — Seed-content copy nit (not product chrome)
The Outbound-approval demo draft reads "looking for **a** Engineer" (should be "an Engineer"). Seed-worker-generated text, per the brief's seed-data caveat — reported, not docked against functional score.

### Non-issue checks (verified, no dock)
- **Contexts empty state** ("No knowledge packs yet") is CORRECT — the contexts API genuinely returns 0; not a load failure. Created + deleted a probe pack to confirm file-nav UI works, then cleaned up (back to 0).
- **Intermittent "Event loop is closed"** on some Research Brief runs is real backend churn but intermittent (my own Research Brief run completed cleanly producing a 5.9 KB brief). Per the seed-data caveat, treated as infra/seed noise, not a functional dock.
- **Low seed-worker success rates** (e.g. OpenDraft) — audit-churn from file-input workers fired without uploads, per brief. Not docked.

---

## Make-or-break flow results (independently exercised live)

| # | Flow | Result | Evidence |
|---|------|--------|----------|
| 1 | `/workers/new` generate → must navigate (not reset), one worker | **FAIL (P0)** | Navigated (not reset) ✓ but **0 workers created** (count 13→13), lands on bundle-download run page, no editor, no save CTA |
| 2 | Run a worker → completes | **PASS** | Research Brief run_635a57397758 completed 34.4s, produced real 5.9 KB markdown brief |
| 3 | Full HITL approve round-trip | **PASS (strong)** | Ran Outbound-approval-demo → pending approval (Approvals badge=1) → Approve → run-2 spawned (run_19d1a64ba89f, PHASE run-2-execute, SENT true) completed 4.6s |
| 4 | Failed run → operator-facing text humanized (raw in Raw tab only) | **PASS** | run_bd593adb5874: Result shows "This worker hit an internal error and stopped. Check the run logs, then edit or re-run." Raw detail ("Event loop is closed") isolated to ERROR log lines |
| 5 | Contexts file nav | **PASS** | Empty state correct (API=0); created probe pack → master-detail file UI (Files/Workers/Size, Add file, Used-by) works; cleaned up |
| 6 | Connections | **PASS (strong)** | Live OAuth table (GitHub/Gmail/GCal/Drive/LinkedIn/Notion w/ Active/Expired + Reconnect); Browse = 1,043-app Composio catalog w/ categories + pagination; MCP + Secrets tabs present |

Console/network: all frontend routes 200; no 4xx/5xx observed; one React #418 console error (P2).

---

## Per-category scores (12 categories, sub-scored)

| # | Category | Score | Notes |
|---|----------|------:|-------|
| 1 | Core value flow (describe → runnable worker) | **3/10** | The wedge. Generate produces a bundle, not a worker; no save path. Single biggest gap. |
| 2 | Worker execution (run → complete) | 9/10 | Inline run form, typed inputs, sample-fill, live steps, real output, cancel. |
| 3 | HITL approvals | 9.5/10 | Full round-trip, message preview, Approve/Edit/Reject, run-2 auto-spawn + SENT. Best surface in the app. |
| 4 | Error / failure handling | 9/10 | Humanized operator text in Result; raw confined to logs/Raw. |
| 5 | Runs / observability | 8.5/10 | Grouped-by-day history, status filters, Export CSV, per-run tabs. Result-tab IA nit (P2). |
| 6 | Connections / integrations | 9.5/10 | Live OAuth + 1,043-app catalog + MCP + Secrets. Strong for the persona. |
| 7 | Contexts / knowledge packs | 8.5/10 | Correct empty state, clean master-detail file UI. |
| 8 | Dashboard / overview | 9/10 | Outcome-framed ("Work done — 240 outcomes"), outcome tiles, activity feed, coming-up. On-positioning. |
| 9 | Workers list (employee cards) | 9/10 | Avatar/name/Example/desc/tags/last-run; folders + tags + filters. On-positioning. |
| 10 | Mobile / responsive (375px) | 9/10 | Home tiles stack, /workers/new clean, connections table → cards, runs list clean. No overflow. |
| 11 | Visual design / ChatGPT-simplicity | 8.5/10 | Restrained, real SVG logos, no AI-slop. Reads close to ChatGPT-clean. |
| 12 | Stability (console / network / errors) | 8/10 | All routes 200, no 5xx; one React #418 hydration error (P2). |

**Weighting note:** Category 1 is the product's entire reason to exist per the locked positioning. A 3/10 there caps the composite hard. Weighted overall = **78/100**. State: **functional and polished, but the headline promise is unmet → not launch-ready until the P0 lands.**

---

## Bottom line

This is a well-built, genuinely impressive product across 11 of 12 surfaces — the HITL and connections work is launch-grade. But the one flow the landing page leads with, and the one the named persona needs most, does not deliver a worker. The prior 96/100 over-scored by treating the generate flow as working; my independent walk shows it produces a download, not an employee. **I do not confirm ≥95. Verdict: NOT launch-ready (P0 open). Fix the prompt-to-worker finalize (option b is a ~1-file change), re-walk flow #1, and this clears 95 easily.**
