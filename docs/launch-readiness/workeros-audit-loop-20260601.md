# Workeros Audit Loop - 2026-06-01

## Score

Current verified score: **78 / 100**.

This is not a launch-ready 100. The score moved up because the build/test baseline is green, Brain asset previews work for the verified live XLSX case, Brain has a versions surface, agent instructions are read-only until Edit, several API info-disclosure/stock-worker protection issues are patched in source, the OSS API versioning 404 is fixed in production, Cloud version route aliases exist, Cloudflare no longer blocks health/browser preflight, and both Python API services now auto-deploy from GitHub `main`.

## Verified fixed in this loop

- `search_console_insights` is protected as a stock worker and included in the public stock-worker set.
- `/system/info`, `/system/platform-config`, and `/integrations/triggers` now require auth in the engine source.
- Brain file download proxy preserves literal percent-encoded filenames, fixing the XLSX `404` case.
- Brain XLSX preview fetches through the authenticated API proxy and renders the real sheet rows.
- Brain PDF preview fetches through the authenticated API proxy and renders via a blob iframe.
- Brain video preview fetches through the authenticated API proxy and CSP now allows `media-src blob:`.
- Brain HTML preview no longer gets blocked by the old 256KB text preview cap for the current sample file.
- Brain has a pack-level Versions surface backed by the context versioning API.
- Agent instructions are read-only by default and only editable after clicking Edit.
- Cloud wrapper submodule points at the same Workeros engine commit after sync.
- `workers-api.floom.dev` no longer returns Cloudflare `403` for public `/healthz`.
- Browser CORS preflight to `workers-api.floom.dev/workers` passes with `Origin: https://workers.floom.dev`.
- OSS versioning APIs are live through Cloudflare with auth: `/workspace/versions`, `/workers/weekly_update/versions`, and `/contexts/rocketlist-seo-reports/versions`.
- Workeros Cloud versioning routes exist at both root and `/api`; unauthenticated probes return `401` instead of `404`.
- `workeros-api` and `workeros-cloud-api` have systemd auto-deploy timers that poll GitHub `main` and completed successfully under systemd.

## Evidence

- Workeros commit: `5ddda00 fix brain previews and protect stock endpoints`.
- Workeros API deployed source: `/opt/workeros-api-main`, commit `04e1591 fix proxy path encoding on vercel`.
- Workeros Cloud API deployed source: `/opt/workeros-cloud`, commit `985eea6 alias cloud engine routes at api root`, engine `04e1591`.
- `pytest` focused API/security batch: `56 passed`.
- `apps/web npm run build`: passed.
- `apps/web npm run lint`: `0 errors`, 20 pre-existing warnings outside this patch.
- `apps/web npm test -- --run`: `9 passed`.
- `git diff --check`: passed.
- Local browser/runtime checks:
  - XLSX proxy: `200`, Microsoft Excel payload, rendered rows including `Overall Performance`.
  - PDF: blob iframe present, no CSP errors.
  - Video: blob video present, no large-file guard, no CSP errors.
  - HTML: iframe preview/raw tabs present, no large-file guard.
  - CSP header includes `frame-src 'self' blob:` and `media-src 'self' blob:`.
- Live API checks:
  - `GET https://workers-api.floom.dev/healthz` -> `200`.
  - Browser preflight `OPTIONS https://workers-api.floom.dev/workers` -> `200` with `access-control-allow-origin: https://workers.floom.dev`.
  - Authenticated `GET https://workers-api.floom.dev/workspace/versions` -> `200 []`.
  - Authenticated `GET https://workers-api.floom.dev/workers/weekly_update/versions` -> `200 []`.
  - Authenticated `GET https://workers-api.floom.dev/contexts/rocketlist-seo-reports/versions` -> `200 []`.
  - Unauthenticated Cloud probes to `/workspace/versions` and `/api/workspace/versions` -> `401`, proving route existence rather than `404`.
  - `workeros-api-autodeploy.service` and `workeros-cloud-api-autodeploy.service` last timer run -> `status=0/SUCCESS`.

## Still open

- Slack still needs an end-to-end verified listener/channel flow, not just a UI status card.
- MCP server add flow is still a raw form; the requested command/import-first experience is not implemented.
- Worker Brain attachment UI exists but still needs a cleaner explanation and less confusing requirements wording.
- Version UI now exists for workers, agent instructions, and Brain packs; it still needs review for share/compare/diff quality.
- Standalone approval-review pages are not implemented.
- Workspace fork/share/transfer, including secret-handling rules, is not implemented.
- Workspace switcher bugs and per-workspace token verification need live Cloud retest after deploy.
- Overview page card heights/scroll behavior still need design work.
- Worker card/detail icon parity and Brain icon polish still need design work.
- Telemetry/data collection strategy, disclosure, export/delete paths, and event schema are not implemented.
- Email notification system is not verified as merged or production-ready.
- Granular connection scope UI/policy is not complete beyond lower-level allowlist primitives.
- Full security launch audit remains below launch threshold because Slack, standalone approvals, workspace sharing/transfer, telemetry, email, granular scopes, and authenticated workspace-token behavior are not fully verified.
