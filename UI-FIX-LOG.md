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
