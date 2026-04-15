# Floom connections — Composio OAuth integration

_v0.3.2+ — "Connect a tool" ramp on `/build`._

Floom ships with a per-user OAuth broker via [Composio](https://composio.dev). Users click a tile on `/build` (Gmail, Notion, Stripe, Slack, Sheets, Airtable, Shopify, HubSpot, Calendar, Linear, Figma, GitHub, ...), authenticate once, and every app on Floom can then reuse that connection via `composio.executeAction(ctx, provider, tool, args)`.

This doc is the full operator + developer reference. For the shorter operator setup, see `docs/SELF_HOST.md` section "Connect a tool".

## Why Composio

Picked in P.2 research (`research/composio-validation.md`). Three facts matter:

1. **Largest AI-native toolkit catalog** — 982 toolkits, 11,000+ tools. Nango has 700; Pipedream Connect has 3,000 but they're workflow-biased. Native OAuth is 0 by definition.
2. **Per-user keying for free** — `composio.connectedAccounts.initiate(userId, authConfigId, {callbackUrl})` is a 1-line call. Floom never touches an OAuth spec.
3. **Usage-priced, not per-user** — Composio charges per tool call, not per connected account. A 50-user × 10-app × 5-call month is 2,500 billable units, not 500 billable users. Pipedream's per-unique-external-user billing is a pricing landmine for marketplaces; Composio avoids it.

Composio-the-server is closed source. The SDK (`@composio/core` 0.6.10) is ISC-licensed. Self-host operators who want a fully OSS stack should see `docs/SELF_HOST.md` for the "no Composio" path: leave the env vars unset and every `/api/connections/*` call returns `400 code=composio_config_missing`. Nothing else in Floom depends on Composio being present.

## Architecture

```
browser                                             Composio
  │                                                    ▲
  │  POST /api/connections/initiate {provider}         │
  ▼                                                    │
┌─────────────┐                                        │
│ Floom core  │ ── composio.connectedAccounts.initiate ┘
│             │    (userId, authConfigId, {callbackUrl})
│             │                                   ┌─────────────┐
│             │ ◄──── {id, redirectUrl} ──────────┤ Composio    │
│             │                                   │ cloud       │
│  DB row     │                                   └─────────────┘
│  (pending)  │
└─────────────┘
      │ 
      ▼  returns {auth_url, connection_id, expires_at}
browser opens auth_url in popup
user grants consent at Composio → upstream provider (Google/Notion/...)
browser POSTs /api/connections/finish {connection_id}
      │
      ▼
┌─────────────┐
│ Floom core  │ ── composio.connectedAccounts.get(id) ─► Composio cloud
│             │                                   ┌─────────────┐
│             │ ◄─── {status: ACTIVE, data} ──────┤ Composio    │
│  DB row     │                                   └─────────────┘
│  (active,   │
│   metadata) │
└─────────────┘
      │
      ▼
/api/connections now lists {provider: 'gmail', status: 'active'}
```

The `connections` table is the single source of truth for Floom's view of the world. Composio stores its own copy too; on `finishConnection` we resynchronize.

## Schema

```sql
CREATE TABLE connections (
  id                      TEXT PRIMARY KEY,              -- floom-side uuid
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
  owner_kind              TEXT NOT NULL CHECK (owner_kind IN ('device','user')),
  owner_id                TEXT NOT NULL,                 -- device_id OR user_id
  provider                TEXT NOT NULL,                 -- 'gmail', 'notion', ...
  composio_connection_id  TEXT NOT NULL,                 -- Composio's connection id
  composio_account_id     TEXT NOT NULL,                 -- the string we passed as userId
  status                  TEXT NOT NULL CHECK (status IN ('pending','active','revoked','expired')),
  metadata_json           TEXT,                          -- {account_email, scopes, ...}
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (workspace_id, owner_kind, owner_id, provider)
);

-- Added to users in the same migration (v0.3.2, user_version=5):
ALTER TABLE users ADD COLUMN composio_user_id TEXT;
```

### Device-id fallback (pre-W3.1)

v0.3.2 ships before W3.1 Better Auth. Every visitor has an anonymous `floom_device` cookie. The `connections.owner_kind` column distinguishes the two states:

| owner_kind | owner_id | composio_account_id (passed as Composio `userId`) |
|---|---|---|
| `device` | `<floom_device UUID>` | `device:<uuid>` |
| `user`   | `<users.id>`           | `user:<id>` |

Composio treats the whole string as opaque. The prefix is load-bearing only on Floom's side: it tells the rekey transaction which rows to rewrite.

### Rekey transaction (post-login)

When W3.1 Better Auth lands, the login handler calls:

```ts
session.rekeyDevice(device_id, user_id, workspace_id)
```

In a single atomic SQLite transaction this:

1. Rewrites `app_memory` rows from `device_id` → `user_id`.
2. Rewrites `runs` rows from `device_id` → `user_id`.
3. Rewrites `run_threads` rows from `device_id` → `user_id`.
4. **Rewrites `connections` rows from `device:<x>` → `user:<y>`**, skipping any row where the user already owns a `user`-scoped row for the same provider (the "double Gmail" scenario — one connection wins, the old device row stays behind for manual cleanup).
5. Persists the legacy `device:<uuid>` Composio user id on `users.composio_user_id` (COALESCE, never overwrites). This lets future executeAction calls keep filtering Composio's own view of the world by the original key Composio knows about.

The transaction is idempotent: running it twice returns zero for every count the second time.

## Service API

`apps/server/src/services/composio.ts` exposes five methods:

### `initiateConnection(ctx, provider, callbackUrl?) → {auth_url, connection_id, provider, expires_at}`

Creates a `connections` row in `pending` state and asks Composio for a redirect URL. The caller (browser) opens `auth_url` in a popup; the provider handles the OAuth consent; Composio redirects to `callbackUrl` (or the default) with a success marker.

Throws:
- `ComposioConfigError` — missing `COMPOSIO_API_KEY`, missing `COMPOSIO_AUTH_CONFIG_<PROVIDER>`, or invalid provider.
- `ComposioClientError` — upstream Composio call failed (5xx, network error, 404, ...).

### `finishConnection(ctx, composio_connection_id) → ConnectionRecord`

Looks up the local row scoped to the caller (otherwise → `ConnectionNotFoundError`), polls Composio for the current status, and persists it. Status strings are normalized:

| Composio | Floom |
|---|---|
| `ACTIVE` | `active` |
| `INITIATED` | `pending` |
| `EXPIRED` | `expired` |
| `FAILED`, `REVOKED`, `DELETED` | `revoked` |
| anything else | `pending` |

### `listConnections(ctx, {status?}) → ConnectionRecord[]`

Scoped to `(workspace_id, owner_kind, owner_id)`. Optionally filter by status. Never returns cross-tenant rows.

### `revokeConnection(ctx, provider) → ConnectionRecord | null`

Calls `composio.connectedAccounts.delete(id)` then flips the local row to `revoked`. Idempotent:
- If the row is already revoked, return it unchanged.
- If the upstream returns 404 (already gone), swallow the error and still flip the local row.
- If the row doesn't exist, return `null` so the route can return 404.

### `executeAction(ctx, provider, action, params) → ComposioExecuteResponse`

Looks up the caller's `active` connection for the provider (→ `ConnectionNotFoundError` if none), then calls `composio.tools.execute(action, {userId: row.composio_account_id, arguments: params})`. The `userId` we pass is whatever string we used at `initiate` time (`device:<uuid>` or `user:<id>`). This is how token continuity survives the pre/post-login boundary.

Used by app handlers that integrate with upstream providers. Example (pseudo-code):

```ts
// inside a hypothetical Gmail-backed app
import * as composio from '../services/composio.js';

app.post('/run', async (c) => {
  const ctx = resolveUserContext(c);
  const result = await composio.executeAction(ctx, 'gmail', 'GMAIL_SEND_EMAIL', {
    to: 'foo@bar.com',
    subject: 'hi',
    body: 'first message via floom',
  });
  return c.json(result);
});
```

## HTTP endpoints

All four are under `/api/connections` and behind the same `globalAuthMiddleware` the rest of `/api/*` uses (open in OSS solo mode, bearer-gated when `FLOOM_AUTH_TOKEN` is set).

### `POST /api/connections/initiate`

```json
{
  "provider": "gmail",
  "callback_url": "https://your-floom.dev/api/connections/callback"
}
```

Response:

```json
{
  "auth_url": "https://composio.dev/oauth/conn_int_1000",
  "connection_id": "conn_int_1000",
  "provider": "gmail",
  "expires_at": "2026-04-15T01:45:00.000Z"
}
```

Errors:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_body` | Zod validation failed (provider required, lowercase-slug) |
| 400 | `composio_config_missing` | `COMPOSIO_API_KEY` or `COMPOSIO_AUTH_CONFIG_<provider>` unset |
| 502 | `composio_initiate_failed` | Upstream Composio error |

### `POST /api/connections/finish`

```json
{"connection_id": "conn_int_1000"}
```

Response:

```json
{
  "connection": {
    "id": "con_abc123",
    "provider": "gmail",
    "owner_kind": "device",
    "status": "active",
    "composio_connection_id": "conn_int_1000",
    "metadata": {"account_email": "user@example.com"},
    "created_at": "2026-04-15T01:25:00Z",
    "updated_at": "2026-04-15T01:26:30Z"
  }
}
```

Errors:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_body` | Missing `connection_id` |
| 400 | `composio_config_missing` | Env var missing |
| 404 | `connection_not_found` | No local row owned by this caller matches the Composio id |
| 502 | `composio_finish_failed` | Upstream Composio error |

### `GET /api/connections?status=active`

Response:

```json
{
  "connections": [
    {"id": "...", "provider": "gmail", "status": "active", ...},
    {"id": "...", "provider": "notion", "status": "active", ...}
  ]
}
```

Errors: 400 on invalid `status`. Valid values: `pending`, `active`, `revoked`, `expired`.

### `DELETE /api/connections/:provider`

Response on success:

```json
{"ok": true, "connection": {"id": "...", "provider": "gmail", "status": "revoked", ...}}
```

Errors:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_provider` | Provider path segment is not lowercase slug |
| 404 | `connection_not_found` | Caller has no row for this provider |
| 502 | `composio_revoke_failed` | Upstream Composio error that wasn't a 404 |

## Cross-tenant isolation

Every query is scoped to `(workspace_id, owner_kind, owner_id)`. Two separate workspaces with the same `device_id` cannot see each other's rows. Two users in the same workspace cannot see each other's rows.

The tests (`test/stress/test-w23-composio-service.mjs`) verify this explicitly: they seed two workspaces, insert a row in one, list from the other, and assert zero results.

## Web UI flow (W4.1 owns the implementation)

When W4.1 lands the creator dashboard, the `/build` Connect-a-tool tile grid will:

1. Call `POST /api/connections/initiate {provider}` with the local origin as `callback_url`.
2. Open `auth_url` in a new tab or popup.
3. Poll `GET /api/connections` every 2 seconds for up to 5 minutes.
4. Show success state as soon as a row with that provider flips to `active`.
5. Show a "reconnect" link on already-revoked/expired tiles.

Until W4.1 ships, operators can exercise the full flow with `curl` (see `test/stress/test-w23-integration.mjs` for a working node:http simulation).

## Testing

Five test files under `test/stress/`:

| File | Tests | Coverage |
|---|---|---|
| `test-w23-schema.mjs` | 24 | Table/column creation, CHECK + UNIQUE + FK constraints, user_version bump, idempotent re-import |
| `test-w23-composio-service.mjs` | 47 | Full service API with in-memory fake client. Cross-owner + cross-workspace isolation |
| `test-w23-rekey.mjs` | 16 | `rekeyDevice` connections branch. Double-Gmail scenario. Idempotency. W2.1 regression |
| `test-w23-routes.mjs` | 34 | Hono router via `Request.fetch`. Error envelope codes. Session cookie. Zod validation |
| `test-w23-integration.mjs` | 14 | Real `node:http` server simulating Composio REST. Full ramp + 503 circuit + token expiry |

Total: 135 new tests, all green, zero regressions on the 301-test W2.1+W2.2 floor.

Run individually:

```bash
node test/stress/test-w23-schema.mjs
node test/stress/test-w23-composio-service.mjs
node test/stress/test-w23-rekey.mjs
node test/stress/test-w23-routes.mjs
node test/stress/test-w23-integration.mjs
```

Or as part of the full suite:

```bash
pnpm --filter @floom/server test
```

## Known gaps (tracked for v0.4+)

1. **Polling vs webhooks**: the `/finish` endpoint is currently poll-only. A Composio webhook handler that catches `connection.active` events and preemptively updates the row would cut "popup-closed → status flips" latency from ~2s to near-instant.
2. **Token refresh visibility**: Composio refreshes tokens automatically and flips to `EXPIRED` only when refresh fails. We surface the `expired` state but we don't currently emit a user-visible "reconnect Gmail" banner. W4.1 creator-dashboard work.
3. **Rate limits**: the free tier is 20K calls/mo. Floom today does not meter per-user Composio calls. First paid plan will likely hit before a per-user quota becomes necessary.
4. **Self-host alternative**: Nango is documented as the Phase 5 fallback for operators who want a fully OSS stack. The `services/composio.ts` wrapper is thin enough that swapping to Nango is a ~2-day replace-the-adapter job — see `research/composio-validation.md` for the structured comparison.
