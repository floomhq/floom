# Backend Batch Fix Report - 2026-06-04

Branch: `backend-emily-batch-20260604`  
PR: `#427` admin-squashed to main  
Deployed API SHA: `bb8c92942c3f88c00a817a428089bdbd3dceebfe`  
Deploy command: `ops/deploy-api.sh`  
Health: `GET https://workers-api.floom.dev/health` -> 200, `status=ok`  
Deploy checkout: `/opt/workeros-api-deploy` -> `bb8c92942c3f88c00a817a428089bdbd3dceebfe`

Mandatory source note: `docs/audits/{mcp,slack,web-chat}-emily-test-2026-06-04.md` and `WORKPLAN-20260604-emily-road-to-100.md` were absent from this worktree and fetched `origin/main`. This report and `WORKPLAN-20260605-backend-batch.md` record the batch instead.

## P0 Results

- A1 `workers__update` runtime no-op: FIXED.
  - Files/functions: `apps/api/chat_service.py` `_tool_workers_update`, `_smoke_gate_emily_worker`, `_manifest_executes_run_py`.
  - Fix: update writes the new manifest through the editor path, regenerates `run.py` for real `run.py` workers, then runs the existing smoke gate before Emily can report success.
  - Prod evidence: `cxtest-a1-4410f483`; before run `run_db40defe7596` completed with `{"result":"HELLO MIXED"}`. Emily called `workers__update`. After run `run_fffec79acedc` completed with `{"result":"hello mixed"}`. Worker deleted; GET returned 404.

- A2 caller-supplied conversation continuity: FIXED, with prod single-tenant scope caveat.
  - Files/functions: `apps/api/chat_service.py` `_client_conversation_storage_id`, `resolve_conversation_id`, `create_conversation`.
  - Fix: caller ids are mapped to owner-scoped internal `conv_client_*` ids; guessed foreign `conv_*` ids are remapped for that owner.
  - Prod evidence: caller id `cxtest-a2-26acccc0`; second `/chat` turn returned `codeword-0c343d`; internal id `conv_client_09a71926905154ce877c94972594a14e`.
  - Scope evidence: local tests cover foreign-user denial/remap. Prod has `WORKEROS_ENABLE_USER_HEADER_SCOPE` inactive, so `x-floom-user` did not create a second owner and cross-user 404 cannot be proven on the current single-tenant config.

- A3 non-web `source`: FIXED.
  - Files/functions: `apps/api/main.py` `ChatRequest`, `post_chat`; `apps/mcp/src/server.ts` `workspace.chat`.
  - Fix: `/chat` accepts `source` enum `web|slack|mcp|whatsapp`, defaults to `web`, and MCP stdio sends `source:"mcp"`.
  - Prod evidence: `/chat` with `source:"mcp"` returned 200; bad source returned 422; default source returned 200. MCP spot reply: `Workeros workspace MCP chat channel`.

- A4 MCP `workers.create` `[object Object]` error and YAML docs: FIXED.
  - Files/functions: `apps/mcp/src/server.ts` `renderErrorDetail`, request error handling, `workers.create` schema description; `apps/api/main.py` remote MCP schema description.
  - Fix: object `detail` is JSON-rendered after redaction, not coerced with `String()`. Tool docs include WorkerContract required fields and root `inputs.json` / `result.json`.
  - Prod MCP evidence: real stdio MCP call with invalid WorkerContract returned `HTTP 400: {"message":"Schema validation failed","errors":[...]}`; `contains_object_object=false`; structured status `400`; docs contained `schema_version` and `inputs.json`.

- B1 trailing-space auth: PARTIAL.
  - Files/functions: `apps/api/main.py` `auth_middleware`; `apps/api/auth/local.py` `SharedSecretAuthProvider.verify`.
  - Fix landed: app and auth dependency compare raw ASGI header bytes with `hmac.compare_digest`; no `.strip()` on provided secret.
  - Direct prod evidence: raw socket to Uvicorn `127.0.0.1:8011` returned 200 for exact secret and 403 for secret plus space, two spaces, tab, or wrong suffix.
  - Public-prod limitation: `https://workers-api.floom.dev/workers` still returns 200 for `curl -H "x-floom-secret: <secret> "` because Cloudflare/cloudflared normalizes optional trailing header whitespace before the app receives it. This P0 is not fully closed on the public URL repro.

- B2 `POST /workers/draft-and-create` 500: NO LIVE 500 REPRODUCED.
  - Files/functions: existing request validation in `apps/api/main.py` `DraftAndCreateRequest` and draft endpoint.
  - Prod evidence before and after deploy: `{}`, empty prompt, null prompt, invalid JSON, JSON null, JSON array all returned clean 4xx; no 500. `bad_mode` still returned 200 because mode is not a field on this endpoint.
  - Local evidence: `tests/test_pr_s9_draft_and_create.py::test_draft_and_create_empty_prompt_returns_400` passed.

- B5 approval pause: VERIFIED EXISTING.
  - Files/functions: existing approval gate in `apps/api/run_service.py`; no code change required.
  - Prod evidence: `cxtest-b5-e35143b3`; run `run_37d0b3a562be` reached `pending_approval` with output `{"message":"ready"}`. Worker deleted; GET returned 404.

## P1/P2 Results

- A5 tool-call SSE em dash leak: FIXED.
  - File/function: `apps/api/chat_service.py` `_finish_invoke_inner`.
  - Prod evidence: `finish_with_outputs` tool-call args for `alpha - beta` contained no em dash; raw tool event contained no em dash.

- A6 numeric smoke sample: FIXED.
  - File/function: `apps/api/run_service.py` `_sample_inputs_for_config`.
  - Fix: number inputs now receive numeric `1`, not string `"1"`.

- A7 over-fetch before every known-id action: SKIPPED.
  - No code change in this batch.

- A8 MCP run.py path docs: FIXED.
  - File/function: `apps/mcp/src/server.ts` worker contract description.
  - Prod evidence: live MCP `workers.create` schema includes root `inputs.json` / `result.json`.

- A9 Slack reply brevity: SKIPPED.
  - No code change in this batch.

- A10 proactivity: SKIPPED.
  - No code change in this batch.

- B6 webhook URL and rotate: VERIFIED EXISTING/FIXED ON MAIN.
  - File/function: `apps/api/main.py` `rotate_webhook_secret`.
  - Prod evidence: `cxtest-b6-6f0aa63d`; create returned `webhook_url`; rotate returned status 200 with one-time `secret` and `webhook_url`; worker deleted; GET returned 404.

- B7 `/connections/auth-configs`: SKIPPED / OPEN.
  - File/function observed: `apps/api/main.py` only defines `/connections/auth-configs/{auth_config_id}`.
  - Prod evidence: `GET /connections/auth-configs` returned 405 `Method Not Allowed`.

- P2 items A11-A13, B3-B4, B8: SKIPPED.
  - Not included after P0/P1 verification.

## Verification

Local verification before merge:

- `python3 -m pytest apps/api/tests/test_chat_backend_batch.py apps/api/tests/auth/test_local_provider.py apps/api/tests/test_emily_environment_aware.py apps/api/tests/test_emily_create_runnable.py apps/api/tests/test_langdock_workspace_agent_mcp.py tests/test_pr_s9_draft_and_create.py::test_draft_and_create_empty_prompt_returns_400 tests/test_api_endpoints.py::TestApprovalRunLifecycle::test_approval_required_run_publishes_pending_before_completed -q` -> 55 passed.
- `python3 -m py_compile apps/api/chat_service.py apps/api/main.py apps/api/auth/local.py apps/api/run_service.py` -> passed.
- `cd apps/mcp && npm test` -> 31 passed.
- `cd apps/mcp && npm run build` -> passed.
- `git diff --check` -> clean.

GitHub Actions did not execute: PR #427 jobs failed immediately with GitHub billing/spending-limit annotations, not test failures.

Cleanup verification:

- API cxtest worker count after cleanup: 0.
- Disk check under `/root/workeros/workers` and `/opt/workeros-api-deploy/workers`: no `cxtest-*` directories.
