# Workeros Audit Loop - 2026-06-01

## Score

Current verified score: **72 / 100**.

This is not a launch-ready 100. The score moved up because the build/test baseline is green, Brain asset previews now work locally for XLSX/PDF/video/HTML, Brain has a versions surface, agent instructions are read-only until Edit, and several API info-disclosure/stock-worker protection issues are patched in source.

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

## Evidence

- Workeros commit: `5ddda00 fix brain previews and protect stock endpoints`.
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

## Still open

- `workers-api.floom.dev` is still blocked by Cloudflare for unauthenticated `/healthz`, `/health`, and `OPTIONS /workers`.
- Hosted OSS origin still needs the pushed engine code deployed and the deleted stock workers restored/redeployed.
- Cloud API needs the new submodule commit deployed/restarted before the auth changes are live.
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
- Full security launch audit remains below launch threshold because the Cloudflare edge issue and remaining product/auth flows are unresolved.

