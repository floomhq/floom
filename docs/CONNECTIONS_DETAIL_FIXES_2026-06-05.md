# Connections Detail Fixes - 2026-06-05

## Scope

Implemented the three items from `docs/design/connections-detail-fixes-brief.md` on branch `fix/connections-detail-tool-picker`, separate from the MCP account lane.

## M82 P1 - Connections row actions

Root cause:

- The frontend overflow menu already called `api.connections.status`, `api.connections.test`, and `api.connections.delete`.
- The backend `test` endpoint only wrote `last_check_status`; it did not promote a successful `initiated` row to `active`, so the click could look like it did nothing.
- Disconnect had no confirmation guard.

Fix:

- `POST /connections/{id}/test` now persists row `status` for valid, expired, failed, and not-found outcomes.
- Test and status refresh now cache account label and scopes when Composio account metadata is available.
- Disconnect now asks for browser confirmation before calling DELETE.
- Frontend metadata hydration now uses the shared `/api/proxy` API client instead of the separate same-origin helper route, so workspace headers and base path handling match the rest of the app.

Verification:

- `cd apps/api && python3 -m pytest ../../tests/test_connections_backend.py -q`
- Result: `33 passed in 47.04s`
- `cd apps/web && npm run lint`
- Result: passed with 20 pre-existing warnings, no errors.
- `cd apps/web && npm run build`
- Result: passed.

## M81 - Real account label and Active status

Root cause:

- The OAuth callback trusted a transient Composio `initiated` status over a successful callback status. When Composio had not yet flipped its read endpoint to active, the local row stayed `initiated`, rendering as Connecting.
- Composio account metadata was fetched only through separate hydration paths. If those failed or returned no email, the list view fell back to `account ...<id>`.
- The metadata extractor did not use non-email handle fields such as `handle`, `username`, or `login`.

Fix:

- Normalized active Composio variants now include `active`, `valid`, `connected`, `enabled`, and `success`.
- On OAuth callback, `status=success` promotes the row to `active` when the remote status is empty or transient (`initiated`, `pending`, `unknown`, `not_found`).
- Account metadata extraction now accepts email plus handle-style fields from `connection_data`, `data`, `metadata`, and `user`.
- Internal `user_id` is not used as an account label fallback.
- Status refresh and test actions write cached account label/scopes back to the DB row, making list output stable without a separate UI-only hydration pass.

Verification:

- Added regression tests for:
  - Callback `status=success` with remote `initiated` promoting to `active`.
  - Test endpoint promoting `enabled` to `active` and caching `user@example.com`.
  - Handle fallback when email is absent.
- `cd apps/api && python3 -m pytest ../../tests/test_connections_backend.py -q`
- Result: `33 passed in 47.04s`

## M84 - Worker editor Add tool picker

Root cause:

- `AddToolControl` used a plain shadcn Select over `SUPPORTED_APPS`.
- The same app registry already carried icon slugs, but the picker rendered only text and did not use `BrandLogo`.
- The picker was not searchable.

Fix:

- Replaced the Add tool Select with a searchable dropdown menu.
- Each known app row renders the existing `BrandLogo` backed by `IconSprite` and `connection-data`.
- Search filters by display name or slug.
- Preserved `Other (enter slug)` and the custom slug input.

Verification:

- `cd apps/web && npm run lint`
- Result: passed with 20 pre-existing warnings, no errors.
- `cd apps/web && npm run build`
- Result: passed.
- Browser verification attempted with Playwright against local Next dev and production servers. The local harness rendered the route shell but left React Server Component route content hidden inside the stream payload, so no valid screenshot was captured. This is recorded as incomplete visual verification, not as passing screenshot evidence.

## Smoke Routes

Command:

```bash
bash ops/smoke-routes.sh
```

Result:

- OS API `/healthz`: 200
- OS routes: non-5xx, non-508
- Cloud API `/healthz`: 200
- Cloud routes: non-5xx, non-508
- Final output: `SMOKE PASSED - all routes are non-508 and non-5xx.`

## Files Changed

- `apps/api/main.py`
- `apps/web/app/connections/ConnectionsClient.tsx`
- `apps/web/app/workers/[id]/page.tsx`
- `apps/web/lib/api.ts`
- `apps/web/lib/types.ts`
- `tests/test_connections_backend.py`

