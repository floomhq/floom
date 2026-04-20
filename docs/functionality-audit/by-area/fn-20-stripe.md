# fn-20 — Stripe Connect (`/api/stripe`, `stripe-connect` service)

**Scope (workspace root `apps/server/src/`):** `routes/stripe.ts`, `services/stripe-connect.ts` (DB schema for Stripe tables lives in `db.ts`; global middleware in `lib/auth.ts` and mount order in `index.ts` are referenced where they affect this surface).

**Product lens (`docs/PRODUCT.md`):** Floom’s ICP is hosting and the three surfaces (web form, MCP, HTTP); Stripe Connect is a **creator monetization** layer on top of that. It must not weaken tenant isolation: one caller must not act on another’s connected account or payments. Webhooks must remain trustworthy under Stripe’s at-least-once delivery.

---

## Summary

| Area | Verdict |
|------|---------|
| Webhook signature | Strong when configured: raw body preserved; `Stripe-Signature` required; `constructEvent` with `STRIPE_WEBHOOK_SECRET`; failures map to `stripe_webhook_signature_failed` / `stripe_config_missing`. |
| Idempotency (webhooks) | Strong: insert into `stripe_webhook_events` keyed by unique `event_id`; duplicate deliveries skip `dispatchEvent`; reducers documented as needing idempotency under retries. |
| Auth on non-webhook routes | **Session/device scoping only:** every handler uses `resolveUserContext` so rows are keyed by `(workspace_id, owner)` and Stripe calls use the caller’s connected account — **no** `requireAuthenticatedInCloud` (unlike `hub`, `memory`, `workspaces`, etc.), so in cloud mode **anonymous** callers can use Stripe under `device:<device_id>` if the request is otherwise allowed. |
| Global `FLOOM_AUTH_TOKEN` vs webhook | **Conflict when set:** `globalAuthMiddleware` gates all `/api/*` except `/api/health` and `/api/metrics`; **`POST /api/stripe/webhook` is not exempt**, so Stripe’s servers cannot satisfy the Floom bearer check. Comment in `index.ts` claims the webhook is not gated by `FLOOM_AUTH_TOKEN`; implementation disagrees. See also `fn-01-bootstrap.md` §2. |
| PII and sensitive data | Email optional on onboard; API responses expose Stripe account flags and `requirements` JSON; full webhook **payload JSON** stored in SQLite; metadata on Stripe objects includes `floom_workspace_id` / `floom_user_id` (synthetic `local` in OSS for metadata). |

---

## Webhook signature (`verifyAndParseWebhook`, `POST /api/stripe/webhook`)

- **Raw body:** Route reads `c.req.text()` before JSON parsing — correct for signature verification over exact bytes.
- **Header:** Accepts `stripe-signature` or `Stripe-Signature` (case variants).
- **Secret:** Requires non-empty `STRIPE_WEBHOOK_SECRET`; otherwise `StripeConfigError` → 400 with `stripe_config_missing`.
- **Verification:** Delegates to Stripe SDK `webhooks.constructEvent(payload, header, secret)` via the thin `StripeClient` adapter. Failures become `StripeWebhookSignatureError` → 400, not 401.
- **No application-level auth:** Intentionally no Better Auth or session — Stripe is authenticated by the signing secret. This is the right model **if** the route is reachable without the global Floom bearer (see Summary row on `FLOOM_AUTH_TOKEN`).

---

## Idempotency

- **Webhook ledger:** `handleWebhookEvent` inserts a row into `stripe_webhook_events` with a **unique** `event_id` (schema in `db.ts`). On `SQLITE_CONSTRAINT_UNIQUE`, the handler treats the event as a retry: `first_seen=false`, **does not** call `dispatchEvent` again.
- **Stripe semantics:** Comments note at-least-once delivery and require reducers to stay idempotent if `dispatchEvent` were ever invoked twice — the unique index prevents double **dispatch** for the same `event_id`, but application logic inside `dispatchEvent` should still tolerate partial failures if extended later.
- **Non-webhook routes:** `createExpressAccount` is described as idempotent in comments (reuse existing Stripe account id, new Account Link). **Payment intent, refund, and subscription** creation are **not** idempotent keys — duplicate client POSTs can create duplicate Stripe objects; acceptable only if the UI is strictly single-submit or callers add client-side dedupe.

---

## Auth on non-webhook routes

- **Identity:** All of `/connect/onboard`, `/connect/status`, `/payments`, `/refunds`, `/subscriptions` call `resolveUserContext(c)` and pass `SessionContext` into the service. **`getCallerAccount` / `getCallerOwnerId`** scope by `workspace_id` and owner id (`user_id` when authenticated, else `device:<device_id>`).
- **Cross-tenant safety:** Services resolve the connected account from the caller’s row only; payment/refund/subscription calls use `stripeAccount: account.stripe_account_id` from that row — a caller cannot pass another user’s account id in the body to hijack it (body carries amounts, currency, Stripe ids for refund/subscription, but not a separate destination account selector).
- **Cloud login gate:** Unlike other write surfaces, these routes **do not** invoke `requireAuthenticatedInCloud`. Anonymous cloud users with a `floom_device` cookie can onboard and transact under device-scoped ownership — product should confirm this matches cloud expectations for financial actions.
- **Self-host global token:** When `FLOOM_AUTH_TOKEN` is set, **all** Stripe API routes (not just webhooks) require the shared Floom bearer **in addition** to session resolution — consistent with other `/api/*` routes, but operators must send the header from trusted clients.

---

## PII and data sensitivity

- **Onboarding:** Optional `email` in JSON body is passed to Stripe `accounts.create`. Country and account type are also supplied or defaulted.
- **Responses:** `serializeAccount` returns `requirements` parsed from stored JSON — may include Stripe verification fields depending on account state; treat as **sensitive dashboard data**, not public.
- **`client_secret`:** Payment intent result returns `client_secret` to the same authenticated (session-scoped) caller — required for client-side confirmation; must only be sent over TLS to trusted frontends.
- **Metadata:** `floom_workspace_id` and `floom_user_id` are attached to Stripe resources. In OSS mode `user_id` in metadata is often the synthetic default while the DB row uses `device:*` for `user_id` — metadata may be less specific than the row; still operator-visible in Stripe Dashboard.
- **Webhook storage:** Full event is `JSON.stringify(event)` in `stripe_webhook_events.payload` — can include customer, charge, and invoice objects with **financial and identifying** fields. No HTTP route in `routes/stripe.ts` exposes `listWebhookEvents`; exposure would be limited to DB access or future admin tools.
- **Errors:** `StripeClientError` surfaces Stripe’s message string to the client on 502 — could leak terse API hints; unexpected errors expose `(err as Error).message` on 500.

---

## Cross-cutting notes

- **`docs/PRODUCT.md`:** Stripe is not listed in the load-bearing path table; monetization is additive to hosting and the three surfaces. Deleting or weakening tenant isolation would undermine trust for creators.
- **Alignment with `fn-01-bootstrap.md`:** The **`FLOOM_AUTH_TOKEN` vs `/api/stripe/webhook`** issue is called out there; fixing it belongs in `lib/auth.ts` (path exemption) or by mounting the Stripe webhook outside `/api/*` like `/hook`.

---

## Suggested follow-ups (non-blocking)

1. **Exempt or relocate** `POST /api/stripe/webhook` from `FLOOM_AUTH_TOKEN` so Stripe deliveries succeed when the global lock is enabled; keep signature verification as the sole auth.
2. **Decide** whether cloud-mode Stripe writes should call `requireAuthenticatedInCloud` (and document the choice).
3. **Document** idempotency expectations for payment/refund/subscription POSTs (Stripe idempotency keys or UI patterns) if duplicate submits become a support issue.
4. **Review** retention and access policy for `stripe_webhook_events.payload` (full JSON) in backups and compliance contexts.
