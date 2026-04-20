# pd-10 — Async jobs as differentiator (deep product audit)

**Lens:** [`docs/PRODUCT.md`](../../PRODUCT.md), [`docs/ROADMAP.md`](../../ROADMAP.md), server job routes/services/worker, web `JobProgress` + `RunSurface` wiring.  
**Date:** 2026-04-20.  
**Track:** Long-running / queued execution vs synchronous `/api/:slug/run`.

---

## 1. Executive truth table

| Promise or claim (source) | Observed reality | Verdict |
|---------------------------|------------------|---------|
| "Long-running ops are a real user need and a real differentiator." — load-bearing async queue row in `PRODUCT.md` | Backend: `jobs` table, `POST/GET /api/:slug/jobs`, cancel, worker loop, default timeout **30 minutes** (`DEFAULT_JOB_TIMEOUT_MS` in `services/jobs.ts`), retries, completion webhooks (`services/worker.ts`). | **Met** (platform capability) |
| Same PRODUCT row ties UI path: `apps/web/src/components/runner/JobProgress.tsx` | Component exists; `RunSurface` branches on `app.is_async`, calls `api.startJob` + `api.pollJob` (1.5s), renders `JobProgress` in `phase === 'job'` (`RunSurface.tsx`). Creator run at `/me/apps/:slug/run` and public `/p/:slug` both use `RunSurface`. | **Met** (core run surfaces) |
| ROADMAP "Shipped backend, UI pending": "Async job queue \| Backend shipped, **UI in flight**" | Web already ships `JobProgress`, polling, cancel, URL `?job=` on completion. | **Contradicted** (roadmap stale vs repo; treat ROADMAP row as **needs refresh**) |
| ROADMAP P0: "Async job queue UI (**re-enable**)" | No evidence in this pass that job UI is feature-flagged off; async path is active when `is_async` is true. | **Partial** — "re-enable" may mean a *different* slice (e.g. triggers hub, analytics, marketing copy) not audited here |
| "You can leave this page; the job keeps running." — `JobProgress.tsx` | True server-side: enqueue returns 202; worker claims and runs independently of the browser tab. | **Met** |
| Long-running **perception** in UI | Copy after 5s: "Some apps take **20–40 seconds**." Backend allows up to **30 minutes** (and per-app overrides). | **Partial** — UX sets short-horizon expectations; very long jobs may feel "stuck" with indeterminate bar only |
| Three-surface parity for async | HTTP: documented in `routes/jobs.ts` and `api/client.ts`. MCP: `mcp.ts` references job poll URLs for async flows (ingest/agent path). Web form: `RunSurface` + `JobProgress`. | **Partial** — parity depends on each surface actually calling `/jobs` for async apps; HTTP/MCP are capable; web is wired |
| Share / restore prior state (`ROADMAP` P1: `?run=<id>`) | `RunSurface` sets **`?job=<id>`** after async completion. `AppPermalinkPage` hydrates only **`?run=<id>`** via `getRun`, not `?job`. Comment: in-flight runs not deep-linkable; async completion links are job-centric. | **Missing / Partial** — async deep-link story is split between job id and run id; permalink page does not read `job` param |

---

## 2. ICP journey (with failure branches)

**Persona (PRODUCT):** non-developer AI engineer; prototype on localhost; wants production without infra. **Where async matters:** actions that exceed comfortable HTTP request windows or need queue semantics (retries, webhook on completion).

### Happy path (web, async app)

1. User opens `/p/:slug` or `/me/apps/:slug/run` with an app where `is_async` is true.
2. Fills form, presses Run → `POST /api/:slug/jobs` → immediate `202` with `job_id`, poll/cancel URLs.
3. UI enters `phase: 'job'`, shows `JobProgress` (queued → running), polls `GET /api/:slug/jobs/:id` every ~1.5s.
4. On terminal status, UI maps job → synthetic `RunRecord` (`jobToRunRecord`), shows `OutputPanel` / custom renderer; URL gains `?job=`.

### Failure branches

| Branch | What happens |
|--------|----------------|
| App not `is_async` but client mistakenly calls `/jobs` | `400` — "Use POST /api/:slug/run instead." Clear correction for API users; web path avoids this by gating on `app.is_async`. |
| Malformed JSON body on enqueue | Rejected before queue touch (comment in `jobs.ts` P2 #146); same posture as sync run. |
| Worker down / stalled | Jobs stay `queued` or `running`; UI keeps polling; user sees spinner + copy about leaving the page. **No** server-push or ETA; risk of silent stall if polls fail repeatedly (`onError` in `pollJob` is optional and `RunSurface` passes a no-op that keeps polling). |
| Poll network errors | `pollJob` calls `onError` then continues on next tick; UI may not surface transient errors distinctly. |
| Timeout (e.g. 30m) | Worker marks run timeout + job failed path; webhook on terminal failure path. User eventually sees error outcome in output flow if poll succeeds. |
| User closes tab | Job continues; webhook fires if configured. **Re-open:** no audited first-class "resume polling this job id" from landing unless user still has URL with `?job=` (and even then permalink hydration gap above). |
| Cancel | `POST .../cancel`; `RunSurface` stops poll and sets error phase with "Job cancelled." |
| Private app / auth | Same visibility checks as other routes (`checkAppVisibility`, session). |
| Creator overview | `MeAppPage` shows static line: "async app · **~60s** per run" — may mis-set expectations vs 30m cap or vs very fast jobs. |

---

## 3. Risk register

| ID | Severity | Risk | Evidence |
|----|----------|------|----------|
| R1 | **P0** | **Roadmap vs code drift** undermines prioritization: team may duplicate work or defer marketing/docs that already shipped. | `docs/ROADMAP.md` "UI in flight" / P0 "re-enable" vs `JobProgress.tsx` + `RunSurface.tsx` async branch |
| R2 | **P1** | **`?job=` vs `?run=` deep link inconsistency** — users or support cannot rely on one URL shape to restore async results on `/p/:slug`. | `RunSurface.tsx` (~370–377) sets `job` search param; `AppPermalinkPage.tsx` (~52, 134–168) only loads `run` via `getRun` |
| R3 | **P1** | **Expectations mismatch** between UI microcopy (20–40s), overview (~60s), and backend (up to 30m). Trust erosion if a "normal" long job looks broken. | `JobProgress.tsx` (~83); `MeAppPage.tsx` (~284); `services/jobs.ts` (`DEFAULT_JOB_TIMEOUT_MS`) |
| R4 | **P1** | **Polling-only progress** — no %, no log stream for async path (unlike sync `StreamingTerminal`). Long jobs feel opaque; differentiator is "reliable completion" not "visibility." | `RunSurface.tsx` output slot: `streaming` vs `job` phases |
| R5 | **P2** | **Webhook delivery is best-effort** (logged warn on failure); creators depending on webhooks for billing/state may see silent drops unless they monitor. | `services/worker.ts` `deliverCompletion` (~224–234) |
| R6 | **P2** | **Single-process worker model** — documented as safe multi-replica via atomic claim; still one poll loop per process, global FIFO `nextQueuedJob`. No per-tenant fairness audited here. | `services/worker.ts`, `services/jobs.ts` `nextQueuedJob` |
| R7 | **P2** | **Permalink / hub copy** still references "job queue UI" as future in places — conflicts with shipped `JobProgress` and confuses ICP reading `/p` or hub. | `AppPermalinkPage.tsx` comments (~7, ~810, ~1804) |

---

## 4. Open PM questions

1. **Should `docs/ROADMAP.md` be updated** so async queue UI is "shipped" for the run surface, with any remaining scope (triggers UI, job list, emails) called out explicitly?
2. **Deep-link contract:** Should `/p/:slug?job=<id>` hydrate the same as a finished run, or should async apps standardize on **`?run=<run_id>`** only (and always push run id into the URL)? Who owns the canonical shareable id for async: job row or underlying run row?
3. **Where is "long-running" promised in ICP-facing copy** (landing, protocol, studio), beyond implementation? If nowhere, is the differentiator **only** for power users / MCP / API — and is that enough?
4. **MCP and HTTP clients:** Is there a checklist that every ingested async app exposes the right tool/docs string so agents default to `/jobs` instead of timing out on `/run`?
5. **Creator-editable hints:** Should manifest carry optional `expected_duration_hint` to drive `JobProgress` / overview copy instead of hardcoded "~60s" and "20–40 seconds"?
6. **Failure UX:** Should repeated `pollJob` errors escalate to a visible "connection trouble" state with backoff, rather than an infinite spinner?
7. **Cancellation semantics:** After cancel, is the transition to `phase: 'error'` with a generic card the intended product behavior, or should cancelled jobs show a dedicated neutral outcome?

---

## 5. Implementation summary (audit notes)

**`routes/jobs.ts`:** Enqueue (`POST /`) validates manifest action + inputs, supports `webhook_url`, `timeout_ms`, `max_retries`, `_auth` per-call secrets; returns `202` + `job_id` + poll/cancel URLs. `GET /:job_id` returns `formatJob` snapshot. `POST /:job_id/cancel` cancels queued/running.

**`services/jobs.ts`:** CRUD + atomic `claimJob`, `nextQueuedJob`, `completeJob` / `failJob` / `requeueJob` / `cancelJob`; `formatJob` exposes stable JSON (hides `per_call_secrets_json`).

**`services/worker.ts`:** Poll interval `FLOOM_JOB_POLL_MS` (default 1000ms); claims oldest queued; inserts `runs` row, `dispatchRun`, waits for terminal run or timeout; success/fail updates job; optional webhook with trigger context (`triggered_by`, `trigger_id`).

**`JobProgress.tsx`:** Pre-terminal card — header status, spinner, indeterminate progress bar, job id prefix, elapsed mm:ss (ticks every 1s), optional Cancel, attempt count when `attempts > 1`, messaging for queued vs running and leave-page reassurance.

---

## 6. Cross-references

- Deep audit index: [`INDEX.md`](./INDEX.md) (pd-10 row).  
- For execution catastrophe modes (worker crash mid-job, etc.), see **pd-14** when available.  
- For three-surface parity detail, see **pd-05**.
