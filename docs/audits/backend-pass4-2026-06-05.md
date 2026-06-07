# Backend Pass 4 Audit

Date: 2026-06-05
Branch: `fix/backend-pass4-20260605`
Deploy: not performed

## Scope

- M68 persona two-layer: editable base persona plus editable workspace custom instructions.
- Composio connection initiation: upstream failures return graceful `503`.
- Deploy mechanism: install deployed API requirements into the actual service venv before restart.

## Changes

### Persona Two-Layer

- Added optional runtime file `workspace.base.md` for an editable Emily base-persona override.
- Kept `workspace.md` as the workspace custom-instructions layer.
- System prompt assembly order is now:
  1. resolved base persona, defaulting to built-in `EMILY_BASE_PERSONA`
  2. workspace custom instructions from `workspace.md`
  3. workspace-agent `SKILL.md` with live workspace preamble
- Added `/workspace/base` `GET` and `PUT` endpoints.
- Added separate base-persona version endpoints:
  - `GET /workspace/base/versions`
  - `GET /workspace/base/versions/{version_id}`
  - `POST /workspace/base/rollback/{version_id}`
- Existing `/workspace` and `/workspace/versions` behavior remains for custom instructions.

### Composio Graceful 503

- `POST /connections` still returns `422 api_key_only: ...` for apps known to require API-key setup.
- Generic Composio upstream failures now return `503` with an operator-facing integration-provider message.
- The response no longer includes raw upstream exception text.

### Deploy Mechanism

- `ops/deploy-api.sh` now installs `$WORKEROS_ROOT/apps/api/requirements.txt` into `$WORKEROS_ROOT/apps/api/venv` before restarting `workeros-api`.
- The script runs `pip check` after install.
- `WORKEROS_API_VENV` and `WORKEROS_API_REQUIREMENTS` can override those paths.
- `ops/DEPLOY.md` documents the deployed requirements path and service venv.

## Verification

Commands run from `/tmp/wk-backend2`:

```bash
python3 -m compileall -q apps/api/main.py apps/api/chat_service.py
bash -n ops/deploy-api.sh
python3 -m pytest apps/api/tests/test_workspace_agent_endpoint.py apps/api/tests/test_versioning.py::TestWorkspaceInstructionsVersioningIntegration tests/test_connections_backend.py::TestConnectionCallbackAndComposio503 tests/test_deploy_api_script.py -q
python3 -m pytest tests/test_connections_backend.py apps/api/tests/test_workspace_instructions_envelope.py apps/api/tests/test_workspace_agent_endpoint.py apps/api/tests/test_versioning.py::TestWorkspaceInstructionsVersioningIntegration tests/test_deploy_api_script.py -q
python3 -m compileall -q apps/api/main.py apps/api/chat_service.py tests/test_connections_backend.py apps/api/tests/test_workspace_agent_endpoint.py apps/api/tests/test_versioning.py tests/test_deploy_api_script.py
git diff --check
```

Results:

- Targeted suite: `14 passed in 13.65s`
- Broader adjacent backend suite: `53 passed in 46.45s`
- `compileall`, `bash -n`, and `git diff --check` passed.

## Secret Hygiene

- No production secret values were read or written.
- No deploy was run.
- The only secret-like strings in changed files are dummy test values or variable names in the deploy script.
