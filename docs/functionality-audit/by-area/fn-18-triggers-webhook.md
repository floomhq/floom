# fn-18 — Triggers and webhooks (backend)

**Scope:** `apps/server/src/routes/triggers.ts`, `routes/webhook.ts`, `services/triggers.ts`, `services/triggers-worker.ts`, `services/webhook.ts`.  
**Lens:** `docs/PRODUCT.md` — ICP-facing automation that should stay boringly reliable; ties into the load-bearing **async job queue** (`routes/jobs.ts`, `services/jobs.ts`, `services/worker.ts`) without being listed as a separate load-bearing row.

---

## PRODUCT alignment

Unified triggers (schedule + incoming webhook) enqueue runs on the same job pipeline the product already depends on for long-running work. That matches the “paste repo, Floom runs it” story: automation should not require the ICP to run their own cron or ingress. Deleting or bypassing this stack would weaken automation, not hosting itself; prefer fix over removal if anything looks half-wired.

---

## Authorization — create and list

**Create (`POST /api/hub/:slug/triggers`):**

- `requireAuthenticatedInCloud` rejects anonymous callers in cloud mode (`lib/auth.ts`).
- App is loaded by `slug`; **404** if missing.
- **Ownership:** `ownerOf` allows the run if `app.author === ctx.user_id`, or the OSS-local synthetic case (`!ctx.is_authenticated`, `workspace_id === 'local'`, app `workspace_id === 'local'`). There is no separate check that `ctx.workspace_id` matches the app’s workspace for normal cloud users; ownership is **author-only**, consistent with other hub-style routes if `author` is the sole source of truth for “this app is mine.”
- **Action allowlist:** the `action` must exist on the parsed app manifest before insert.
- **Schedule:** `cron_expression` / `tz` validated before insert.

**List (`GET /api/me/triggers`):**

- Same cloud auth gate.
- `listTriggersForUser(ctx.user_id)` selects all triggers for that user with **no `workspace_id` filter**. If one account can hold triggers across multiple workspaces, the list is a union, not scoped to “current workspace.” Whether that is correct depends on product rules for workspace isolation; the code does not enforce workspace boundaries on read.

**Patch / delete (`/api/me/triggers/:id`):**

- Gate + `existing.user_id === ctx.user_id`. Trigger rows store `user_id` at creation time; this is consistent with list.

**Incoming webhook (`POST /hook/:path`):**

- Intentionally **not** under `/api/*` so `FLOOM_AUTH_TOKEN` global middleware does not apply; **HMAC on the body is the auth boundary** (documented in `routes/webhook.ts`).

---

## Schedule drift and timing accuracy

- **Poll granularity:** `triggers-worker` defaults to **30s** (`FLOOM_TRIGGERS_POLL_MS`), so `next_run_at` fires are accurate only within roughly one poll interval after the scheduled instant (plus DB latency). Fine for many use cases; sub-minute crons will not fire “on the second.”
- **Clock / downtime catch-up:** If `now - next_run_at > 1 hour`, the worker **logs, skips the missed execution**, and advances `next_run_at` to the next valid cron instant after `now` (`CATCH_UP_WINDOW_MS`). No burst of catch-up jobs.
- **Drift &lt; 1h:** One fire path advances `next_run_at` using `nextCronFireMs(cron, now, tz)` after a successful claim.
- **Comments vs implementation:** `services/triggers.ts` describes callers claiming rows with **`BEGIN IMMEDIATE`**; `tickOnce` does **not** wrap reads/updates in an explicit transaction. Concurrency is instead handled by **`UPDATE ... WHERE id = ? AND next_run_at = ?`** so only one writer advances a given due row. That is a valid pattern but **docs in `triggers.ts` are stale** relative to `triggers-worker.ts`.
- **`advanceSchedule` in `services/triggers.ts`:** exported but **unused** in the repo; the worker inlines equivalent logic. Dead surface area for readers.

---

## Webhook signature verification (incoming)

- **Header:** `X-Floom-Signature`, value `sha256=<hex>` (or bare hex, normalized).
- **Algorithm:** `createHmac('sha256', secret).update(body, 'utf8')` (`services/triggers.ts`).
- **Body:** `c.req.text()` so the signed bytes match what external senders sign — correct for JSON webhooks.
- **Comparison:** `timingSafeEqual` on UTF-8 `Buffer`s of the full header strings; length mismatch short-circuits without timing-safe compare — acceptable for length differences.
- **Secret lifecycle:** plaintext secret returned **only on create**; list/serialize masks as `webhook_secret_set` — good for confidentiality; losing the secret still requires rotate/recreate UX-wise.

---

## Replay and idempotency

- **Dedupe key:** `X-Request-Id`, `X-GitHub-Delivery`, etc., stored in `trigger_webhook_deliveries` with **24h TTL** and lazy `DELETE` on each insert path (`recordWebhookDelivery`).
- **Without a request id:** explicitly **no dedupe**; anyone with the secret can cause duplicate jobs by resubmitting the same payload (comment in `routes/webhook.ts` acknowledges sender risk).
- **Replay response:** duplicate within TTL returns **200** with `{ deduped: true }` (first successful path returns **204** with job headers — asymmetry callers should know about).
- **Ordering bug (high severity):** `recordWebhookDelivery` runs **before** `createJob`. If `createJob` **throws**, the handler returns **500**, but the delivery id is **already inserted**. A client retry with the same `X-Request-Id` is treated as a **replay** and returns **200 deduped without enqueueing** — the run can be **lost permanently** unless the client fabricates a new id. Fix would be: insert dedupe row in the same transaction as job creation, or record only after successful enqueue, or delete the dedupe row on enqueue failure.
- **Route header comment:** mentions Stripe-style timestamp headers for dedupe; **implementation does not** use `Stripe-Signature` for idempotency (only listed headers are read).

---

## Worker and enqueue failures

**Schedule worker (`triggers-worker.ts`):**

- Per-trigger errors in `tickOnce` are caught and logged; the loop continues.
- **Lost run after claim (high severity):** After a successful **`UPDATE` that advances `next_run_at` and sets `last_fired_at`**, if **`createJob` throws**, the function returns `false` but the row **stays advanced**. That scheduled occurrence **never enqueues**. Recovery requires manual intervention or waiting for the next cron tick (the *next* wall-clock occurrence, not a retry of the missed one).
- Inactive/missing app or invalid manifest action: worker **advances `next_run_at`** without firing — avoids hot loops; operators lose that tick unless they notice logs.

**Incoming webhook route (`routes/webhook.ts`):**

- `createJob` failure → **500**; `markWebhookFired` is only called after successful enqueue — good for `last_fired_at` semantics, but combined with the dedupe ordering issue above, **retries can still lose work** when a request id was present.

**Outgoing completion webhooks (`services/webhook.ts`):**

- This module is **outbound** Floom → creator `webhook_url`: JSON **POST without Floom-side signing** of the payload. Secrecy relies on URL opacity; recipients cannot cryptographically verify Floom as sender unless they add their own layer. Retries: exponential backoff on 5xx/network; **4xx is terminal** — appropriate for “fix your endpoint.”
- **Persistence of `triggered_by`:** schedule/webhook jobs attach context via `triggers-worker` / `attachWebhookTriggerContext` into memory + `job_trigger_context` table; if DB insert for context fails, code logs a **warning** and continues — completion webhooks may omit trigger metadata for that job after restart.

---

## Summary table

| Area | Assessment |
|------|------------|
| Authz create | Strong: cloud session + app author + manifest action. |
| Authz list | User-scoped; workspace filter absent if multi-workspace per user matters. |
| Schedule drift | ~poll interval skew; &gt;1h downtime skips missed fires by design; docs overstate `BEGIN IMMEDIATE`. |
| Signature verify | Solid HMAC + timing-safe compare on raw body. |
| Replay / dedupe | Helps when request id present; **dedupe-before-enqueue** loses runs on transient failure. |
| Worker failures | Logs continue; **claim-then-enqueue** can drop a schedule firing entirely. |

---

## Suggested follow-ups (code, not policy)

1. Move idempotency record to **after** successful `createJob`, or tie INSERT + job in one transaction.  
2. On `createJob` failure in `processTrigger`, **roll back** `next_run_at`/`last_fired_at` to pre-claim values or re-queue with backoff.  
3. Align comments (`BEGIN IMMEDIATE`, Stripe header) with code or implement what the comments promise.  
4. Optionally filter `listTriggersForUser` by active `workspace_id` if the product model requires workspace-scoped listings.
