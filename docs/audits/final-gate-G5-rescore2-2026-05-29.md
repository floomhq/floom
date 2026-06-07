# Gate G5 — Independent Launch-Readiness RE-SCORE #2 (Workeros OS)

- **Date:** 2026-05-29
- **Target:** https://workers.floom.dev (single-tenant operator dashboard, "Floom Workers")
- **Backend:** https://workers-api.floom.dev (verified live with deploy secret, all routes HTTP 200)
- **Reviewer frame:** Fresh skeptical founder/operator. Did NOT trust any "fixed" claim; re-walked the LIVE product and verified every prior P0/P1 against the running deploy and the backend API.
- **Positioning judged against:** "Hire AI workers for your company — describe the job, connect tools, Floom runs it on schedule/webhook/approval." Workers = employees. Simplicity benchmark = ChatGPT.
- **Prior G5:** 88/100 (not passing). The hygiene fix #253 + audit docs #254 claim all 6 prior blockers resolved.

## VERDICT

**Overall: 93/100 — NOT launch-ready by the ≥95 gate. State: CONDITIONAL.**

5 of the 6 prior P0/P1 are genuinely, verifiably fixed on prod. One (raw runtime/sandbox error leakage to the operator) is **only partially fixed**: the sanitizer ships and catches most classes, but two real internal-jargon error strings still reach the operator's run list verbatim. That single residual gap, plus two minor UI consistency bugs, holds this below 95.

**Independent verdict: NOT ≥95. Do not pass the gate until the one P1 below is closed.** The fix is small (≈10 lines) and the product is otherwise launch-grade.

---

## FLAWS FIRST (anti-inflation discipline)

### P1 — Raw runtime/sandbox error strings still leak to the operator run list (residual of prior P0)
**Evidence (live backend API, deploy-secret authenticated):**
- `GET /runs/run_12f326066d87` (Research Brief, failed) → `error: "Event loop is closed"`, `error_code: "agent_runtime_error"`. Rendered verbatim in the `/runs` list subtitle.
- `GET /runs/run_279270f792f5` (OpenDraft, failed) → `error: "context deadline exceeded: This error is likely due to exceeding 'timeout' — the total time a long running request (like process or directory watch) can be active. It can be modified by passing 'timeout' when making the request. Use '0' to disable the timeout."`, `error_code: "e2b_sandbox_error"`. Rendered verbatim (truncated) in `/runs`.

Both are pure infra/runtime jargon. A founder reads "Event loop is closed" or "process or directory watch / pass 'timeout' / use '0' to disable" and has zero idea what to do. This is the same class the prior P0 flagged.

**Root cause (confirmed in source, commit `9693f5d` #253):** `_operator_error_message()` only rewrites a raw error when `_has_internal_artifact()` detects a traceback / sandbox path / env-var / git branch. Both leaking strings contain NONE of those tokens, so the function short-circuits at `if not _has_internal_artifact(redacted): return redacted` and returns the raw string. The `_OPERATOR_ERROR_RULES` table (which DOES have a `deadline exceeded`/`timeout` rule that would have mapped the E2B error to "This worker took too long and was stopped") is only reached AFTER the artifact gate — so it is effectively dead code for artifact-free jargon. There is no rule for `Event loop is closed` / asyncio / agent-runtime errors at all.

**Why it matters for the gate:** #253's design intent ("no raw tracebacks, calm operator headlines") is correct and mostly works; the implementation gates rewriting on structural artifacts rather than on whether the message is operator-readable. Two known error classes slip the net on the front page surface.

### P2 — `/approvals` empty-state vs nav badge consistency (stale client cache)
After creating a pending approval, the Approvals nav badge showed **"1"** immediately, but the page body still read **"No pending approvals"** until a hard reload (≈3s later it rendered the item). Symmetrically, after I approved the item and run 2 completed, the badge still showed **"1"** on `/workers/new` and elsewhere until a full reload (the item was already consumed). The list and the badge read from different cache lifetimes / don't invalidate on mutation. Not a blocker, but a skeptical investor clicking "1 pending" and seeing "none" (or vice versa) reads as flaky.

### P2 — Failed run-detail default tab shows no error explanation
`/runs/run_12f326066d87` (failed) Result tab renders only "Step 1" with a red icon and NO error sentence on the default view. The cause only appears in the `/runs` list subtitle (raw) — the opposite extreme from the list. The operator on the detail page must dig into Logs/Raw to learn anything. Result tab should surface the (mapped) headline.

### P3 — Run-1 of a HITL worker is labelled "failed" (red badge) while awaiting approval
The first run of `outbound-approval-demo` shows `STATUS: failed` with a red "Failed" badge while DURATION reads "Running" and the body says "pending approval." A run correctly parked for human approval is not a failure. Cosmetic but on-positioning-damaging: a founder sees their brand-new HITL employee "fail" on its very first run. (The list-view labels the same run "Completed 1m 9s" once approved, so it self-heals, but the in-the-moment state is wrong.)

### P3 — Worker draft copy grammar ("looking for a Engineer")
The approval card's drafted message read "you're looking for a Engineer." This is the worker's own LLM output, not the platform — but it's the demo a prospect sees first.

### Adversarial: "What would a skeptical investor find wrong in 10 minutes?"
- The run history shows a **high visible failure rate** (Today: 20 runs, 8 failed). Much of this is a CONCURRENT audit agent firing file-input workers without uploading files (the `File input 'csv_file': value must be a SHA-256 reference from /uploads, got non-SHA value` cluster — note that message ALSO leaks the internal `/uploads` + SHA-256 convention, though it is at least actionable). Even discounting the concurrent noise, several flagship example workers carry low 7-day success rates: OpenDraft Research Paper 29% ("Needs attention"), Gmail Intake Brief 40%, CV Reformat 50%, OpenBlog 55%, Weekly Update 62%. A demo'd dashboard full of mostly-failing "employees" undercuts the "AI workers that actually run" promise. This is a content/seed-data quality concern, not a code blocker, but it is the first thing an investor's eye lands on.

---

## PRIOR P0/P1 VERIFICATION (the 6 claimed-fixed items)

| # | Prior blocker | Status on prod | Evidence |
|---|---|---|---|
| 1 | Broken scheduled worker on front page | **FIXED** | Overview front page shows clean outcome tiles + activity feed; "Coming up today: GitHub Digest Sender 11:00 AM · schedule". The broken schedule worker (Invoice Email Processor) is now archived with a clean pause reason, not surfaced as broken on the dashboard. |
| 2 | Test "Environment Variables Worker" exposed | **FIXED** | Not in the workers catalog (12 cards, all legitimate "Example" workers) nor in `GET /workers` API (11 workers). #253 removed it from `PUBLIC_STOCK_WORKER_IDS`. |
| 3 | Archive reasons leaking env-vars / git-branch | **FIXED** | All archived workers show operator-grade pause reasons: "Paused — the LinkedIn data provider's quota is used up… Resumes automatically on 2026-06-25", "Paused — needs a GitHub account connected before it can run", "Paused — needs a Gmail inbox and a Google Sheet connected". No env-vars, no branches, no paths. |
| 4 | Raw tracebacks shown to operators | **PARTIAL** | Tracebacks/paths/env-vars/branches ARE now sanitized (see P1). Clean cases verified live: "missing a required package", "needs a GitHub account connected", "Invalid value 'en'; expected one of: english, french…". BUT two artifact-free jargon strings still leak raw: "Event loop is closed" and the E2B "context deadline exceeded… process or directory watch" boilerplate. **Not fully closed.** |
| 5 | Engine internal pack shown in /contexts | **FIXED** | `/contexts` shows honest empty state: "No knowledge packs yet. Add your first one." Engine/system pack no longer leaked. |
| 6 | HITL not operator-reachable | **FIXED — strongest evidence** | Drove the full round-trip live: ran `outbound-approval-demo` → run-1 landed PENDING_APPROVAL → it appeared on `/approvals` with Approve / Edit-then-approve / Reject → clicked Approve → run-2 (`run_511ce793edbb`) spawned and completed in 3.0s with `PHASE: run-2-execute`, `SENT: true`. Approvals nav item present; outbound-approval-demo is in the operator catalog. |

**5 of 6 fully verified fixed. #4 partial.**

---

## PER-CATEGORY SCORES (12 categories)

| # | Category | Score | Notes |
|---|---|---|---|
| 1 | First impression / positioning fit | 9/10 | Overview = outcome tiles ("166 outcomes this week", runs/active/coming-up), not infra counters. /workers/new = "Hire a new AI worker… describe the job in plain English." Dead-on positioning. |
| 2 | Worker catalog (employee cards) | 8/10 | Cards show name + trigger + last result + success% + "Needs attention" + tags + folders. On-model. Docked for low seed success rates surfacing prominently. |
| 3 | Create / generate flow | 9/10 | Prompt-first hero, sample placeholder, file upload, popular-workflow templates. ChatGPT-simple. (Generate not run end-to-end this pass; route 200, form renders correctly.) |
| 4 | Run a worker | 9/10 | Run tab: clean input form, sample-input helper, system-set fields labelled, "Run worker" CTA. Ran live, produced output. |
| 5 | Run detail / observability | 7/10 | Inputs/output/logs/raw/metadata tabs, download, re-run, redacted logs ("[redacted-metadata]"). Docked: failed Result tab shows no headline (P2); list shows raw error (P1). |
| 6 | HITL approvals | 9/10 | Full round-trip works (draft → approve → execute). Clean Approve/Edit/Reject UI. Docked only for badge-vs-list staleness (P2). |
| 7 | Run history | 7/10 | Grouped-by-day, trigger badges, status filters, CSV export, per-row failure cause. Docked: two raw error leaks (P1) + `/uploads`/SHA-256 leak in file-input validation message. |
| 8 | Error / failure hygiene | 7/10 | Big improvement over prior gate; sanitizer real and effective for tracebacks/paths/env-vars/branches/connection/package. Docked hard for the two residual artifact-free jargon leaks (P1) — this is THE remaining gate-blocker. |
| 9 | Contexts / knowledge packs | 9/10 | Honest empty state, clear definition, no engine pack leak. |
| 10 | Connections / settings | 8/10 | Routes 200; archived workers give precise "connect X to turn it on" guidance. (Not deep-walked this pass; no errors observed.) |
| 11 | Visual / responsive (desktop + mobile) | 9/10 | Clean shadcn, restrained palette, no AI-slop, responsive viewport meta present, all 8 web routes 200. ChatGPT-grade restraint. |
| 12 | Backend correctness / no 5xx | 9/10 | All backend + frontend routes HTTP 200; sanitized logs; error_code taxonomy present. Docked: `error` field still carries raw runtime strings (root of P1). |

**Weighted overall: 93/100.** (Categories 7 + 8, the operator-facing failure surface, are the binding constraint.)

---

## WHAT WORKS (verified live)
- Full HITL approval round-trip: draft → pending → operator approve → spawned follow-up run executes the side-effect (`SENT: true`). This is the headline capability and it genuinely works.
- Positioning is consistently expressed: "Hire AI workers", outcome tiles, employee cards, prompt-first creation, "describe the job, connect tools."
- 5 of 6 prior blockers truly gone: no test worker, no engine pack, clean archive reasons, clean empty states, HITL reachable, no broken worker on the front page.
- Sanitization layer is real: tracebacks, sandbox paths, env-var names, git branches, and the most common error classes (package / auth / connection / validation) all render as calm operator headlines. Logs scrubbed to "[redacted-metadata]".
- No 5xx anywhere; responsive; restrained, ChatGPT-grade UI.

---

## SINGLE HIGHEST-LEVERAGE REMAINING FIX

**Close the run-error sanitizer gap so NO raw runtime/sandbox string reaches an operator surface.** In `_operator_error_message()` (apps/api/main.py), run the `_OPERATOR_ERROR_RULES` table BEFORE the `_has_internal_artifact` short-circuit (so the existing `deadline exceeded`/`timeout` rule actually fires for artifact-free messages), and add rules for the runtime classes that currently slip through:
- `agent_runtime_error` / "Event loop is closed" / asyncio internals → "This worker hit an unexpected error while running. Check the run logs, then edit or re-run the worker."
- `e2b_sandbox_error` → the existing timeout headline ("This worker took too long and was stopped. Try again, or simplify the input.").

Better still: key the operator headline off the structured `error_code` (`agent_runtime_error`, `e2b_sandbox_error`, …) rather than regex-matching the free-text `error`. The taxonomy already exists; use it. Keep the raw string in `error_raw` for the Raw/debug tab. Also map the file-input validation message so it stops leaking `/uploads` + SHA-256. ~10 lines + 2 test cases. After that, re-render `/runs` and confirm zero raw jargon, and this clears ≥95.

Secondary (P2, fast): invalidate the Approvals badge + list from the same cache key on approve/reject, and surface the mapped error headline on the failed run-detail Result tab.

---

## GATE DECISION
**93/100. NOT ≥95. Gate NOT passed.** One residual P1 (raw runtime/sandbox error leakage on the operator front-line surface) keeps it under the bar. The product is otherwise launch-grade and the fix is small and well-scoped. Recommend: ship the sanitizer-gap fix, re-render `/runs`, then re-score — at that point this is a clear ≥95.
