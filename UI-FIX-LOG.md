# UI Fix Log

## PR 1 - fail-closed error handling sweep

Score: 8/10

Closed audit items:
- `useMembers` no longer catches every error and returns `[]`; React Query now exposes member lookup failures.
- Connections collection errors now come from the primary connections query, while secrets/workers/members failures render a retryable metadata warning.
- Library folder detail failures render an inline retryable error instead of a permanent file-tab skeleton.
- MCP secret list failures render a retryable access-key error and block secret-backed saves until the secret lookup succeeds.
- Run CSV export distinguishes complete export from loaded-page fallback and uses an error toast plus partial filename on API failure.
- Connections secret `Used by` overview links preserve `sel` while switching to the `Used by` tab.

Verification:
- `npm exec vitest -- run tests/ui-audit-fail-closed.dom.test.tsx tests/mcp-list-error-state.dom.test.tsx tests/connection-detail-r9.dom.test.tsx` - 3 files / 13 tests passed.
- `npm exec tsc -- --project tsconfig.ui-audit-pr1.tmp.json --noEmit --pretty false` - passed for PR 1 changed files and relevant tests; temporary config was removed after the run.

Remaining flaws:
- Browser rendering is hook-blocked, so visual confirmation of inline error layout is not available in this PR.
- Repo-wide `npm exec tsc -- --noEmit --pretty false` still fails on unrelated existing baseline issues (`EmilyRadarMark`, `@/proxy` test imports, and older test fixture type drift).
- MCP and secrets still use bespoke list shells; this PR only fixes the secret dependency fail-open path requested for PR 1.

## PR 2 - settings profile save and fail-closed settings states

Score: 8/10

Closed audit items:
- Profile save now uses the Cloud self-service `/auth/profile` backend path through `api.updateMe`, and success is only shown after that call resolves.
- Profile save failures render inline error text and an error toast; non-OK/catch paths no longer optimistically update local state or show success.
- Settings admin state starts locked and only enables privileged controls after `/me` verifies owner/admin/admin status.
- `/me` failure renders a retryable permissions error and keeps privileged controls locked.
- Personal access token load failures render a retryable inline error instead of removing the panel.
- System information load failures render a retryable inline error instead of leaving skeletons mounted forever.

Verification:
- `python -m pytest tests/test_auth_email_flows.py -k profile_update -q` - passed.
- `npx vitest run tests/profile-update-api.test.ts tests/settings-fail-closed.dom.test.tsx` from `web/` - 2 files / 6 tests passed.

Remaining flaws:
- Browser rendering is hook-blocked, so layout and focus behavior for the new alerts is verified by DOM tests only.
- Repo-wide `npm exec tsc -- --noEmit --pretty false` has unrelated existing baseline failures outside this PR.

## PR 3 - list defaults and semantic collection heading

Score: 9/10

Closed audit items:
- Settings now defaults to list view through both initial collection state and collection config.
- `CollectionView` renders its route title as an `h1` while keeping the existing title sizing/weight.
- Workers, Library, and Connections were already list-default on current `origin/main`; this PR verifies and preserves the shared list-default behavior through collection tests.

Verification:
- `npm exec vitest -- run tests/collection-view.dom.test.tsx tests/settings-collection.dom.test.tsx tests/collection-pages.dom.test.tsx` - 2 discovered files / 36 tests passed.
- `npm exec tsc -- --project tsconfig.ui-audit-pr3.tmp.json --noEmit --pretty false` - passed for PR 3 changed files and relevant tests; temporary config was removed after the run.

Remaining flaws:
- Browser rendering is hook-blocked, so heading layout is verified by DOM semantics and TypeScript rather than screenshots.
- `tests/collection-pages.dom.test.tsx` was included in the command but not discovered by the active Vitest project for that run.

## PR 4 - focus rings, hit areas, and tokenized warning colors

Score: 8/10

Closed audit items:
- Base `Button` now has visible `focus-visible` rings using app tokens.
- Button sizes and icon-button defaults now use larger interactive hit areas while preserving compact icon/text interiors.
- `IconButton` now defaults to the 44px `icon` size instead of the old 28px `icon-sm`.
- Brain file type icons now use semantic CSS tokens instead of hardcoded hex colors; PDF/folder warning states use `--warning`.
- Terminal dark mode and error output now use semantic tokens instead of hardcoded hex or red/error classes.

Verification:
- `npm exec vitest -- run tests/ui-audit-a11y-tokens.test.ts tests/a11y-contrast-tokens-1712.test.ts tests/flat-by-token.test.ts` - 3 files / 46 tests passed.
- `npm exec tsc -- --project tsconfig.ui-audit-pr4.tmp.json --noEmit --pretty false` - passed for PR 4 changed files and relevant tests; temporary config was removed after the run.

Remaining flaws:
- Browser rendering is hook-blocked, so focus-ring and hit-area behavior is verified by source/tests, not screenshot or keyboard traversal.
- This PR fixes the audited shared primitives and named color files only; it does not sweep every bespoke raw button in the app.
