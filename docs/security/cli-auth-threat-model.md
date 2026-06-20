# CLI device-code auth — threat model & accepted risk

Status: accepted-risk with hardening (2026-06-03)
Scope: `POST /cli-auth/devices`, `GET /cli-auth/poll/{device_code}`,
`POST /cli-auth/approve`, `POST /cli-auth/deny` (`apps/api/main.py`), the
approval page (`apps/web/app/cli-auth/page.tsx`), and the CLI login command
(`apps/mcp/src/commands/login.ts`).

## What the flow is

Workeros OS is **single-tenant**: the owner (holder of `FLOOM_SECRET`) is the
only principal. The CLI uses the standard OAuth 2.0 **device authorization
grant** (RFC 8628) shape:

1. The CLI calls `POST /cli-auth/devices` (no auth). The server mints a
   high-entropy `device_code` (256-bit, URL-safe base64) and a short,
   human-readable `user_code` (e.g. `ABCD-2345`), stores a `pending` record,
   and returns both plus a `verification_url`.
2. The CLI shows the `verification_url` **and the `user_code`**, and polls
   `GET /cli-auth/poll/{device_code}`.
3. The owner opens the page, which is gated by their authenticated session
   (`FLOOM_SECRET`). The page shows the `user_code` and requires the owner to
   **re-type it** before the Approve button enables.
4. `POST /cli-auth/approve` (owner-authenticated) flips the record to
   `approved` and stores `FLOOM_SECRET` as the device's secret.
5. The next poll returns `approved` + the `api_secret`, then the record is
   consumed (single-use).

## Threat: device-flow phishing

The classic device-flow phishing attack: an attacker who does **not** hold
`FLOOM_SECRET` starts their own device flow, obtains a `user_code`, and tricks
the owner into approving it from the owner's authenticated session. If the owner
approves, the attacker's polling CLI receives `FLOOM_SECRET` — full escalation.

## Mitigations (in place)

| Mitigation | Where | Detail |
|---|---|---|
| **Short TTL** | `_CLI_AUTH_EXPIRES_SECONDS = 600` (10 min) | Enforced on poll (expired → 404 + delete) and via `prune_expired` on create/approve/deny. A stale/leaked code dies fast. |
| **Owner-only approval** | `approve`/`deny` depend on `get_auth_context` | Only the `FLOOM_SECRET` holder can approve. Approval also checks `record["user_id"] == auth.user_id`. |
| **Visible-code confirmation** | approval page | The page shows the code AND requires the owner to **manually re-type it** to enable Approve. Defends the "pre-filled link → blind approve" variant: a planted `?code=` link cannot be approved by reflex. |
| **Code-match instruction** | CLI + approval page | The CLI prints the `user_code` prominently and instructs the owner to approve **only if the code on the page matches the terminal**. The page repeats: "approve only if this matches your terminal; otherwise deny." This gives the owner the second source needed to spot an attacker's link (different code). |
| **Rate-limit on device creation** | `RATE_LIMIT_RULES` | `POST /cli-auth/devices` capped at 5/60s per IP — bounds bulk code minting. |
| **Rate-limit on poll** | default rule | `GET /cli-auth/poll/{device_code}` falls under the default 60/60s per IP+path bucket; the `device_code` is unguessable (256-bit), so polling is naturally scoped to the code holder. |
| **Single-use + bounded device set** | `consume`, `_CLI_AUTH_MAX_DEVICES` | Approved codes are consumed on first successful poll. Pending device set is capped (oldest evicted), bounding storage abuse. |
| **Unguessable secrets** | `_new_device_code` | `device_code` = 256 bits of `os.urandom`; `user_code` is for human comparison only, never the poll key. |

## Residual risk (accepted)

This is the **industry-standard device-flow tradeoff**. The remaining residual
risk is identical to GitHub CLI / `gcloud` / Azure device login: a sufficiently
convincing social-engineering attack can still get a user to approve a code that
is not theirs. The mitigation that makes this safe in practice is the
**code-match step** — the owner is told, in both the terminal and the page, to
approve only when the codes match. Because the owner is the sole principal and
must be actively present (re-typing the code) to approve, blind/automated
approval is not possible.

We deliberately do **not** add: a full redesign, PKCE-style binding (the
single-tenant owner-only model makes it redundant), or per-poll global
rate-limit tightening (the 256-bit `device_code` already scopes polling). Adding
those would be over-engineering for a single-tenant self-hosted install.

## Disposition

Accepted risk + the cheap hardening already shipped (prominent CLI code display
+ explicit code-match instructions on both surfaces, on top of the pre-existing
short TTL, re-type confirmation, owner-only approval, and rate limits).
