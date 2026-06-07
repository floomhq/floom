# Final Gate G5 — Independent Launch-Readiness Re-Score

**Date:** 2026-05-29 ~09:25 UTC
**Target:** https://workers.floom.dev (Workeros OS, single-tenant)
**Scorer:** Fresh independent prod-walk agent (never-seen-the-fixes frame; did not read sibling-agent work)
**Method:** Live AX41 Browser Broker walk (desktop 1280 + mobile 375), real interactions, backend probe via frontend `/api/proxy`, `/metrics`, `/health`.
**Gate bar:** ≥95/100 to pass G5. Prior independent walks: 61, then 69.

---

## OVERALL: 88/100 — NOT launch-ready by the ≥95 bar. State: STRONG, one trust-class blocker.

The product has been transformed since the 61/69 walks. Every named nav surface loads, the worker-detail tabs rebuild landed, the contexts blank-content P0 is fixed, deep-linking works, the generate→run→stream→complete loop works live, console is clean (0 errors), and zero 4xx/5xx on normal flows. The UI is genuinely ChatGPT-clean and the positioning ("Hire a new AI worker — describe the job in plain English") is executed well on `/workers/new`.

It does **not** clear 95 because the operator-trust surface still leaks the system's own internals and ships a visibly-broken scheduled worker on the front page. A skeptical investor/operator finds these in under 10 minutes. None are crashes; all are "this product is still a dev sandbox, not a hired-employee fabric" signals. They are fixable in hours, not days.

---

## FLAWS FIRST (anti-inflation)

### P0 (blocks ≥95)
- **P0-A — Broken scheduled worker is the FIRST thing on the overview.** `Invoice Email Processor` is an active, scheduled worker (next run 10:00 AM, visible on Overview "Coming up today" AND top of "Worker activity" as Failed). Its run fails with a hard **Python `SyntaxError: f-string: unmatched '('` on line 22** — it has 0% success (1/1 failed in `/metrics`) and will fail every scheduled tick. For a product whose entire thesis is "AI workers that actually run," the headline worker is permanently broken. Evidence: `shots/01-home-desktop.png`, `shots/02-failed-run-desktop.png`, `/metrics` `invoice-email-processor failed=1 completed=0`. Either fix the worker, archive it, or pause it — but it cannot be the demo's front-page scheduled item.

### P1 (operator-trust / internal leakage)
- **P1-1 — Test/debug worker exposed to operators.** `Environment Variables Worker` ("A worker that returns the system environment variables", 52% success) sits in the operator worker list with no "Example" pill. An operator/investor reasonably asks "why does my company have a worker that dumps env vars?" It is also a faint security smell to advertise. Evidence: `shots/03-workers-desktop.png`. Should be `system_worker: true` / hidden.
- **P1-2 — Raw internal jargon leaks in the Archived reason.** `LinkedIn Post Engagements` archive note reads: *"APIFY_API_KEY free credits exhausted (locked until 2026-06-25)… Worker code is correct; KeyError guard added in lane/reliability-2026-05-29."* Operators should never see a raw env-var name, "KeyError guard", or an internal git branch name (`lane/reliability-2026-05-29`). Evidence: `shots` (Archived tab snapshot). Rewrite as operator-language ("Paused — third-party data provider quota exhausted, resumes 2026-06-25").
- **P1-3 — Raw Python tracebacks shown as the operator error.** Two live failures surface raw stack traces: the Invoice run shows the full `File "/home/user/worker/run.py", line 22 … SyntaxError`; `GitHub PR and Issue Digest` failed with "Command exited with code 1 and error: Traceback (most recent c…". A non-engineer operator cannot act on these. The internal sandbox path `/home/user/worker/run.py` and the env var name `GOOGLE_SHEETS_TOKEN` are both exposed. Evidence: `shots/02-failed-run-desktop.png`, `shots/10-runs-desktop.png`. Map to human cause + remediation; keep the raw trace behind the "Logs/Raw" tab.
- **P1-4 — Contexts surface only contains the engine's own internal pack.** `/contexts` shows exactly one knowledge pack: `worker-author-style` (USED BY: "Worker Author") — i.e. the worker-generation engine's own style guide (ANTI-PATTERNS.md, SCHEMA.md, STYLE.md, EXAMPLES/*). There is zero operator-facing content. An operator clicking "Contexts" sees the system's internal config, not "reusable knowledge packs your workers can read." Either hide the system pack from the operator view or ship at least one real operator pack. Evidence: `shots/06-contexts-desktop.png`, `shots/08-contexts-file-open.png`.

### P2 (polish / data hygiene)
- **P2-1 — Worker-count drift.** Overview tile says "14 Workers active"; `/workers` list shows 16 cards (incl. 2 GitHub workers with no stats, env-vars, invoice). Pre-existing parity work (1.5.4) reduced but did not eliminate drift between the headline and the list. Evidence: `shots/01` vs `shots/03`.
- **P2-2 — Contexts pack internal contradiction.** The pack list reads "9 files · 0 workers" while the same pack header reads "Workers 1 / USED BY: Worker Author". 0 vs 1. Evidence: `shots/06-contexts-desktop.png`.
- **P2-3 — Half the connections are Expired on the live instance.** 4 of 7 connections (Google Calendar ×2, Google Drive, Notion) show "Expired — reconnect". Two duplicate "Google Calendar — Expired" rows. On a demo/dogfood instance this undercuts "connect your tools, Floom runs it." Evidence: `shots/12-connections-desktop.png`.
- **P2-4 — `TEST_SECRET` left in the Secrets list.** Test leftover visible to operators. Evidence: `shots/13-secrets-desktop.png`.
- **P2-5 — Mobile run-detail title truncates to "Inv…".** On 375 the worker title is clipped almost entirely because Edit/Re-run/Download buttons take priority; the operator can't tell which worker failed without scrolling. Evidence: `shots/M04-failed-run-mobile.png`.
- **P2-6 — SEO basics missing.** `robots.txt`, `favicon.ico`, `sitemap.xml` all return app HTML (404), no OG/Twitter meta. Low weight for a single-tenant dogfood OS with no prospects, but objectively absent (workplan item 1.5.5 still open). Verified via `/api/proxy` + direct fetch.
- **P2-7 — High visible failure ratio.** Overview shows ~27% of today's runs failed (e.g. "126 today · 91 ok · 34 failed"), dominated by the broken/test workers above and several sub-50% "Example" workers (CV Reformat 33%, Gmail Intake 40%, OpenDraft 36%, CSV Enricher 50%, OpenBlog 56%). A buyer reads success% on the cards; these undercut the "actually run" claim even though the core workers (research_brief 96%, github-digest 79%, dach_compliance 100%) are healthy.

### Coverage limitation (not a defect)
- I could not drive a **fresh** end-to-end HITL approval through the UI: the only approval-capable worker (`outbound-approval-demo`, 5 completed in `/metrics`) is a hidden/system worker and returns a clean "Worker not found" page in the operator UI, so there is no operator-reachable trigger to create a new pending approval. The Approvals empty-state is correct (badge=0, zombie-approval fix holds) and prior gate G4 evidences the flow, but G5 could not independently re-verify a live approve/reject round-trip.

---

## WHAT GENUINELY WORKS (verified live this walk)
- **Generate → run → stream → complete loop works end-to-end.** I launched `research_brief` from the Run tab (`run_a8361812c34b`), watched it stream "Step 1 start" live, and confirmed it landed Completed (24.9s) in Run history. The core promise functions.
- **Worker-detail is now tabbed** (About / Run / Triggers / History / Apps / Source), Run-first, with "Fill with sample input", typed inputs, required markers, prominent "Run worker". Prior cards→tabs P0 fixed.
- **Contexts blank-content P0 is FIXED.** File content renders on click AND on direct deep-link nav (`/contexts/worker-author-style/files/SCHEMA.md`) — the exact P0-2 repro — with Preview/Raw, breadcrumb, code blocks. Verified.
- **Run-detail page is excellent:** status grid, Result/Logs/Output/Raw/Metadata tabs, Edit/Re-run/Download, server-side log tail.
- **Runs page:** grouped-by-day, worker/trigger/duration/status/started columns, All/Queued/Running/Completed/Failed filters, Export CSV. Audit/smoke-test pollution is gone from the default view (trigger-source allowlist works).
- **Connections:** real provider logos (no text-in-circles), Active/Expired pills, Reconnect, scopes, last-used, Connected/Browse/MCP/Secrets tabs. Secrets are write-only with a "used by" worker map and a "Missing" badge.
- **Settings:** API token (password field), CLI/MCP/API setup toggle, MCP install targets (Claude/Cursor/VS Code/Windsurf/Generic).
- **`/workers/new`** is the best positioning-fit surface: "Hire a new AI worker — describe the job in plain English," prompt box, file upload, popular-workflow starter cards. Loaded cold without the historic ERR_NETWORK_CHANGED crash.
- **Backend healthy:** `/health` → db/e2b/openai/composio all ok. `/metrics` live and rich.
- **Mobile (375):** overview tiles stack cleanly, workers list filters wrap, run form is full-width and touch-friendly, alerts bell badge "4" present. No overflow, no horizontal scroll on content.
- **Console:** 0 errors / 0 warnings on walked pages. **Network:** 0 4xx/5xx on normal flows.
- **Approvals badge / zombie fix holds** (badge=0, clean empty state).

---

## PER-CATEGORY TABLE

| # | Category | Score | Notes |
|---|----------|------:|-------|
| 1 | Functional (core flows work) | 8.5/10 | generate→run→stream→complete verified live; contexts deep-link fixed; but a front-page scheduled worker is hard-broken (P0-A). |
| 2 | Auth / Security | 9/10 | token is password-field; secrets write-only; system-env-var filter appears in place; G4 probe was 96/100 0-P0. No new exposure found here. |
| 3 | UI/UX + a11y | 9/10 | ChatGPT-clean, real logos, tabs, good empty states. Minor: mobile title truncation (P2-5), tab strip overflow on mobile. |
| 4 | Performance | 9/10 | snappy SSR, fast nav, clean network. Two transient ERR_NETWORK_CHANGED / page-close blips during the walk (broker-side, recovered on retry) — not reproduced as product faults. |
| 5 | SEO | 5/10 | robots/favicon/sitemap 404, no OG/Twitter. Low weight (single-tenant, no prospects) but objectively absent. |
| 6 | Data hygiene | 7/10 | trigger-source pollution gone (good); but worker-count drift, contexts 0-vs-1 contradiction, TEST_SECRET, expired connections. |
| 7 | Sandbox / execution | 8.5/10 | e2b ok, runs execute and stream; failures are real worker bugs, not platform faults. Raw traceback presentation hurts (P1-3). |
| 8 | Docs / onboarding | 8.5/10 | /workers/new copy + starter workflows + Settings setup commands are clear and operator-friendly. |
| 9 | Trust (operator-facing surfaces) | 6/10 | THE cap: broken headline worker, test worker exposed, internal jargon/branch-name/env-var leakage, engine-only contexts. |
| 10 | Disaster / errors | 8/10 | "Worker not found" is a clean friendly page; backup/restore not re-verified this walk; raw error mapping needed. |
| 11 | Observability | 9/10 | /metrics rich, alerts bell badge live (4 incidents), needs-attention badging on the broken worker is correct. |
| 12 | Positioning-fit | 9/10 | employee framing executed (hire/describe/outcomes); undercut only by the visible broken+test workers and engine-only contexts. |

Weighted overall: **88/100.**

---

## RANKED P0 BLOCKERS
1. **P0-A** — `Invoice Email Processor` (scheduled, front-page) fails with a Python SyntaxError every tick → fix the worker source, OR archive it, OR pause its schedule. A 0%-success scheduled worker as the demo's headline item is disqualifying for "workers that actually run."

## TOP P1s (with evidence)
- P1-1 `env-vars-worker` exposed in operator list (`shots/03`).
- P1-2 internal jargon / git branch name / raw env-var in Archived reason (Archived snapshot).
- P1-3 raw Python tracebacks + sandbox path + env-var names shown as operator error (`shots/02`, `shots/10`).
- P1-4 `/contexts` shows only the engine's own internal pack, zero operator content (`shots/06`, `shots/08`).

## SINGLE HIGHEST-LEVERAGE REMAINING FIX
**A systematic "operator-surface hygiene" pass, not a one-off fix:** introduce one rule — *nothing internal (system workers, engine packs, raw tracebacks, env-var names, git branch names, test secrets, broken scheduled workers) is ever visible on an operator surface* — and run it across overview + workers list + contexts + runs + archived reasons + secrets. This single pass closes P0-A's "broken headline worker" (pause/archive it), P1-1/P1-2/P1-3/P1-4, and P2-4 at once, and is exactly the "what systematic check should have caught these" the bar demands. It moves Trust 6→9 and the overall from 88 to ~95+.

---

## VERDICT
**Is this ≥95 / launch-ready? NO.** Score **88/100**. Two independent scorers must agree ≥95 for G5; this fresh walk lands at 88. The infrastructure and core loop are real and the UI is strong (a massive jump from 61/69), but operator-trust leakage plus a broken front-page scheduled worker keep it below the bar. None are crashes; all are closable in hours via the single operator-surface-hygiene pass above. Re-score after that pass.
