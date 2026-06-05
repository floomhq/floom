# Backend Pass 2 Audit - 2026-06-05

## Scope

Backend pass 2 covered model split, permanent chat message storage with bounded prompt context, Emily persona v5, worker short links, MCP tool creation, public approval read links, and control-character rejection for secret values.

The brief-referenced files `docs/design/emily-persona-research-2026-06-04.md` and `WORKPLAN-20260604-emily-road-to-100.md` were absent from this worktree and from the checked path listing. The pass-specific workplan updated in this run is `WORKPLAN-20260605-backend-pass2.md`.

## Commits

- `e3aae89` - Apply Emily persona v5 workspace prompt.
- `f442370` - Keep chat history and expose Emily MCP tools.
- `34da40d` - Add backend pass2 public API fixes.
- `25b2960` - Fix codegen retry for default-temperature models.

## Deployment

First deploy completed at `34da40de3fb14d5bb0722873ea624d57cb83acce`, then production codegen verification found `gpt-5.5` rejected `temperature=0.2`. The backend was patched and redeployed to avoid leaving the production codegen path broken.

Final deployed SHA: `25b29603d8adc23963ae2f255f3a9bb21987f133`.

Deploy evidence:

- DB backup: `/root/backups/manual/floom-predeploy-1780626832.db`.
- Service: `workeros-api`.
- Health: `ok` after 2 seconds.
- Endpoint checks: `/healthz`, `/health`, `/workspace`, `/conversations`, `/approvals`, `/workers` all returned 200.
- Schema drift: all 29 expected tables present.
- Migration version: 55.

## Local Verification

- `pytest -q tests/test_backend_pass2.py apps/api/tests/test_worker_share_public.py apps/api/tests/test_chat_backend_batch.py apps/api/tests/test_workspace_agent_capabilities.py apps/api/tests/test_approval_public_decision.py tests/test_pr231_correctness.py tests/test_agent_mcp_connections.py tests/test_pr_s6_final_batch.py tests/test_r7_security.py tests/test_codegen_model.py apps/api/tests/test_secret_scan.py apps/api/tests/test_strip_em_dashes.py` -> 126 passed.
- `python3 -m compileall -q apps/api` -> exit 0.
- `git diff --check HEAD` -> exit 0.
- `codex review --uncommitted` -> exit 0, no P1 findings. P2 short-link race fixed before final verification. Untracked `CODEX_BRIEF_pass2.md` remained uncommitted.

## Production Verification

Model split:

- `/proc/<workeros-api-pid>/environ` contains `WORKEROS_CHAT_MODEL=gpt-5.4-mini`.
- `/proc/<workeros-api-pid>/environ` contains `WORKEROS_CODEGEN_MODEL=gpt-5.5`.
- `/system/workspace-agent` returned 200 with model `gpt-5.4-mini`, 31 tools, and all `mcp_tools__list/register/update/delete` tools present.

Emily persona v5:

- `/workspace` returned 200, SHA-256 `52e093bd09728d12b1a08766c019a26995fa2fb2de0d48f41186795f6bc42879`.
- Workspace content contains `You are Emily`.
- Workspace content contains no em dash or en dash.
- `/chat` with `hi` returned finish, no error, called `secrets__list_names` and `finish_with_outputs`, reported missing `GRANOLA_API_KEY`, and contained no em dash or en dash.
- `/chat` with `who are you?` returned finish, no error, identified as Emily, and contained no em dash or en dash.

Codegen on `gpt-5.5`:

- `/workers/draft-from-prompt` returned 200 for `p2test-codegen-temp-fix`.
- Created worker `p2test-codegen-temp-fix`.
- Runs completed:
  - `run_9a614b0db803` output `{"reversed_text": "cba"}`.
  - `run_b1545a385c08` output `{"reversed_text": "owt ssap dnekcab"}`.

Conversation storage:

- Deployed `chat_service.create_conversation`, `insert_message`, `_maybe_evict_conversation`, `list_conversation_messages`, and `load_conversation_history` were invoked against the production DB.
- Conversation `conv_b210b94800b14ab5` stored 55 messages.
- Prompt history returned 50 messages.
- First stored row remained `p2test full storage message 0`.
- First prompt-window row was `p2test full storage message 5`, last was `p2test full storage message 54`.

Short links:

- `POST /workers/p2test-codegen-temp-fix/short-link` returned 200 with short id `fls_hosacSIW5y`.
- `GET /workers/short-links/fls_hosacSIW5y` returned 200 without auth.
- `GET /s/fls_hosacSIW5y` returned 200 without auth.
- Public projection keys were limited to worker-safe fields; no `run_py`, `manifest_yaml`, `source`, `secrets`, `secret_values`, `owner_id`, `recent_runs`, or `runs` appeared.

MCP tools:

- `POST /mcp/tools` created `p2test_tool_1780627092` for `p2test-codegen-temp-fix`.
- `GET /mcp/tools` returned 200 and included the created tool.
- `POST /mcp-tools/serve` with `tools/list` returned 200 and included the created tool among 62 tools.
- `DELETE /mcp/tools/204ecf99-ce33-465f-b5fc-9c14ca012ab6` returned 200 with status `deleted`.

Public approval route:

- Synthetic pending approval `apr_p2test_1780627092` was inserted for the p2test worker.
- `GET /approvals/public/apr_p2test_1780627092?token=<valid>` returned 200 and status `pending`.
- Public approval response contained no `owner_id` or `public_link`.
- Same approval with a bad token returned 401 and `Invalid or expired approval link`.

Secret value controls:

- `POST /secrets/P2TEST_CONTROL` with newline returned 400.
- `POST /secrets/P2TEST_CONTROL` with tab returned 400.
- `POST /secrets/P2TEST_CONTROL` with NUL returned 400.
- Error detail: `Secret value must not contain newline or control characters`.

Cleanup:

- `DELETE /workers/p2test-codegen-temp-fix` returned 204.
- Follow-up `GET /workers/p2test-codegen-temp-fix` returned 404.
- Checked worker directories under `/root/workeros/workers`, `/opt/workeros-api-deploy/workers`, and `/root/workeros/apps/api/workers`; none existed for the p2test worker.
- DB counts after cleanup: p2test workers 0, short links 0, MCP tools 0, approvals 0, runs 0.

## Status

All backend pass 2 items are verified against production after the final redeploy. The only deviation from the brief is deployment count: one initial deploy exposed the `gpt-5.5` temperature incompatibility, and a second deploy corrected it before final verification.
