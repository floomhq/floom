# S35 Silent Failure Audit

Date: 2026-05-28
Scope: `apps/api/main.py`, `apps/api/run_service.py`, `apps/api/runner_sandbox/agent_driver.py`, `apps/api/runner_sandbox/e2b_driver.py`, `apps/api/db/sqlite.py`, `apps/api/db/_legacy_sqlite.py`, `apps/api/composio_client.py`

This PR is an audit-only documentation change. No runtime refactor is included.

## Inventory

Verified with `rg` and an AST pass on `origin/main` `720e85c`.

| Pattern | Count | Result |
| --- | ---: | --- |
| Bare `except:` | 0 | None found in scoped files. |
| `except Exception` | 94 | Most handlers log, return explicit typed errors, or fall back for non-critical UI helpers. |
| Pass-only `except` handlers | 16 | Line-level decisions below. |
| Composio/webhook signature handlers | 4 route-level checks | Invalid/missing signatures raise HTTP errors, not 200. |

Webhook verification:

- `apps/api/main.py:6093-6099`: missing `COMPOSIO_WEBHOOK_SIGNING_KEY` raises 503; invalid Composio signature raises 401.
- `apps/api/main.py:6720-6731`: missing worker webhook secret raises 500; invalid worker webhook signature raises 401.
- Direct TestClient smoke: invalid Composio signature returned 401; missing signing key returned 503.
- `pytest tests/test_pr_s13_info_disclosure_and_caps.py::test_webhook_aliases_match_original_routes -q` passed.
- Existing `tests/test_composio_triggers.py::{test_composio_events_with_invalid_hmac_returns_401,test_composio_events_without_signing_key_returns_503}` currently fail before the webhook path because their worker-create helper sends no `x-floom-secret`; this is a stale test setup failure, not a route behavior failure.

## Pass-Only Handlers

| File:line | Handler | Current behavior | Decision |
| --- | --- | --- | --- |
| `apps/api/main.py:155` | `asyncio.CancelledError` during shutdown sweep cancellation | Suppresses expected cancellation. | Keep. This is normal task cancellation during lifespan shutdown. |
| `apps/api/main.py:573` | `RuntimeError` publishing SSE to a closed loop | Drops event for disconnected consumer. | Keep, already commented. |
| `apps/api/main.py:645` | `RuntimeError` publishing run part to a closed loop | Drops part for disconnected consumer. | Keep but add the same explanatory comment as the SSE path in a later cleanup. |
| `apps/api/main.py:1148` | malformed `triggers_json` in `_build_triggers_spec` | Falls back to single trigger config with no log. | Log warning with `worker_id` when available; malformed trigger state hides config drift. |
| `apps/api/main.py:1177` | malformed `triggers_json` in `_build_triggers_list` | Falls back to single trigger label with no log. | Log warning/debug and expose a worker diagnostic later. |
| `apps/api/main.py:1565` | `Accepts` JSON parse failure | Falls back to comma-separated list. | Keep. This is intentional backward-compatible parsing. |
| `apps/api/main.py:2297` | worker-detail bundle/manifests read failure | Returns partial worker detail with empty source fields. | Log warning and include non-fatal detail diagnostics later. |
| `apps/api/main.py:2306` | webhook URL build failure | Returns worker detail without webhook URL. | Log warning. This can hide a broken webhook operator path. |
| `apps/api/main.py:3989` | rollback backup restore failure after worker file update error | Suppresses failed rollback attempt while returning 502. | Log error. Failed rollback is operationally important. |
| `apps/api/main.py:4015` | rollback backup restore failure after unexpected worker file update error | Suppresses failed rollback attempt while returning 500. | Log error. Failed rollback is operationally important. |
| `apps/api/main.py:4022` | temporary directory cleanup failure | Suppresses cleanup failure. | Log debug with path; not user-facing. |
| `apps/api/main.py:5094` | connection scope JSON parse failure | Returns empty scope list. | Log debug with connection id where available; avoid silently hiding scope metadata corruption. |
| `apps/api/main.py:6332` | overview scheduled trigger parse failure | Uses row trigger fields instead. | Log debug/warning; bad `triggers_json` can make schedules disappear from overview. |
| `apps/api/main.py:6669` | webhook trigger detection parse failure | Falls back to single config trigger. | Log warning. This can make a multi-trigger webhook worker reject legitimate webhooks. |
| `apps/api/db/sqlite.py:1025` | run duration parse failure in `complete` | Leaves `duration_ms` unset. | Log debug with `run_id`; keep status completion intact. |
| `apps/api/composio_client.py:338` | failed Composio error-body parse | Re-raises the original HTTPError. | Keep. No silent success or stub return occurs. |

## Stub/Fallback Returns

| File:line | Current fallback | Decision |
| --- | --- | --- |
| `apps/api/main.py:1048`, `apps/api/main.py:1068` | Stats/timeseries DB errors return `{}`. | Add logging and increment DB metrics in a follow-up; UI fallback is acceptable only after telemetry. |
| `apps/api/main.py:1203` | Transcript path validation errors return `[]`. | Keep. This is a path-boundary guard. |
| `apps/api/main.py:1262` | Composio manifest parse failure logs and returns `None`. | Keep logging; lifecycle sync then skips registration. Add admin-visible worker warning later. |
| `apps/api/main.py:1278` | Missing composio columns return `{}`. | Keep for migration tolerance only. Remove after all prod DBs are past migration 32. |
| `apps/api/main.py:1537`, `apps/api/main.py:1549` | Worker DB OperationalError returns empty list/none. | Replace with logged 503 in a follow-up. Empty inventory can mask DB failure as "no workers". |
| `apps/api/main.py:5345`, `apps/api/main.py:5683` | Composio account/auth-config fetch failure logs and returns partial account metadata. | Keep; user action paths still work and the warning is recorded. |
| `apps/api/main.py:5741` | Connection test upstream exception becomes failed test result. | Keep; this is a surfaced result, not silent. |
| `apps/api/main.py:6565` | `/metrics` DB exception logs, increments `workeros_db_connection_errors_total`, returns 500 text. | Keep. This is now observable. |
| `apps/api/run_service.py:262` | Bundle snapshot failure logs and returns `None`. | Keep; run can proceed without a snapshot. |
| `apps/api/run_service.py:593` | Secret-name DB failure returns empty set. | Add warning. Empty set can allow duplicate platform-secret filtering behavior to diverge. |
| `apps/api/runner_sandbox/agent_driver.py:666` | Cancel flag DB read failure returns `False`. | Add debug/warning. A transient DB failure can delay cancellation. |
| `apps/api/runner_sandbox/e2b_driver.py:260` | Top-level sandbox exception returns `WorkerResult(error_code="e2b_sandbox_error")`. | Keep. The run lands failed with explicit code. |
| `apps/api/runner_sandbox/e2b_driver.py:544` | Missing/invalid `result.json` returns `WorkerResult(error_code="missing_result")`. | Keep. The run lands failed with explicit code. |

## Webhook Raise/Pass Check

- No `raise`-then-`pass` pattern was found in `composio_events`, `composio_events_alias`, or `webhook_trigger`.
- Composio signature failures stop before JSON parsing and before worker lookup.
- Worker webhook signature failures stop before run creation.
- JSON parse failures after authentication are intentionally converted to `{"raw": ...}` payloads for signed/token-authenticated webhooks.

## Refactor Candidates

`main.py` is now a routing and service-mixing hotspot. Split by resource without changing route behavior:

1. `routers/system.py`: `/healthz`, `/health`, `/metrics`, `/system/metrics`, platform config.
2. `routers/workers.py`: worker list/detail/create/update/delete/reload and worker file editing.
3. `routers/runs.py`: run create/list/detail/approve/reject/stream/parts/uploads/artifacts.
4. `routers/connections.py`: Composio/MCP connection CRUD, callbacks, status checks.
5. `routers/triggers.py`: webhook receivers, Composio event receiver, trigger catalog.
6. `routers/secrets.py`: secret metadata and user secret endpoints.
7. `services/worker_manifest.py`: manifest parsing, trigger normalization, source-file extraction.
8. `services/webhook_security.py`: HMAC/token verification and webhook rate-limit helpers.
9. `services/observability.py`: health check and Prometheus formatting.
10. `services/worker_files.py`: upload/update rollback and diagnostics.

The highest-value follow-up is an exception policy pass for worker inventory and trigger parsing: log every fallback that can hide data corruption, and return 503 for DB availability failures instead of empty operational state.
