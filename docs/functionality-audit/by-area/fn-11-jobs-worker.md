# fn-11 — Async jobs queue and worker

**Scope:** `apps/server/src/routes/jobs.ts`, `apps/server/src/services/jobs.ts`, `apps/server/src/services/worker.ts` (with mount context from `apps/server/src/index.ts` and auth from `apps/server/src/lib/auth.ts`).

**Product lens (`docs/PRODUCT.md`):** The async job queue is a **load-bearing path** (long-running ops, polling + `JobProgress`-class UX). It supports the same HTTP surface as the rest of the platform; it must stay understandable for the ICP (no “bring your own queue” assumptions).

---

## Enqueue idempotency

**Verdict: not idempotent.** Each `POST /api/:slug/jobs` allocates a fresh `job_id` via `newJobId()` and inserts a new row. There is no `Idempotency-Key` (or similar), no dedupe on payload hash, and no “return existing job” behavior.

**Implications:** Network retries or double-clicks from clients create duplicate queued work. Integrations (Zapier, scripts) must implement their own deduplication if they need exactly-once enqueue semantics.

**Positive:** Malformed JSON is rejected before enqueue (`parseJsonBody` / `bodyParseError`), matching the rationale used for synchronous run — empty or truncated bodies do not enqueue garbage jobs.

---

## Poll contract

**Endpoint:** `GET /api/:slug/jobs/:job_id` returns `formatJob(row)` JSON.

**Shape (stable fields exposed):** `id`, `slug`, `app_id`, `action`, `status`, `input`, `output`, `error`, `run_id`, `webhook_url`, `timeout_ms`, `max_retries`, `attempts`, `created_at`, `started_at`, `finished_at`. Internal `per_call_secrets_json` is not exposed.

**HTTP semantics:** `404` if the app slug does not exist, or if the job id does not exist **for that slug** (`getJobBySlug` ties id to slug). Wrong slug + valid id elsewhere yields “not found” (no cross-slug leakage).

**Terminal `status` values clients should treat as done:** `succeeded`, `failed`, `cancelled` (plus any invariant that `finished_at` is set for those — enforced by updates, not by a DB check constraint in the reviewed code).

**Not specified in code:** cache-control / ETag; clients should assume mutable snapshots until terminal. Polling interval is entirely client-driven.

**Enqueue response (`202`):** Body includes `job_id`, `status: 'queued'`, and absolute URLs: `poll_url`, `cancel_url`, and `webhook_url_template` (currently the same base path as `poll_url` in `buildJobUrls` — naming suggests webhook delivery is POST to a **creator-configured** `webhook_url` on the job row, not to Floom’s poll URL).

---

## Cancel

**Endpoint:** `POST /api/:slug/jobs/:job_id/cancel`.

**Service behavior (`cancelJob`):** `UPDATE ... SET status='cancelled', finished_at=now` only when current status is `queued` or `running`. If already terminal, `changes === 0` and the handler still returns `formatJob` of the current row (`updated || job`) — **HTTP 200 with body**, not an error.

**Queued jobs:** Effective immediately for visibility; the worker only selects `status='queued'`, so a cancelled queued job is never claimed.

**Running jobs — gap:** After `claimJob`, the worker does not re-read job status during `waitForRunOrTimeout` or before `completeJob` / `failJob`. `completeJob` / `failJob` use `WHERE id = ?` **without** guarding on `status`. If a client cancels while the worker has already moved the job to `running`, the underlying `runs` row can still finish successfully and **`completeJob` can overwrite `cancelled` with `succeeded`** (same for failure paths). So “cancel” is best-effort for in-flight work, not a hard stop of the runtime.

**Webhooks on cancel:** The cancel route does not call `deliverCompletion`. User-initiated cancel while **queued** therefore produces no completion webhook. Cancel while **running** shares the race above; even when the row stays `cancelled`, there is no dedicated path in the cancel handler to notify the creator URL.

---

## Retries

**Configuration:** `max_retries` from per-request body override, else `apps.retries`, else `0`. `timeout_ms` similarly layered with `DEFAULT_JOB_TIMEOUT_MS` (30 minutes) as default.

**Attempt accounting:** `claimJob` increments `attempts` when moving `queued` → `running`.

**On failure (`handleFailure`):** If `job.attempts <= job.max_retries`, `requeueJob` runs: status back to `queued`, timing and error cleared, **`attempts` preserved** (so the next claim increments again). If over budget, `failJob` then `deliverCompletion`.

**Semantics note:** With `max_retries = N`, the first failure after the `(N+1)`-th claim exhausts retries (because `attempts` grows each claim). This matches “initial try plus N retries” for typical small N.

**Webhook timing:** While retries remain, the code **requeues without** calling `deliverCompletion` — webhooks fire only on final success or final failure (or timeout path that fails the job).

---

## Worker failure modes

| Mode | Behavior |
|------|----------|
| **Multi-replica / concurrent workers** | Safe for dequeue: `nextQueuedJob` + `claimJob` uses `UPDATE ... WHERE id=? AND status='queued'`; second claimant gets `changes=0`. |
| **`processOne` throws** (e.g. unexpected exception before terminal update) | Caught in the worker loop (`console.error`); the next tick runs after `FLOOM_JOB_POLL_MS`. If the job was already moved to `running`, it may **stay `running` forever** with no automatic requeue. |
| **Corrupt `input_json` on row** | `JSON.parse(claimed.input_json)` is outside the manifest `try/catch`; a throw surfaces to the same outer catch → **stuck `running`** risk. |
| **Process / host crash while `running`** | On restart, `nextQueuedJob` only sees `queued`; rows left `running` are **never drained** unless something else resets them. |
| **Job timeout** | `waitForRunOrTimeout` returns null; run row forced to `timeout`; `handleFailure` applies retry or final fail; completion webhook attempted. |
| **Missing app after claim** | `failJob` + `deliverCompletion` (webhook may still run if URL set). |
| **Webhook delivery errors** | Logged; job state is already final — **no retry of webhook** at the HTTP layer. |

**Environment:** `FLOOM_JOB_POLL_MS` (default 1000) between ticks; inner run poll every 500ms until terminal or deadline.

---

## Auth on job endpoints

**Global:** `/api/*` is behind `globalAuthMiddleware` when `FLOOM_AUTH_TOKEN` is set — jobs routes included. Bearer or `?access_token=` for GET (same pattern as rest of API).

**Per-app:** Every handler loads the app row and calls `checkAppVisibility` with `resolveUserContext(c)`:

- **`public`:** pass-through (only global token if configured).
- **`private`:** only matching `ctx.user_id === author` passes; others get **404** (`not_found`) to avoid leaking existence.
- **`auth-required`:** requires configured `FLOOM_AUTH_TOKEN` and valid bearer; misconfig returns **401** with explanatory JSON.

**Rate limiting:** `runRateLimitMiddleware` runs for **every** request on `/api/:slug/jobs` (including `GET` poll and `POST` cancel), sharing the same per-user / per-IP / per-(IP, app) hourly buckets as `POST` enqueue. Heavy polling can consume the same budget as enqueues.

**CORS:** `openCors` on `/api/:slug/jobs` — browser callers from arbitrary origins may hit these endpoints subject to token and visibility rules.

**Authorization gap (not authentication):** Any caller who passes visibility checks can **poll or cancel any job id** for that slug; there is no per-job ownership or secret URL token. Job ids are unguessable only if `newJobId()` is cryptographically strong — if ids leak (logs, referrer), other authorized users of the same app could observe or cancel them.

---

## Alignment notes

- **PRODUCT.md** explicitly calls the async queue load-bearing alongside `JobProgress.tsx`; regressions here hit the “long-running ops” pillar.
- Worker reuses **`dispatchRun`** / `runs` lifecycle — consistent with the “one execution engine” model for hosted/proxied apps.
- **Triggers / MCP / inbound webhook** also call `createJob` (`services/triggers-worker.ts`, `routes/mcp.ts`, `routes/webhook.ts`); this audit’s idempotency and cancel conclusions apply to those enqueue paths as well when they share the same storage.

---

## Summary

| Area | Assessment |
|------|------------|
| Enqueue idempotency | None; duplicate POSTs enqueue duplicate jobs. |
| Poll contract | Clear JSON snapshot; slug-scoped 404; no cache semantics. |
| Cancel | Reliable for queued; **race with running**; no completion webhook from cancel handler. |
| Retries | Attempt-based, requeue without webhook until terminal. |
| Worker robustness | Good concurrent claim; **stuck `running`** on crash/throw/orphan; webhook best-effort. |
| Auth | Global token + visibility gates consistent with `/api/:slug/run`; no per-job ACL beyond slug visibility. |
