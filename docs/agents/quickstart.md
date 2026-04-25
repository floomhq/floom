# Agent tokens quickstart

Phase 2A adds the backend primitive for headless Floom agents: one token, one workspace, one coarse scope, one per-token rate limit.

## Mint a token

Today, mint from an authenticated browser session by pasting this request while logged into `floom.dev`:

```bash
curl -sS -X POST https://floom.dev/api/me/agent-keys \
  -H 'content-type: application/json' \
  -d '{"label":"local-agent","scope":"read-write"}'
```

Optional fields:

```json
{
  "label": "clawdbot-prod",
  "scope": "read-write",
  "workspace_id": "workspace_id_here",
  "rate_limit_per_minute": 60
}
```

If `workspace_id` is omitted, Floom binds the token to the user's active workspace. The response includes `raw_token` once:

```json
{
  "id": "agtok_...",
  "prefix": "floom_agent_AbCd1234",
  "label": "local-agent",
  "scope": "read-write",
  "workspace_id": "local",
  "raw_token": "floom_agent_..."
}
```

Store `raw_token` immediately. Floom persists only the SHA-256 hash and the display prefix.

After phase 2A-UI lands, mint tokens from `/me/agent-keys` instead of using curl.

## Use a token

Send the token as a bearer credential:

```bash
curl -sS https://floom.dev/api/hub \
  -H "Authorization: Bearer floom_agent_<32-char-base62-token>"
```

Authenticated request context includes the token's `user_id`, `workspace_id`, `scope`, and `agent_token_id` for downstream enforcement.

## Revoke a token

```bash
curl -sS -X POST https://floom.dev/api/me/agent-keys/agtok_.../revoke
```

Revocation sets `revoked_at`. Reusing that bearer token returns `401 {"error":"invalid_agent_token"}`.

## Scopes

- `read`: discovery and read contexts.
- `read-write`: read plus run/write surfaces as those endpoints land.
- `publish-only`: publish and review operations.

Phase 2A stores and authenticates the scope. Endpoint-level enforcement lands with the phase that introduces each agent-native surface.

## Rate limits

Agent tokens carry a per-minute quota. The default is `60` requests/minute and can be set at mint time with `rate_limit_per_minute`.

This quota stacks on top of existing IP and user limits. A limited request returns `429`, `Retry-After`, and the standard `X-RateLimit-*` headers.

## Phase map

- 2A backend: token primitive, mint/list/revoke, bearer auth, per-token rate limit.
- 2A UI: `/me/agent-keys`, deferred until v18 wireframes lock.
- 2B: MCP read/run.
- 2C: REST read/run.
- 2D: write tools, including create/publish/secrets/delete under moderated publish policy.
- 2E: official CLI.
