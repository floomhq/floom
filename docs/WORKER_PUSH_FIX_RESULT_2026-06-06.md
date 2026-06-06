# Worker Push Fix Result - 2026-06-06

## Status

PR opened: #465

The worker-push implementation, targeted regression tests, and required API gate are green after rebasing `fix/worker-push-p0` onto `origin/main` at `7f6b9d8`.

## Design Decision For Failure #1

Chosen behavior: fork-on-write.

Raw worker create requests that use a protected stock ID such as `gmail_inbox_manager` do not mutate the stock worker. The API rewrites the manifest to a free user-owned ID such as `gmail-inbox-manager-copy`, forces `is_example: false`, persists that copy atomically, and returns the copied worker detail.

## PR Number

https://github.com/floomhq/workeros/pull/465

## Root-Cause Calls For Pre-Existing API Failures

- `tests/test_api_endpoints.py::TestAuthGate::test_get_workers_with_wrong_secret_returns_401`: real middleware bug. A wrong `x-floom-secret` is an invalid authentication credential, so the canonical response is `401 Unauthorized`, not `403 Forbidden`. `apps/api/main.py` now returns 401 for both missing and invalid shared-secret credentials.
- `tests/test_api_endpoints.py::TestAuthGate::test_connections_callback_validates_known_connection_id`: stale test. Composio callback `status=success` is normalized by the backend to the canonical stored connection status `active`. The test now asserts `active`, matching `_normalize_composio_connection_status`, `tests/test_connections_backend.py`, and the connection status docs.

## Test Results

Passing:

- `python3 -m py_compile apps/api/main.py tests/test_worker_push_p0.py` passed.
- `pytest -q tests/test_worker_push_p0.py` passed: 5 passed.
- `pytest -q tests/test_worker_push_p0.py tests/test_round8_worker_authz.py::test_protected_stock_worker_direct_mutations_block_but_files_fork tests/test_pr_s13_info_disclosure_and_caps.py::test_stock_worker_direct_mutations_block_but_create_and_files_fork` passed: 7 passed.
- `pytest -q tests/test_api_endpoints.py::TestAuthGate::test_get_workers_with_wrong_secret_returns_401 tests/test_api_endpoints.py::TestAuthGate::test_connections_callback_validates_known_connection_id apps/api/tests/test_backend_batch_b9_binrest_wback.py::test_binary_restore_bad_token_and_owner_scope` passed: 3 passed.
- `python3 -m py_compile apps/api/main.py tests/test_api_endpoints.py apps/api/tests/test_backend_batch_b9_binrest_wback.py` passed.
- `pytest -q tests/test_api_endpoints.py tests/test_round8_worker_authz.py tests/test_pr_s13_info_disclosure_and_caps.py tests/test_worker_push_p0.py` passed: 124 passed, 7 warnings.

## GitHub Checks

GitHub Actions run `27049427708` did not start the Web, API, or MCP jobs. GitHub reported: "The job was not started because recent account payments have failed or your spending limit needs to be increased." Vercel preview was still pending when checked.

## One-Shot Orphan Cleanup Status

Not run.

Reason: the orphan reaper is implemented in this branch, but the live `workeros-api.floom.dev` API does not have this code until a later deploy. This lane explicitly forbids deploy. Running the cleanup against live before deploy would still hit the old delete behavior.

## Blocker

None in the local required gate. PR #465 is open. It has not been merged or deployed. GitHub-hosted CI is blocked by account billing/spending-limit state rather than by a reported test failure.
