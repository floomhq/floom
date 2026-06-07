# PUT Fork + CLI Auth Fix

Date: 2026-06-06
Branch: `fix/put-fork-and-cli-auth`
PR: #486

## What Changed

### Protected stock worker PUT now forks

`PUT /workers/{id}` now mirrors the existing fork-on-write behavior for protected stock workers:

- Protected stock IDs such as `gmail_inbox_manager` are never mutated in place.
- A PUT to a protected stock ID creates a user-owned copy such as `gmail-inbox-manager-copy`.
- The response includes `cloned_from` with the original protected worker ID.
- The copied manifest is rewritten to the new worker ID and `is_example: false`.
- `DELETE`, `PATCH`, webhook-secret rotation, and other direct stock mutations remain blocked.

`PUT /workers/{id}/files` retains the same clone-on-edit behavior and its regression coverage now sits beside the `PUT /workers/{id}` coverage.

### CLI push auth and target handling

The packaged `workeros` / `floom` CLI now distinguishes:

- Not logged in: no saved credentials or env token.
- Expired auth: HTTP 401 or explicit expired/invalid token responses.
- Forbidden write: HTTP 403 responses that are permission or stock-protection failures, without calling them an expired session.
- Unreachable API base: network-level fetch failure with a hint to check the configured base URL.

The CLI also accepts legacy Floom env aliases in addition to Workeros env vars:

```bash
WORKEROS_API_BASE=https://workers-api.floom.dev
WORKEROS_API_SECRET=<token>
workeros workers push ./workers/gmail_inbox_manager
```

Equivalent legacy aliases:

```bash
FLOOM_API_BASE=https://workers-api.floom.dev
FLOOM_API_SECRET=<token>
workeros workers push ./workers/gmail_inbox_manager
```

`WORKEROS_API_BASE` / `WORKEROS_API_SECRET` take precedence when both naming schemes are present.

Saved credentials live in:

```text
~/.config/workeros/credentials.json
```

For normal interactive auth:

```bash
workeros login
workeros workers push ./workers/<id>
```

## Verification

Backend regression:

```bash
python3 -m pytest -q \
  tests/test_worker_push_p0.py \
  apps/api/tests/test_stock_worker_clone_on_edit.py \
  tests/test_round8_worker_authz.py::test_protected_stock_worker_direct_mutations_block_but_put_and_files_fork \
  tests/test_pr_s13_info_disclosure_and_caps.py::test_stock_worker_direct_mutations_block_but_create_put_and_files_fork
```

Result: `16 passed`.

CLI regression:

```bash
cd apps/mcp
npm test -- --test-name-pattern='workers push|workers validate'
```

Result: TypeScript build passed and `35` node tests passed.

## Live Deployment Note

This branch was not deployed. The fix is verified by code-path tests in the branch. Live `workers-api.floom.dev` behavior changes only after this PR is reviewed, merged, and deployed by the normal release path.
