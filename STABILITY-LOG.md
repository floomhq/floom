# STABILITY LOG

## 2026-06-23 — CLI Auth Canonical Flat Page

Status: implemented and verified.

Flaws first:
- The previous CLI auth page used a two-panel illustrative layout for a focused authorization decision.
- Browser rendering of the live authed app is hook-blocked on this box, so visual verification for this item is limited to static HTML feedback plus code/test verification.
- Raw `npm exec tsc -- --noEmit --pretty false` is not a clean repo signal on this checkout because it typechecks Vitest files excluded by `vitest.config.ts` and reports pre-existing `@/proxy` test imports plus a generated-tree `EmilyRadarMark` issue from `origin/main`; the actual `npm run build` TypeScript phase completed cleanly.

Fix:
- Replaced the CLI auth presentation with one flat, token-based card while preserving the existing approve/deny state machine and backend endpoints.
- Added the canonical page and seam test as cloud overlay files so `sync-engine-web.mjs` keeps the change durable after engine sync.
- Posted the self-contained static HTML mock to htmlfeedback: https://htmlpreview.floom.dev/v/-nd3rccs8ZD6Oh3V

Honest score: 8/10.

Remaining work:
- Live authed-app screenshot verification remains unavailable on this box by instruction and hook block.
- Raw `tsc --noEmit` remains noisy on pre-existing repo/test-config issues; `npm run build` is clean and includes the Next TypeScript phase.
- The CLI auth presentation is duplicated in the overlay companion file by design so sync preserves it; longer-term, the same canonical design can be upstreamed to the public WorkerOS engine and the cloud overlay removed.

Verification:
- `npm exec vitest -- run tests/cli-auth-seams.dom.test.tsx --project dom`: 8 tests passed.
- `npm run check-drift`: pass, synced tree matches `engine/apps/web` with declared overlay exclusions.
- `npm run build`: pass, production build compiled and completed TypeScript.
- `openhtmlfeedback --title "cli-auth — clean flat (canonical)" --project floom --agent codex --replace-key "floom:cli-auth:canonical" --file /tmp/cli-auth-canonical.html`: posted.

## 2026-06-23 — Deterministic List Data

Status: backend fix implemented and PR opened: https://github.com/floomhq/workeros-cloud/pull/593

Flaws first:
- The frontend React Query cleanup requested for `/workers`, `/runs`, and `/overview` was not committed in the cloud PR because those dashboard files are generated from the WorkerOS engine during `web/scripts/sync-engine-web.mjs`; committing generated edits here would be overwritten by build/deploy sync unless we intentionally expand the cloud overlay.
- The PR therefore fixes the durable cloud-owned root cause in the Supabase repositories: fail-closed list scope and stable backend ordering.

Fix:
- Worker/run/overview list reads now return empty when neither active workspace nor user scope exists.
- Run list, per-worker run list, and overview created-desc pages use `created_at desc, id desc`, removing database-dependent order for equal timestamps.
- Tests cover chained PostgREST order semantics, fail-closed unscoped reads, stable equal-timestamp run ordering, and existing worker-agent workspace isolation.

Honest score: 7/10.

Remaining work:
- Upstream the frontend React Query/invalidate-on-mutation cleanup to WorkerOS, or explicitly accept a cloud overlay expansion for those generated dashboard files.
- Run the reload-regression API spec with real e2e credentials after PR 3 lands to catch frontend/cache regressions from the deployed surface.

Verification:
- `python3 -m pytest tests/test_supabase_overview_queries.py tests/test_workers_for_agent_scope_237.py`: 9 tests passed.
- `git diff --check`: pass.
- `npm run build`: pass after replacing the invalid worktree `node_modules` symlink with local `npm ci`; build completed the Next TypeScript phase.

## 2026-06-23 — Reload Regression And Smoke Gate

Status: implemented and PR opened: https://github.com/floomhq/workeros-cloud/pull/594

Flaws first:
- The new Playwright API reload spec was not executed against production locally because this box does not have `WORKEROS_E2E_ADMIN_TOKEN`.
- The test avoids browser rendering by design and only exercises API datasets behind the main authed routes.

Fix:
- Added an API-level reload regression that refetches workers, runs, and overview datasets 5 times and compares canonical ID sets.
- Changed `ops/smoke-routes.sh` so any 4xx/5xx/508/curl failure fails the deploy gate.
- Added hermetic smoke-script tests with a fake `curl`, proving 404 and 503 block promotion.

Honest score: 8/10.

Remaining work:
- Execute `tests/e2e/10-reload-regression.api.spec.ts` in CI or a credentialed shell with `WORKEROS_E2E_ADMIN_TOKEN` and `WORKEROS_E2E_MEMBER_TOKEN` set.
- If auth redirects intentionally produce 401/403 for some smoke routes, update the route list rather than weakening the 4xx/5xx deploy gate.

Verification:
- `python3 -m pytest tests/test_smoke_routes_gate.py`: 2 tests passed.
- `git diff --check`: pass.
- `WORKEROS_E2E_ADMIN_TOKEN=dummy WORKEROS_E2E_MEMBER_TOKEN=dummy npx playwright test tests/e2e/10-reload-regression.api.spec.ts --list`: pass, 1 test discovered without live requests.
