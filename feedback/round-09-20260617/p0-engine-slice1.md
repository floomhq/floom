# Round-09 P0 — Engine-Correctness Slice 1

Branch: `fix/p0-engine-slice1` · Base: `origin/integration/final-20260617` (`c6c77699`)
Head SHA: **`c0f844f2`** · PR target: the base (Federico merges).

Three live P0s fixed, TDD (failing test written first for each). Root causes per
`feedback/round-09-20260617/p0-rootcause.md` rows #1, #7, #6.

---

## Fix #1 — 1-vs-9 workers split-brain (operator-blocking)

**Root cause.** Two surfaces answer "what workers do I have" differently. The web
`/workers` grid reads `repos.workers.list` (owner + workspace-member scoped); on
cloud it never surfaces seeded stock workers. Emily's `workers__list_all`
(`_tool_workers_list_all` → `repos.workers.list_for_agent`) **padded in** the
`PUBLIC ∪ PROTECTED` stock ids and pulled `visibility IN ('workspace','shared',
'public')` cross-tenant seeds — so Emily reported 9 (CSV Enricher, Worker Author,
node-smoke-test, research_brief, …) while the grid showed 1.

**Failing-test-then-fix.**
- New test `apps/api/tests/test_emily_worker_split_brain_round09.py::test_emily_count_matches_grid_seeded_stock_excluded`.
  Before fix: `Emily ['csv_enricher','my-worker','node-smoke-test','research_brief'] != grid ['my-worker']`.
  After fix: Emily == grid == `{my-worker}`, `count == 1`, seeded stock footnoted in `hidden_system_count`.
- Companion test `test_owned_example_still_shown`: a stock/example worker the
  operator **genuinely owns** (OSS seed-all) is still listed — the discriminator
  is **ownership**, not the cosmetic `is_example` label.

**Files changed.**
- `apps/api/services/chat_worker_tools.py:27-90` — `_tool_workers_list_all` now
  hides, in addition to system/`_worker_hidden_from_api`, any worker whose id is
  in the seeded stock set (`PUBLIC ∪ PROTECTED`) that the operator does **not**
  own (`owner_id != visibility_user_id`); footnoted in `hidden_system_count`,
  opted back in by `include_system`. Falls back to prior behaviour when a backend
  omits `owner_id`.
- `apps/api/db/sqlite.py:818-832` — `list_for_agent` returns `owner_id` (the
  `base_select` already selected `w.owner_id`).
- `apps/api/db/interface.py:22-31` — Protocol doc updated: rows carry `owner_id`;
  fallback contract documented.
- `apps/api/tests/test_worker_tool_guards.py:394` — the old
  `test_stock_worker_always_listed_and_runnable_for_member` asserted the exact
  behaviour that CAUSED the split-brain (stock worker owned by someone else MUST
  appear in any user's list). Rewritten to
  `test_stock_worker_not_owned_excluded_from_list_but_runnable`: a non-owned stock
  worker is **excluded from the list** (matches the grid) but **still runnable**
  via `_worker_can_view` (untouched), and `include_system` opts it back in. This
  is a deliberate, brief-mandated contract change, not a silent break.

**Verification.** API test reproduces 1-vs-9 then proves alignment to 1; full
`test_worker_tool_guards.py` (18) + the broad worker/chat/visibility sweep pass.

**Honest caveat (cloud).** This fix lands in the OSS engine (`floomhq/workeros`).
The live cloud (`workeros-api.floom.dev`) runs an **older engine pin** plus
`SupabaseWorkerRepository` (in `floomhq/managed-deployment`), which **does not
implement `list_for_agent` at all** in the inspected checkout and would not return
`owner_id`. For the fix to take effect on cloud, the cloud bump must (a) include
this engine commit and (b) have `SupabaseWorkerRepository.list_for_agent` return
`owner_id`. **That is a separate-repo follow-up, out of scope for this PR** (the
brief scopes #1 to the backend-agnostic OSS path). Until then the OSS/single-tenant
surface (`workers.floom.dev`) is fixed; the cloud surface needs the cloud-repo
change. Flagged here so it is not assumed done on cloud.

---

## Fix #7 — fabricated "N workers ran today"

**Root cause.** `OverviewDashboard.tsx` rendered `runs_today` (a count of RUNS)
labeled as `worker`/`workers` — live: "30 workers ran today" with 1 worker.

**Failing-test-then-fix.**
- `apps/web/tests/overview-worker-metric.test.ts` — new `runsTodayLabel` cases
  (`runsTodayLabel(30) === "runs"`, never matches `/worker/i`). Failed with
  `runsTodayLabel is not a function`, passes after the helper.
- Full-render proof `apps/web/tests/overview-runs-today.dom.test.tsx` — renders
  the real `OverviewDashboard` with `runs_today=30`, 1 worker. **On base** renders
  `"30 workers ran today"` (verified by temporarily restoring the base file → test
  fails on exactly that string). **With fix** renders `"30 runs ran today"`.

**Files changed.**
- `apps/web/components/overview/OverviewDashboard.tsx:50-58` — new pure
  `runsTodayLabel(runsToday)`; `:511` JSX now uses it (was the inline
  `worker/workers` ternary).

---

## Fix #6 — secrets mislabeled as connections

**Root cause.** `unify.ts:87` maps a `set` secret to `statusKey:"active"`;
`ConnectionsCollection.tsx:451` counted `total`/`active` over the **merged**
items. With 0 connections + 43 secrets, the page titled "Connections" showed
"43 total · 43 active" → reads as "43 active connections".

**Failing-test-then-fix.**
- `apps/web/tests/connections-unify.test.ts` — new `collectionCounts` cases:
  43 secrets → `connections:0`, `secrets:43`, `active:0`; mixed → connection
  health scoped to connections only. Failed with `collectionCounts is not
  exported`, passes after the helper.
- Full-render proof `apps/web/tests/connections-secret-count.dom.test.tsx` —
  renders the real `ConnectionsCollection` (0 connections + 43 secrets). **On
  base** the count tiles render `['43 total','43 active', …]` (verified by
  restoring base → test fails on `expected […] to include '0 connections'`).
  **With fix** they render `0 connections | 43 secrets | 0 active | 0 reauth |
  0 error`.

**Files changed.**
- `apps/web/lib/connections/unify.ts:62-83` — new pure `collectionCounts(items)`:
  reports `connections` and `secrets` separately and scopes
  `active/reauth/error` to real connections (connection + mcp) only.
- `apps/web/app/connections/ConnectionsCollection.tsx:20,451` — imports + uses
  `collectionCounts(items)` instead of the inline merged-count tiles.

---

## Gate results

| Gate | Result |
|------|--------|
| `test_emily_worker_split_brain_round09.py` | **2 passed** |
| `test_worker_tool_guards.py` (incl. rewritten stock test) | **18 passed** |
| Broad API worker/chat/visibility sweep (16 files) | all touched-area pass; 3 pre-existing `test_workspace_agent_capabilities.py` failures **confirmed pre-existing on the clean base** (identical 3 failed / 9 passed with my changes stashed) |
| `connections-unify.test.ts` + `overview-worker-metric.test.ts` (node) | **14 passed** |
| `connections-secret-count.dom.test.tsx` + `overview-runs-today.dom.test.tsx` (dom) | **2 passed**; each verified to **fail on the base** |
| `apps/web` full node project | 327 passed / 2 failed — the 2 (`deep-links`, `next-config-redirects`) **confirmed pre-existing on the base** (323/2 there; my change adds 4 passing tests) |
| `apps/web` dom project (`collection-pages.dom.test.tsx`) | 6 failures **confirmed pre-existing on the base** (identical 6/4 with my changes stashed); none in Connections/Overview |
| `next build` | **clean, exit 0**, "✓ Compiled successfully" |

`tsc --noEmit` shows TS errors only in **pre-existing** unrelated test files
(`login-route-g1`, `secure-cookie-cache-927-941`, `share-grants-767`); none in
any file I changed. `next build` does not typecheck test files and is clean.

## Preview / screenshot verdict (honest)

No deployed preview screenshot of the corrected UI was obtainable this session.
Authed pages on a local `next start` (port 3041) return **307 → /login** with no
backend session (the cross-deploy auth seam = root-cause #5, out of scope for this
slice). A jsdom screenshot would be unstyled and misleading. Instead the fixes are
verified through the **real component render path**:

- Captured rendered output (real `ConnectionsCollection`, jsdom):
  `0 connections | 43 secrets | 0 active | 0 reauth | 0 error` (was `43 total | 43 active`).
- Captured rendered output (real `OverviewDashboard`, jsdom):
  `30 runs ran today` (was `30 workers ran today`).
- Each dom test was proven to **fail on the unmodified base** and **pass with the
  fix**, so it is a genuine before/after of the rendered DOM, not a tautology.

This is the strongest evidence available without a live authed deploy. A live
authed screenshot of `/overview` and `/connections` should be taken once this
lands on a preview that carries a session (and, for #1's cloud surface, after the
cloud-repo `list_for_agent`/`owner_id` follow-up).

## Branch SHA

`c0f844f25cf5b876a74509f154a88b1c55db2ee6`
