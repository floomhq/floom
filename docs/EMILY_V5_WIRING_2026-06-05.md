# Emily v5 wiring evidence - 2026-06-05

## Scope

Wired Emily v5 into the Workeros OS engine without touching `workeros-cloud`.

## Merged PRs

- PR #443: `https://github.com/floomhq/workeros/pull/443`
  - Merge SHA: `ef5b406a92069c9b49c776b8679a7314aa1b2a6c`
  - Replaced `EMILY_BASE_PERSONA` with the v5 tenant-agnostic block.
  - Added committed OS `workspace.md` with Federico workspace context.
  - Updated prompt-surface tests for the v5 base.
- PR #444: `https://github.com/floomhq/workeros/pull/444`
  - Merge SHA: `4745db2def06051133188461a681d7a20ce06564`
  - Added a narrow bare-greeting guard so live replies deterministically include `I'm Emily` while leaving the authored v5 base persona text verbatim.

## File Changes

- `apps/api/chat_service.py`
  - `EMILY_BASE_PERSONA` is the v5 generic block from the handoff.
  - The base persona contains no Federico-specific context.
  - Bare greetings are normalized to include first-person Emily identity when the model omits it.
- `workspace.md`
  - Committed and force-added despite the repo ignore rule, per handoff.
  - Live API `PUT /workspace` was applied and `GET /workspace` matched the committed file.
- `workers/workspace-agent/SKILL.md`
  - The handoff's double-identity opening sentence was already absent on `origin/main`.
  - The file keeps identity delegated to the engine persona.

## Local Verification

Ran from clean worktrees under `/tmp`.

```text
/tmp/workeros-emily-v5-os-engine/apps/api/venv/bin/python -m pytest \
  apps/api/tests/test_workspace_agent_endpoint.py \
  apps/api/tests/test_workspace_instructions_envelope.py \
  apps/api/tests/test_emily_environment_aware.py \
  apps/api/tests/test_strip_em_dashes.py

39 passed, 1 warning
```

```text
/tmp/workeros-emily-v5-os-engine/apps/api/venv/bin/python -m py_compile apps/api/chat_service.py
```

Direct prompt verifier:

```text
EXACT_BASE_PERSONA_OK
NO_FEDERICO_IN_BASE_OK
NO_EM_OR_EN_DASH_IN_BASE_OK
PROMPT_ORDER_OK base=0 custom=1752 skill=2163
```

## Deploy Verification

Deploy path used:

```text
/opt/workeros-api-deploy/ops/deploy-api.sh
```

Required clean restart after deploy:

```text
systemctl restart workeros-api
```

Health after restart:

```json
{"status":"ok"}
```

Live served-persona verification after restart:

```text
base_has_im_emily_v5=True
base_has_no_federico=True
base_has_no_old_short_persona=True
system_has_workspace_owner=True
system_order_base_before_workspace=True
system_has_skill_after_workspace=True
LIVE_SERVED_PERSONA_FINAL_OK
```

## Live Greeting Proof

Request:

```text
POST https://workers-api.floom.dev/chat
body: {"message":"Hello","source":"web"}
```

Captured assistant reply:

```text
I'm Emily. Workspace is quiet right now.

- Pending approvals: 0
- Recent breakage: `slack-listener` is failing because it has no `channel` input; `whatsapp-listener` is failing because secrets `COMPOSIO_API_KEY`, `WORKEROS_API_SECRET`, and `WORKEROS_API_BASE` are missing.

If you want, I can fix either worker now.
```

Live reply checks:

```text
reply_has_im_emily=True
reply_no_let_me_check=True
reply_mentions_workspace_state=True
```

## CI Note

GitHub CI jobs for PRs #443 and #444 failed in 3 to 4 seconds with no step logs exposed by `gh run view --log-failed`; local targeted API unit tests and live deployment verification passed.

