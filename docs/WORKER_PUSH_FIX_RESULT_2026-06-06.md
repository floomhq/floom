# Worker Push Fix Result - 2026-06-06

## Status

Blocked before PR creation.

The worker-push implementation and targeted regression tests are complete, but the required gate "Run the existing api test suite green before PR" is blocked by two pre-existing `tests/test_api_endpoints.py` failures that reproduce on a fresh detached `origin/main` worktree at `fd96ba2`.

## Design Decision For Failure #1

Chosen behavior: fork-on-write.

Raw worker create requests that use a protected stock ID such as `gmail_inbox_manager` do not mutate the stock worker. The API rewrites the manifest to a free user-owned ID such as `gmail-inbox-manager-copy`, forces `is_example: false`, persists that copy atomically, and returns the copied worker detail.

## PR Number

No PR created because the existing API suite gate is not green.

## Test Results

Passing:

- `python3 -m py_compile apps/api/main.py tests/test_worker_push_p0.py` passed.
- `pytest -q tests/test_worker_push_p0.py` passed: 5 passed.
- `pytest -q tests/test_worker_push_p0.py tests/test_round8_worker_authz.py::test_protected_stock_worker_direct_mutations_block_but_files_fork tests/test_pr_s13_info_disclosure_and_caps.py::test_stock_worker_direct_mutations_block_but_create_and_files_fork` passed: 7 passed.

Blocked gate:

- `pytest -q tests/test_api_endpoints.py tests/test_round8_worker_authz.py tests/test_pr_s13_info_disclosure_and_caps.py` in `/tmp/workeros-worker-push`: 115 passed, 4 failed.
- After aligning the two stock-worker expectations to fork-on-write, the remaining two failures are:
  - `tests/test_api_endpoints.py::TestAuthGate::test_get_workers_with_wrong_secret_returns_401`
  - `tests/test_api_endpoints.py::TestAuthGate::test_connections_callback_validates_known_connection_id`
- The same two tests fail on a fresh detached `origin/main` worktree at `/tmp/workeros-origin-verify`:
  - `test_get_workers_with_wrong_secret_returns_401`: expected 401, actual 403.
  - `test_connections_callback_validates_known_connection_id`: expected `success`, actual `active`.

## One-Shot Orphan Cleanup Status

Not run.

Reason: the orphan reaper is implemented in this branch, but the live `workeros-api.floom.dev` API does not have this code until a later deploy. This lane explicitly forbids deploy. Running the cleanup against live before deploy would still hit the old delete behavior.

## Blocker

The mandatory pre-PR API-suite-green gate is blocked by pre-existing main-branch failures outside the worker-push/create path. Work stopped here per the brief.
