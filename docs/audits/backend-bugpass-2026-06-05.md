# Backend Bug-Pass Verification - 2026-06-05

Branch: `fix/backend-bugpass-20260605`

Deployment status: no deploy performed. Prod probes below are repro/health evidence from the currently deployed services. Fix verification is local on this branch.

## Scope

- Connections M57-M59
- MCP M60
- Composio 503 behavior
- `whatsapp-listener` reliability
- Approval model docs

No persona or chat-service system-prompt files were modified.

## Prod Repro Evidence

### M57 callback auth

- `GET https://workers.floom.dev/connections/callback?status=success&connection_id=wkprobe_...` returned `307` to `/login?next=...`.
- `GET https://workers.floom.dev/api/proxy/connections/callback?status=success&connection_id=wkprobe_...` returned `401` with `{"detail":"Authentication required."}`.
- Direct API callback `GET https://workers-api.floom.dev/connections/callback?...` returned `307` to `https://workers.floom.dev/connections?connected=1`.

### M59 connection list latency

Three authenticated prod `GET /connections` calls returned `200` with 17 connections:

- 0.228s
- 0.255s
- 0.141s

Connection kinds observed: `["composio"]`.

### M60 MCP

Authenticated prod MCP connection add/list/delete probe with label `wkprobe0605190936`:

- `POST /connections/mcp` returned `200`.
- `GET /connections` included the MCP row, count 18 during the probe.
- `DELETE /connections/{id}` returned `200`.

Authenticated prod MCP tool add/list/delete probe with tool `wkprobe_tool_0605190936`:

- `POST /mcp/tools` returned `200`.
- `GET /mcp/tools` included the tool.
- JSON-RPC `POST /mcp-tools/serve` with `tools/list` returned `200` and listed the tool among 62 tools.
- `DELETE /mcp/tools/{id}` returned `200`.

### Composio 503

- Authenticated prod `GET /integrations/catalog?search=wkprobe-no-hit-...&limit=1` returned `200` with an empty page.
- Authenticated prod `POST /connections` for a random unsupported app returned a Composio upstream failure as `502`, confirming the graceful-unavailable mapping gap exists on the deployed service.

### `whatsapp-listener`

Prod did not expose `whatsapp-listener` through:

- `GET /workers/whatsapp-listener`
- `GET /workers?include_system=true`
- `GET /runs?worker_id=whatsapp-listener`

Local manifest inspection confirmed the reliability cause: the worker declares platform secrets (`COMPOSIO_API_KEY`, `WORKEROS_API_SECRET`, `WORKEROS_API_BASE`) while scheduled runtime secret resolution filters platform secrets out of worker inputs.

### Approvals

Authenticated prod approval probes:

- `GET /approvals/count` returned `200` with `{"pending": 0}`.
- `GET /approvals?limit=1` returned `200` with an empty list.

## Local Fix Verification

### M57 callback auth

Fixed by making `/connections/callback` public in web middleware and making only the exact `/api/proxy/connections/callback` route public. Neighboring proxy routes remain authenticated.

The generic proxy now uses manual redirect handling for `/connections/callback` and copies the upstream `Location` header back to the browser, so the FastAPI callback redirect is not consumed server-side.

Verification:

- `cd apps/web && npm test -- --run tests/middleware.test.ts tests/proxy-route.test.ts` -> 2 files passed, 12 tests passed.
- `cd apps/web && npm run build` -> production build completed.
- `python3 -m pytest tests/test_connections_backend.py::TestConnectionCallbackAndComposio503 -q` -> 3 passed.
- `codex review --uncommitted` found the proxy redirect bug; it was fixed and covered by `apps/web/tests/proxy-route.test.ts`.

### M58 callback id aliases

Fixed by accepting `connected_account_id`, `connectedAccountId`, `connectionId`, and `id` as callback id aliases on both the web callback page and the API callback.

Verification:

- `TestConnectionCallbackAndComposio503::test_callback_accepts_connected_account_id_alias_and_persists_status` persists the connection as active after a callback with `connected_account_id`.

### M59 auth-config latency

Fixed by caching Composio auth-config id resolution per normalized app slug for 10 minutes.

Verification:

- `python3 -m py_compile apps/api/main.py apps/api/composio_client.py apps/api/run_service.py` passed.
- The cache is protected by `_auth_config_cache_lock` and stores normalized app slugs only.

### M60 MCP

MCP CRUD paths were already functional on prod. Added local JSON-RPC coverage so custom MCP tools remain visible through `/mcp-tools/serve`.

Verification:

- `python3 -m pytest tests/test_backend_pass2.py::test_mcp_tools_alias_crud_and_emily_metadata -q` passed as part of the broader suite.
- `cd apps/mcp && npm test` -> 31 passed.

### Composio 503

Fixed missing Composio server configuration mapping:

- Catalog and trigger catalog check for `COMPOSIO_API_KEY` before returning cached success.
- Connection initiation maps missing Composio config to `503`.
- Account info maps missing config and unavailable upstream info to `503`.
- Multi-category catalog requests (`category=a,b`) route missing config to the same `503` path instead of returning an empty `200`.

Verification:

- `TestConnectionCallbackAndComposio503` covers connect, account-info, catalog, and triggers returning `503` when `COMPOSIO_API_KEY` is empty.
- Direct local repro `GET /integrations/catalog?category=a,b` with empty `COMPOSIO_API_KEY` returned `503`.

### `whatsapp-listener` reliability

Fixed the repeated scheduled missing-secret loop by auto-pausing a scheduled worker after 3 consecutive scheduled `missing_secret` failures.

Persistence:

- DB worker row is set `enabled=False`.
- Stored manifest is updated with `paused=True` and `enabled=False`.
- `worker.yml` is updated with `paused: true` and `enabled: false` when present.

Verification:

- `apps/api/tests/test_scheduled_worker_defaults.py::test_repeated_scheduled_missing_secret_failures_auto_pause_worker` creates 3 scheduled runs, verifies all failed with `missing_secret`, and verifies the worker is disabled and marked paused on disk.

### Approval docs

Added `docs/APPROVALS.md` covering:

- when a run parks for approval
- owner review endpoints
- signed public review links
- destructive-action approval endpoints
- pending-count behavior
- approval wait-time accounting

## Test Matrix

- `python3 -m py_compile apps/api/main.py apps/api/composio_client.py apps/api/run_service.py`
- `python3 -m pytest tests/test_connections_backend.py tests/test_backend_pass2.py apps/api/tests/test_scheduled_worker_defaults.py apps/api/tests/test_mcp_url_ssrf.py -q` -> 67 passed, 38 warnings.
- `python3 -m pytest tests/test_connections_backend.py apps/api/tests/test_scheduled_worker_defaults.py tests/test_backend_pass2.py -q` -> 41 passed, 38 warnings. Run independently by `codex review`.
- `cd apps/web && npm test` -> 4 files passed, 27 tests passed.
- `cd apps/web && npm test -- --run tests/middleware.test.ts` -> 1 file passed, 11 tests passed. Run independently by `codex review`.
- `cd apps/web && npm run build` -> production build completed.
- `cd apps/mcp && npm test` -> 31 passed.
- `git diff --check` -> passed.
- `git diff --name-only | rg 'chat_service|persona|system.?prompt' || true` -> no modified prompt/persona/chat-service files.

Warnings observed are existing worker-manifest deprecation warnings for schema 0.3 test fixtures and Next 16 middleware convention warnings. No test failure remains.

## Codex Review

- First `codex review --uncommitted` found a P1 M57 issue: the proxy consumed the FastAPI redirect server-side. Fixed in `apps/web/app/api/proxy/[...path]/route.ts` and covered by `apps/web/tests/proxy-route.test.ts`.
- Second `codex review --base origin/main` found a P2 Composio 503 issue: multi-category catalog requests swallowed missing-key failures. Fixed in `apps/api/main.py` and covered by `tests/test_connections_backend.py`.
