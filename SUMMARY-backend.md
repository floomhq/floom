# Backend Summary

## Issue #1013: Default Memory Writeback

Implemented `memory: enabled` as a first-class worker capability.

- `apps/api/models.py`: added `WorkerMemoryConfig`, accepted `memory: enabled` / boolean / structured memory config, and normalized enabled memory into an implicit writable local context named `memory-<worker-id>` by default. WorkerContract conversion preserves the field.
- `apps/api/runner_sandbox/memory_context.py`: added shared helpers to detect memory, derive the pack name, create the owner-scoped pack, seed `MEMORY.md`, and mark metadata as writeable/sensitive memory.
- `apps/api/runner_sandbox/agent_capabilities.py`: ensures the memory pack exists before staging attached contexts for agent runs.
- `apps/api/runner_sandbox/e2b_driver.py`: ensures the memory pack exists before uploading contexts into E2B.
- `apps/api/runner_sandbox/agent_driver.py`: injects a worker-memory prompt notice and exposes `remember_learning`, which appends durable learnings to the staged memory pack; existing success-only writeback persists it.
- `apps/api/tests/test_agent_driver_contexts.py`: added a two-run regression proving a memory-enabled worker reads the pack at run start, writes a learning, persists it, and reads it on the next run.

Existing explicit `contexts:` behavior remains intact. If a worker already declares the same local memory context, runtime normalization upgrades it to `writeable: true`; unrelated explicit contexts are unchanged.

## Issue #1014: Parallel Sub-Agent Path

Implemented path 2, the E2B `run.py` path.

- `apps/api/runner_sandbox/e2b_driver.py`: injects resolved declared worker secrets into the actual sandbox worker command environment, while platform callback keys remain authoritative.
- `apps/api/tests/test_e2b_declared_secret_env_concurrency.py`: added a fake-sandbox regression that runs an uploaded async `run.py`, verifies AWS-style declared secrets are visible in `os.environ`, and proves 4 mocked provider calls complete faster than serial sleep time.

Follow-up: path 1, native agent-mode SDK `Agent.as_tool()` / handoff-based parallel sub-agent dispatch, remains open. The current agent `invoke_worker` tool is still synchronous.

## Test Compatibility Cleanup

- `apps/api/tests/test_g1_auth_lifecycle.py`: updated the worker-call lifecycle test to configure `FLOOM_SECRET`, matching the current middleware validation path for `wrt_` bearer tokens.
- `apps/api/tests/test_workspace_settings_794.py`: updated expectations to include `current_month_spend_usd`, matching the documented `/workspace/settings` response and existing #797 coverage.

## Verification

- `python3 -m pytest apps/api/tests/test_agent_driver_contexts.py -q` -> 4 passed.
- `python3 -m pytest apps/api/tests/test_e2b_declared_secret_env_concurrency.py -q` -> 1 passed.
- `/tmp/workeros-api-py311/bin/python -m pytest apps/api/tests/test_agent_driver_contexts.py apps/api/tests/test_e2b_declared_secret_env_concurrency.py -q` -> 5 passed.
- `/tmp/workeros-api-py311/bin/python -m pytest apps/api/tests/test_g1_auth_lifecycle.py::test_run_token_rejected_when_user_disabled apps/api/tests/test_workspace_settings_794.py::test_admin_round_trip -q` -> 2 passed.
- `cd apps/api && /tmp/workeros-api-py311/bin/python -m pytest -q` -> 1699 passed, 3 skipped.

Note: system `python3` is Python 3.12 with `pytest-asyncio==0.23.3`, which crashes during collection. I created `/tmp/workeros-api-py311` with `uv` and ran the suite under Python 3.11, matching the project setup instructions.

## Commits

- `2f50fcd3 Add default worker memory writeback`
- `948a14ae Inject declared secrets into E2B worker env`
- `68cd78d2 Update backend tests for current auth settings contracts`
- Final summary commit: `Document backend memory and E2B changes`
