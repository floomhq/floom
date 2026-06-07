# From-Prompt Temperature Fix - 2026-06-05

## Summary

`POST /workers/new/from-prompt` failed in production because the worker-author path sent non-default `temperature` values to gpt-5.x chat models. The draft-and-create path already used `chat_completion_codegen`, which retries once without `temperature`; the from-prompt path did not apply the same protection everywhere.

## Root Cause

- `workers/worker-author/run.py` uses `_DEFAULT_CODEGEN_MODEL = "gpt-5.1"` and sent `temperature=0.2` from inside the E2B sandbox.
- `apps/api/runner_sandbox/skill_driver.py` sent `temperature=0.5` directly through `client.chat.completions.create`.
- gpt-5.x models reject non-default temperature values, producing HTTP 400 instead of a generated worker bundle.
- `/root/.config/workeros/api.env` contained `WORKER_AUTHOR_DEFAULT_MODEL=gpt-4.1`, but no repo code reads that variable. It was removed; the live propagated override is `WORKEROS_CODEGEN_MODEL`.

## Fix

- `workers/worker-author/run.py` now retries once without `temperature` when the provider rejects a non-default value.
- `apps/api/runner_sandbox/skill_driver.py` now wraps chat completions in `_chat_completions_create_temperature_safe`, preserving tools/timeout/model kwargs and retrying once without `temperature` only on the known provider error.
- `apps/api/codegen_model.py` stale docs now point to `WORKEROS_CODEGEN_MODEL`.
- Regression tests added:
  - `tests/test_worker_author_temperature.py`
  - `tests/test_skill_driver.py::SkillRuntimeDriverTest::test_model_temperature_rejection_retries_without_temperature`

## Local Verification

- `python3 -m pytest tests/test_codegen_model.py tests/test_worker_author_temperature.py tests/test_skill_driver.py::SkillRuntimeDriverTest::test_model_temperature_rejection_retries_without_temperature tests/test_wedge_prompt_to_worker_creates.py tests/test_workers_draft_from_prompt.py -q`
  - Result: 65 passed.
- `python3 -m py_compile apps/api/runner_sandbox/skill_driver.py workers/worker-author/run.py apps/api/codegen_model.py`
  - Result: passed.
- Known unrelated suite drift: `tests/test_skill_driver.py::SkillRuntimeDriverTest::test_missing_declared_output_fails_after_transcript` fails in isolation by returning `success` instead of expected `failed`.

## Deployment

- Code commit: `093e9c3e166f8cb8c52e58041e2d69b9d3abae43`.
- Pushed to `origin/main`.
- Ran `./ops/deploy-api.sh`.
  - DB backup: `/root/backups/manual/floom-predeploy-1780628620.db`.
  - Deploy script health gate: `ok`.
  - Migration version: 55.
- Active service verification:
  - `systemctl show workeros-api` working directory: `/opt/workeros-api-deploy/apps/api`.
  - `/opt/workeros-api-deploy` HEAD: `093e9c3e166f8cb8c52e58041e2d69b9d3abae43`.
  - Source grep in `/opt/workeros-api-deploy` confirmed `skill_driver.py` and `worker-author/run.py` contain the retry-without-temperature fix.
  - External `GET https://workers-api.floom.dev/health` returned HTTP 200 and `status: ok`.

## Production From-Prompt Verification

All checks used the real public prod API `https://workers-api.floom.dev` with the deploy secret header. Each from-prompt run reached terminal `completed` and produced `created_worker_id`.

| Prompt | Run ID | Created Worker ID | Terminal Status | Smoke |
|---|---|---|---|---|
| Text word/character/line count worker | `run_f7c47c53541d` | `fp-temp-word-char-0605030601` | `completed` | `passed` |
| Number stats worker | `run_69c82681681f` | `fp-temp-number-stats-0605030601` | `completed` | `passed` |
| Connection prompt: fetch recent Granola meetings and create HubSpot notes | `run_bcb6743ec0c0` | `fp-temp-granola-hubspot-0605030601` | `completed` | `skipped` (`not a script-mode worker`) |

The connection prompt did not hard-fail creation. It produced a worker and the smoke gate skipped because it generated an agent/connection-style worker rather than a script-mode worker.

## Draft-And-Create Regression

- First draft-and-create verification request exceeded the 30s client read timeout but did create `fp-temp-draft-create-0605030601`; that worker was deleted.
- Rerun with longer client timeout:
  - Endpoint: `POST /workers/draft-and-create`
  - Response: HTTP 200
  - Worker ID: `fp-temp-draft-create-0605031004`
  - Smoke: `passed`
  - Elapsed: 28.4s

## Cleanup

- `fp-temp-word-char-0605030601`: DELETE HTTP 204, follow-up GET HTTP 404.
- `fp-temp-number-stats-0605030601`: DELETE HTTP 204, follow-up GET HTTP 404.
- `fp-temp-granola-hubspot-0605030601`: DELETE HTTP 204, follow-up GET HTTP 404.
- `fp-temp-draft-create-0605030601`: DELETE HTTP 204 after timeout-created worker was discovered.
- `fp-temp-draft-create-0605031004`: DELETE HTTP 204, follow-up GET HTTP 404.
- Final `GET /workers?shape=list` scan: no `fp-temp-*` workers remain.

## Conclusion

The live P0 is fixed and verified against production. The from-prompt worker-author path completed for three prompts, including a connection-using Granola to HubSpot prompt, and every verified run produced `created_worker_id` instead of failing on gpt-5.x temperature handling.
