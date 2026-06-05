# Backend pass 3 audit - 2026-06-05

## Summary

**Status:** VERIFIED

**Commit deployed:** `be7ff47a1df176e1e97e06d3a4999da90f6900eb`

**Scope:** M31 persona-global, M32/M33 brain and connection write permissions, M39 WhatsApp per-sender routing, #E2 generated-worker example self-check, and M41 Slack greeting copy.

## Deployment

- Pushed `backend-pass3-20260605` and `main` to `origin` at `be7ff47a1df176e1e97e06d3a4999da90f6900eb`.
- Ran `./ops/deploy-api.sh` exactly once.
- The script backed up the DB and restarted `workeros-api`; `/health` passed after 2s.
- The script then exited on its built-in `/healthz` assertion with `got 000000`; it was not rerun.
- Direct post-deploy checks passed:
  - Public `https://workers-api.floom.dev/health`: HTTP 200, `status: ok`, DB/disk/E2B/OpenAI/Composio all `ok`.
  - `systemctl is-active workeros-api`: `active`.
  - `systemctl show workeros-api`: `WorkingDirectory=/opt/workeros-api-deploy/apps/api`.
  - `/opt/workeros-api-deploy` HEAD and `origin/main`: `be7ff47a1df176e1e97e06d3a4999da90f6900eb`.
  - Deployed tracked source paths matched `origin/main`: `git diff --name-only origin/main -- apps/api apps/mcp workers docs` returned 0 files.

## Local Verification

- `python3 -m py_compile apps/api/chat_service.py apps/api/main.py apps/api/run_service.py apps/api/db/_legacy_sqlite.py`: passed.
- `git diff --check`: passed.
- `python3 -m pytest apps/api/tests -q`: `561 passed, 185 warnings` before rebase and again after rebase.
- `npm run build` in `apps/web`: passed.
- `npm run lint` in `apps/web`: passed with 0 errors and 21 existing warnings.

## Codex Review

Codex review was run against the high-risk persona-global and multi-tenant/codegen changes. Findings and fixes:

- P1: WhatsApp claim link was generated but not wired in the settings UI. Fixed with `api.whatsapp.claim()` and the `whatsapp_claim` query handler.
- P2: synthesized number smoke inputs used string `"1"`. Fixed to numeric `1`.
- P2: Emily direct worker smoke did not pass `worker_yml`, so `example_output` was not enforced. Fixed by passing the manifest into the smoke bundle.
- P2: settings claim URL rewrite hardcoded `/settings`, breaking non-root base paths. Fixed to preserve `window.location.pathname`.
- P2: `example_output` was compared against fallback smoke inputs when only `worker_yml` was present. Fixed `_build_smoke_inputs()` to read manifest `example_input`; added regression coverage.

## Item Evidence

### M31 - persona-global

**Status:** VERIFIED

Implementation:

- Moved the immutable Emily identity into `EMILY_BASE_PERSONA` in `apps/api/chat_service.py`.
- `workspace.md.template` is custom instructions only.
- `_build_system_prompt()` layers engine Emily persona, editable workspace instructions, and worker `SKILL.md` content.

Production evidence:

- Saved original `/workspace`, wrote a custom-only body containing `PASS3_CUSTOM_TOKEN`, then fetched `/system/workspace-agent`.
- Resolved prompt still began with `# Emily` and included `You are Emily, a personal Chief-of-Staff for Workeros`.
- Resolved prompt included `PASS3_CUSTOM_TOKEN`.
- `/chat` streamed a completed response with `p3test-pass3-chat-ok`.
- Original `/workspace` content was restored.

### M32/M33 - brain/connections write and granular permissions

**Status:** VERIFIED

Implementation:

- Added `workspace_agent_settings` DB table and `PUT /system/workspace-agent/settings`.
- Added default safe flags: `brain_read=true`, `brain_write=false`, `connections_read=true`, `connections_use=false`, `connections_add=false`.
- Added gated `brain__write` / `contexts__write` tools with user-scoped context writes and secret scanning.
- Gated `connections__list`, `connections__add_mcp`, and Composio scopes from the same settings object.

Production evidence:

- Safe read-only settings exposed `brain__list`, `brain__read`, `contexts__list`, `contexts__read`, and `connections__list`.
- Safe read-only settings hid `brain__write`, `contexts__write`, and `connections__add_mcp`.
- Write/add settings exposed `brain__write`, `contexts__write`, and `connections__add_mcp`.
- Write/add settings hid `brain__list`, `contexts__read`, and `connections__list`.
- The resolved prompt did not expose raw global context root paths.
- Original settings were restored.

### M39 - WhatsApp per-sender routing

**Status:** VERIFIED

Implementation:

- Added `whatsapp_sender_bindings` DB table.
- Inbound WhatsApp routing now uses `wa_id -> user_id` active bindings.
- Unbound senders receive a claim link and are not routed into any workspace context.
- Added `POST /whatsapp/bindings/claim` and settings-page claim handling.

Production evidence:

- Ran deployed production code against the production DB with outbound WhatsApp sends monkeypatched.
- Unbound sender `55500031000` created a pending claim row, sent a `whatsapp_claim=` link, and produced zero assistant routes.
- Bound sender `55500031001` routed to `p3test-user-a` with `conversation_id=whatsapp:55500031001`.
- Bound sender `55500031002` routed to `p3test-user-b` with `conversation_id=whatsapp:55500031002`.
- Deleted all `p3test-*` WhatsApp rows; final DB count was 0.

### #E2 - codegen logical self-check

**Status:** VERIFIED

Implementation:

- Smoke gate now reads manifest `example_input` and compares actual outputs to manifest `example_output` when present.
- Example mismatch returns `output_validation_failed`, participates in bounded repair for generated code, and disables user-supplied incorrect workers without rewriting them.
- Both `/workers/draft-and-create` and Emily direct worker create/update pass `worker_yml` into the shared smoke gate.

Production evidence:

- Created `p3test-median-wrong` with `[3,1,2,5,4] -> {"median": 3}` but code returned `0.0`; smoke returned `failed`.
- Created `p3test-sum-wrong` with expected `15` but code returned `sum(numbers)-1`; smoke returned `failed`.
- Created `p3test-median-ok` with correct median logic; smoke returned `passed`.
- Deleted all three workers; follow-up GETs returned 404.

### M41 - Slack greeting copy

**Status:** VERIFIED

Implementation:

- Updated `_handle_slack_assistant_thread_started()` greeting.
- Updated `docs/slack-app-manifest.example.yml` `assistant_description`.

Production evidence:

- Ran deployed production Slack handler with `_post_slack_thread_reply` monkeypatched.
- Captured exact text: `I'm Emily, your personal Chief-of-Staff. I route tasks to a swarm of always-on agents and workers. DM me or @mention me.`

## Cleanup

- Restored original `/workspace`.
- Restored original workspace-agent settings.
- Deleted `p3test-median-wrong`, `p3test-sum-wrong`, and `p3test-median-ok`; follow-up GETs returned 404.
- Deleted production DB rows for WhatsApp senders `55500031000`, `55500031001`, and `55500031002`; final count was 0.
