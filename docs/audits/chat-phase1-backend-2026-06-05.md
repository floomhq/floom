# Emily Chat Backend Contract

Date: 2026-06-05
Branch: `feat/emily-chat-backend-contract`

## PR 437 Gap Assessment

PR #437 implemented most of the phase 1 backend surface:

- `chat.meta`
- safe `args_preview` and `result_preview`
- persisted `conversation_tool_calls`
- `workers__create_from_prompt` with idempotency
- conversation replay with `tool_cards`
- richer run event metadata and artifact download URLs

Remaining gaps found against `docs/design/emily-agentic-chat-2026-06-05.md`:

- `chat.meta` did not include `version` or `assistant_message_id`.
- Tool bridge events did not consistently include `version`, `conversation_id`, or `message_id`.
- `tool-progress`, `tool-resource`, and `tool-action-required` lacked `card_id`.
- `finish` did not include a `cards` summary.
- `workers__run` still bypassed the shared `start_run` queue path.
- Approval results did not normalize into an action-required card.
- The branch was behind current `origin/main` and conflicted with newer chat persona code.

## Implemented Contract

`POST /chat` returns `text/event-stream`. The SSE frame uses `data: <json>` lines. The JSON `type` field is the event name. All enriched events carry `version: 2`.

Event order:

1. `chat.meta`
2. zero or more `text` token events
3. for each tool call, `tool-call`
4. immediate `tool-progress`
5. later `tool-result`
6. optional `tool-resource`
7. optional `tool-action-required`
8. `finish`

Long worker creation goes through `workers__create_from_prompt`, which starts a `worker-author` run and returns a run handle immediately. Worker runs use `create_run` plus `start_run`.

## Verification

Passed:

```bash
pytest -q apps/api/tests/test_chat_phase1_backend.py apps/api/tests/test_chat_backend_batch.py
```

Result: 20 passed.

Passed:

```bash
pytest -q apps/api/tests/test_chat_phase1_backend.py apps/api/tests/test_chat_backend_batch.py apps/api/tests/test_emily_create_runnable.py tests/test_s22d_stream.py tests/test_wedge_prompt_to_worker_creates.py tests/test_pr231_correctness.py tests/test_api_endpoints.py::TestRunEventsSSE
```

Result: 82 passed, 42 warnings. Warnings were manifest deprecation warnings from `apps/api/models.py`.

Passed:

```bash
python3 -m compileall -q apps/api
git diff --check
```
