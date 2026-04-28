# Floom MCP MVP Product Stress Test Report

- Date (UTC): 2026-04-28
- Tester: Codex (automated MCP integration testing)
- Environment: `https://mvp.floom.dev/mcp`
- Auth mode: Bearer agent token (`read-write` scope)
- Repository: `floomhq/floom`
- Branch: `launch-week-apps`

## 1) Executive Summary

This test pass covered live end-to-end behavior of the expanded MVP MCP surface, including discovery, app metadata, app execution, studio app lifecycle, reviews, secrets, and account token lifecycle.

### Overall result

- Primary stress suite actions executed: `43`
- Passed: `37`
- Failed: `6`
- Follow-up defect isolation suite: completed
- Temporary resources cleanup: completed (apps deleted, temp token revoked, temp account secret removed)

### Headline findings

1. The MCP has expanded significantly and is functional across most core product paths.
2. Most failures are concentrated in lifecycle transition semantics and error surfacing.
3. Several responses currently return `500 illegal_transition` where deterministic 4xx policy/transition errors are expected.

## 2) Scope and Coverage

## Tools discovered (live)

Total tools discovered during test: `38`

- Discovery & app read:
  - `discover_apps`, `get_app_skill`, `get_app_details`, `get_app_about`, `get_app_source`, `list_app_reviews`
- Run execution:
  - `run_app`, `get_run`, `list_my_runs`
- Reviews:
  - `submit_app_review`, `leave_app_review`
- Studio lifecycle:
  - `studio_publish_app`, `studio_detect_app`, `studio_ingest_hint`, `studio_list_my_apps`, `studio_fork_app`, `studio_claim_app`, `studio_install_app`, `studio_uninstall_app`, `studio_get_app_rate_limit`, `studio_set_app_rate_limit`, `studio_update_app`, `studio_delete_app`, `studio_get_app_sharing`, `studio_set_app_sharing`, `studio_submit_app_review`, `studio_withdraw_app_review`, `studio_list_secret_policies`, `studio_set_secret_policy`, `studio_set_creator_secret`, `studio_delete_creator_secret`
- Account:
  - `account_get`, `account_list_secrets`, `account_set_secret`, `account_delete_secret`, `account_list_agent_tokens`, `account_create_agent_token`, `account_revoke_agent_token`

## Tested user journeys

1. App discovery + metadata retrieval on public app (`floom-this`)
2. Multiple app runs + run retrieval (`base64`, `hash`, `floom-this`)
3. Studio app creation/detection/publish/update/delete with temporary app
4. Sharing and install/uninstall behavior on published app
5. Secret policy and creator secret management
6. Public review submission/update behavior
7. Account secrets CRUD and agent token create/revoke
8. Full cleanup verification

## 3) Methodology

- Tests executed via direct JSON-RPC MCP calls to `https://mvp.floom.dev/mcp`.
- Both positive and negative paths were exercised.
- Failure reproduction pass created two controlled temporary apps:
  - App A: no declared security keys
  - App B: OpenAPI with `components.securitySchemes.ApiKeyAuth`
- All temporary entities were removed at end of testing.

## 4) Results Matrix

## A. Core read/discovery

- `account_get`: ✅
- `account_list_secrets`: ✅
- `account_list_agent_tokens`: ✅
- `discover_apps` (limit/query): ✅
- `list_my_runs`: ✅
- `studio_list_my_apps`: ✅
- `get_app_skill/details/about/source`: ✅
- `list_app_reviews`: ✅

## B. App execution

- `run_app(base64)`: ✅ success
- `run_app(hash)`: ✅ success
- `run_app(floom-this analyzeFloomThis)`: ✅ success
- `get_run` on created run IDs: ✅ success

Representative run IDs:

- `run_5q2f0bzjrwg2` (`base64`)
- `run_7tpeff4ew2fb` (`hash`)
- `run_64j5pv2wr11c` (`floom-this`)

## C. Studio lifecycle

- `studio_detect_app`: ✅
- `studio_publish_app`: ✅ (returns `publish_status: pending_review`)
- `studio_get_app_sharing`: ✅
- `studio_set_app_sharing` to `link`: ✅
- `studio_get_app_rate_limit`: ✅
- `studio_set_app_rate_limit`: ✅
- `studio_update_app`: ✅
- `studio_delete_app`: ✅

### Studio failures observed

1. `studio_claim_app` on just-published/owned app: ❌ `409 already_owned`
2. `studio_install_app` on own pending-review app: ❌ `404 not_found`
3. `studio_set_secret_policy` on undeclared key: ❌ `400` (expected behavior)
4. `studio_set_creator_secret` on undeclared key: ❌ `400` (expected behavior)
5. `studio_submit_app_review` on own app: ❌ `500 illegal_transition`
6. `studio_withdraw_app_review` on own app: ❌ `500 illegal_transition`

## D. Secrets and account lifecycle

- `account_set_secret` / `account_delete_secret`: ✅
- verification via `account_list_secrets`: ✅
- `account_create_agent_token`: ✅
- `account_revoke_agent_token`: ✅

Temporary token created and revoked:

- `agtok_b17b5867-3483-440a-b1e6-9041eb8741a8`

## E. Reviews on public app

- `submit_app_review` on `floom-this`: ✅ upsert-style success
- `leave_app_review` on `floom-this`: ✅ upsert-style success

## 5) Deep-Dive Defect Isolation (Second Pass)

A focused second pass reproduced transition and secret-key behavior with controlled app specs.

### Repro bundle

Temporary apps:

- `mcp-bug-28085700a` (no secret declarations)
- `mcp-bug-28085700b` (declares `ApiKeyAuth` security scheme)

Both published successfully and then deleted successfully.

### Confirmed behaviors

1. Claiming owned app
- `studio_claim_app` returns structured conflict:
  - `status: 409`, `code: already_owned`
- Interpretation: expected behavior.

2. Secret policy key matching
- For app with no secrets:
  - `studio_list_secret_policies` returns `[]`
  - setting `API_KEY` fails with `400` and `valid_keys: []`
- For app with `ApiKeyAuth`:
  - `studio_list_secret_policies` includes key `ApiKeyAuth`
  - `studio_set_secret_policy(key="ApiKeyAuth")` succeeds
  - `studio_set_creator_secret(key="ApiKeyAuth")` succeeds
  - using header name `X-API-Key` fails with `400` + `valid_keys: ["ApiKeyAuth"]`
- Interpretation: expected behavior; key is the security scheme name, not header field name.

3. Sharing transition to `invited`
- `studio_set_app_sharing(state="invited")` returned:
  - `500 runtime_error illegal_transition`
- Interpretation: likely product defect (error class/contract), or missing prereq with incorrect surfacing.

4. Install behavior under pending review
- `studio_install_app` returned `404 not_found` after publish, under both `private` and `link` states.
- Interpretation: maybe intentional for pending-review apps, but error semantics are opaque.

5. Studio review transitions
- `studio_submit_app_review` and `studio_withdraw_app_review` on own published app both return `500 illegal_transition`.
- Interpretation: likely transition handling issue or unimplemented state path with internal error surfacing.

## 6) Severity-Ranked Issues

### High

1. `studio_set_app_sharing(state="invited")` -> `500 illegal_transition`
- Why high: state mutation path throws internal-class error instead of deterministic API policy response.

2. `studio_submit_app_review` / `studio_withdraw_app_review` -> `500 illegal_transition`
- Why high: review workflow path is unusable for this app state and leaks internal transition error.

### Medium

3. `studio_install_app` on own pending-review app -> `404 not_found`
- Why medium: likely policy-gated, but `404` obscures true reason and complicates client logic.

### Low / Expected-validation

4. secret key validation failures on undeclared keys (`API_KEY` / `X-API-Key`)
- Why low: behavior is correct and schema-consistent.

## 7) Product and API Contract Recommendations

1. Replace `500 illegal_transition` with explicit 4xx transition errors.
- Include `current_state`, `allowed_transitions`, and actionable reason.

2. Clarify install eligibility and return precise policy errors.
- If pending-review apps cannot be installed, return `409` or `422` with policy code, not `404`.

3. Document secret policy key mapping explicitly.
- State clearly that secret keys map to `securitySchemes` keys (e.g., `ApiKeyAuth`), not HTTP header names.

4. Add lifecycle introspection helper(s).
- Example: `studio_get_app_state` returning state machine + allowed actions.

5. Ensure parity between public review tools and studio review tools.
- Public review endpoints functioned; studio review transitions failed on tested state.

## 8) Cleanup Verification

Cleanup completed during both suites:

- Deleted temp stress app: `mcp-stress-28085521`
- Deleted defect-isolation apps:
  - `mcp-bug-28085700a`
  - `mcp-bug-28085700b`
- Revoked temp created token: `agtok_b17b5867-3483-440a-b1e6-9041eb8741a8`
- Removed temp account secret: `MCP_STRESS_085521`

## 9) Confidence and Limitations

Confidence level: high for surfaced behaviors; all findings are from live endpoint calls with direct payload/response inspection.

Limitations:

- No UI/browser workflow validation included in this report.
- Concurrency/race stress (parallel write bursts) was not included in this pass.
- Some policy decisions may be intentional; recommendations focus on API clarity and operational ergonomics.

## 10) Final Verdict for MVP

The MCP is broadly functional and significantly advanced versus earlier builds.

MVP readiness status:

- Core discovery/run/account paths: strong
- Studio authoring lifecycle: mostly functional
- Remaining launch blockers to resolve or explicitly document:
  - lifecycle transition 500s (`invited` sharing, studio review actions)
  - install semantics for pending-review apps

