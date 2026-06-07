# Chat-Driven Worker Creation

Date: 2026-06-07
Status: recommendation and build plan only
Scope: FL24, post-launch design for moving worker creation into Emily chat

## Recommendation

Move worker creation into the full-page Emily workspace (`/chat`) as a three-pane creation workspace: left conversation, middle editable worker bundle, right Emily/run status. Keep `worker-author` as the only generation engine. Do not create a second generator, and do not keep `/workers/new` as a separate primary product surface.

The current system already has the correct backend spine:

- `apps/api/main.py` exposes `POST /workers/new/from-prompt`, which starts a `worker-author` run and returns `run_id`.
- `apps/api/chat_service.py` exposes `workers__create_from_prompt`, which starts the same `worker-author` flow from Emily with chat-scoped idempotency.
- `apps/api/run_service.py` registers the completed `worker-author` bundle into a real worker, smoke-gates it, stores `created_worker_id` in run output, and emits it over SSE.
- `apps/web/app/workers/new/page.tsx` already proves the async run-to-worker routing pattern.
- `apps/web/lib/prompt-detect.ts` is already the shared prompt detector used by `/workers/new` and Emily's prompt input.
- `apps/web/lib/useChatStream.ts`, `apps/web/lib/emily-chat-types.ts`, and `apps/web/components/emily/cards/WorkerCreateCard.tsx` already define most of the chat event/card vocabulary needed for a creation card.

The main design change is product shape, not engine shape: Emily becomes the creator, editor coordinator, and status explainer; the middle pane becomes the concrete worker bundle users can edit, test, and run.

## Target Layout

Use a full-page `/chat` creation layout when Emily detects or the user selects a create-worker task.

```text
+------------------------------+--------------------------------------------+------------------------------+
| Emily conversation            | Worker draft                               | Status / run details          |
|------------------------------|--------------------------------------------|------------------------------|
| User: create a worker...      | worker.yml                                 | Emily                         |
| Emily: I am drafting it.      | SKILL.md or run.py                         | Drafting manifest             |
| Worker-create card            | requirements.txt                           | Registering worker            |
| Follow-up edits               | sample input                               | Smoke test                    |
|                              |                                            | I'm done. Want changes?       |
+------------------------------+--------------------------------------------+------------------------------+
```

Pane behavior:

- Left: Emily conversation history, tool cards, and follow-up edit prompts.
- Middle: editable draft bundle with tabs for `worker.yml`, `SKILL.md` or `run.py`, `requirements.txt`, and sample input. This pane is the same review moment `/workers/<id>?edit=1` gives today, but embedded beside the chat.
- Right: creation status from the `worker-author` run: queued, drafting, registering, smoke, ready, failed. When ready, actions are `Run test`, `Save changes`, `Open worker`, and `Publish/enable` if gating remains separate.

The right pane is where Emily says the operational sentence: "I'm done. Want changes?" The middle pane is where the user edits the thing Emily made.

## Flow

1. User writes a prompt in Emily chat.
2. Emily calls `workers__create_from_prompt` with a stable `idempotency_key`.
3. Backend creates a `worker-author` run and immediately returns `run_id`.
4. Chat renders a `worker-create` card and subscribes to the run streams in `streams.events` and `streams.parts`.
5. When `worker-author` completes, backend registers the bundle and emits `created_worker_id`, `smoke_status`, and `smoke_reason`.
6. Middle pane loads the new worker bundle for editing.
7. User can ask for changes conversationally or edit directly.
8. Test/run uses the normal `workers.run` path against the current saved draft.

This preserves the current no-dead-end rule: completion lands on a real worker, not a bundle-only run page.

## Reuse Existing Systems

### Worker-author run path

Use `workers__create_from_prompt` as Emily's creation tool. It already:

- validates prompt length and mode,
- enforces chat-scoped idempotency through `chat_tool_idempotency`,
- auto-registers `worker-author` if needed,
- creates a real run through `create_run`,
- starts the run through `start_run`.

Use `POST /workers/new/from-prompt` only as an API compatibility path during migration. The chat product path goes through the chat tool so the creation request is persisted as part of the conversation.

### Prompt detector

Keep `apps/web/lib/prompt-detect.ts` as the one client detector. It already renders chips under Emily's prompt input through `PromptChips`.

The backend still owns authoritative connection detection for generated worker requirements through `_detect_connections` and the worker-author prompt/context. The client chips are a preview, not authority.

### Run events and cards

Use `WorkerCreateCard` as the primary chat card for `workers__create_from_prompt`. Today `useChatStream` creates generic cards from tool calls even though `emily-chat-types.ts` already defines `worker-create`. The implementation phase needs to map this specific tool into `WorkerCreateCard` and update it from `tool-progress`, `tool-resource`, and run SSE.

The card must show:

- drafted worker title or prompt summary,
- `run_id`,
- `created_worker_id` when available,
- `smoke_status` and redacted `smoke_reason`,
- links/actions for run detail, worker editor, and test run.

## Conversational Edit Loop

Treat each follow-up edit as a new draft generation over the current bundle, not as ad hoc string editing by Emily.

Recommended contract:

- User says: "make it weekly instead of daily" or edits the middle pane directly.
- UI creates a draft revision record tied to `conversation_id`, `run_id`, and `worker_id`.
- Emily sends the original prompt, conversation delta, and current bundle files to `worker-author`.
- `worker-author` regenerates `worker.yml` plus `SKILL.md` or `run.py`.
- Backend validates, registers a new worker version or updates the current draft files.
- Middle pane refreshes to the regenerated files with a visible diff/changed-file state.

Keep one source of truth per moment:

- before registration: `worker-author` run artifact bundle,
- after registration: worker files and worker versions,
- during direct edits: unsaved draft buffer in the web app, persisted before test/run.

Direct code edits remain allowed. Running or testing always persists the middle-pane draft first, then uses the normal worker run path.

## State And Persistence

Tie creation state to the existing Emily persistence primitives:

- `conversations` stores the thread.
- `conversation_messages` stores user/assistant/tool text.
- `conversation_tool_calls` stores renderable tool cards for replay.
- `chat_tool_idempotency` prevents duplicate worker-author runs for the same chat action.
- `localStorage` keeps the active `conversation_id` across dock/full-page reloads.

Add only the missing durable creation metadata:

- `conversation_tool_calls.resource` or equivalent metadata must store `run_id`, `worker_id`, `created_worker_id`, `smoke_status`, and actions.
- Replay of a completed creation conversation must show the ready worker card and reopen the middle pane from `created_worker_id`.
- If the user reloads while generation is running, the card reconnects through `/runs/{run_id}/events` and falls back to `GET /runs/{run_id}` for terminal output.

This avoids a separate "new worker wizard session" store.

## `/workers/new`

Deprecate it in phases.

1. Phase 1: keep `/workers/new` working as a compatibility shell.
2. Phase 2: route entry points such as landing prompt, command palette, and "New worker" buttons to `/chat?intent=create-worker`.
3. Phase 3: turn `/workers/new` into a redirect that preserves `?prompt=` and opens Emily in creation mode.
4. Phase 4: remove the custom page only after telemetry and support links show no active dependency.

The upload/import affordances currently on `/workers/new` need a home before redirecting hard. Put them in the middle pane as `Import bundle`, `Upload SKILL.md`, and `Upload run.py` actions.

## Phased Build Plan

### Phase 0: Protocol cleanup

- Map `workers__create_from_prompt` to `worker-create` card metadata in `chat_service.py`.
- Teach `useChatStream` to render `WorkerCreateCard` instead of a generic card for that tool.
- Persist `created_worker_id`, smoke verdict, streams, and actions in `conversation_tool_calls`.
- Add replay tests for in-flight and completed worker-author cards.

### Phase 1: Full-page creation workspace

- Add a `/chat` creation mode with three panes.
- Reuse `EmilyChatCore` for the left pane.
- Add a worker draft pane that can load by `created_worker_id` or pending `run_id`.
- Add a right status pane driven by the same run events used by `/workers/new`.

### Phase 2: Editable draft and test loop

- Load editable worker files into the middle pane.
- Save direct edits through existing worker update/version APIs.
- Add `Run test` that saves first, then calls `workers.run`.
- Surface test output and approval/missing-connection states in the right pane.

### Phase 3: Conversational revisions

- Add a `worker-author` edit mode that accepts current bundle files plus the chat edit request.
- Store each regeneration as a worker version.
- Show changed files after each Emily edit.
- Keep a "restore previous version" action wired to existing version history.

### Phase 4: Entry-point migration

- Move "New worker" buttons and prompt CTAs to `/chat?intent=create-worker`.
- Preserve `?prompt=` and auto-send only when explicitly coming from a CTA.
- Keep `/workers/new` as a compatibility wrapper during this phase.

### Phase 5: Deprecate `/workers/new`

- Redirect `/workers/new?prompt=...` to `/chat?intent=create-worker&prompt=...`.
- Keep file upload/import available in the creation workspace.
- Remove the old page after the redirect has been verified in production.

## Verification Plan For Implementation

- Unit: prompt detector remains shared between Emily and worker creation prompts.
- Unit: `useChatStream` reduces create-worker tool events into `WorkerCreateCard`.
- Backend: `workers__create_from_prompt` returns one idempotent run per key.
- Backend: completed worker-author run persists `created_worker_id` and smoke metadata.
- Replay: rehydrated conversation shows the completed worker card and opens the draft pane.
- Browser: create worker from Emily, reload mid-generation, confirm reconnect, edit, test run, and open worker.
- Regression: `/workers/new?prompt=` redirects or compatibility shell still creates a worker.

## Open Product Decisions

- Whether direct middle-pane edits autosave or require an explicit Save before test/run.
- Whether a smoke-failed generated worker is shown as editable disabled, or held as an unsaved draft until fixed.
- Whether import/upload belongs in the creation workspace toolbar or a command palette action.

## Bottom Line

Build this as a chat-first orchestration layer over the proven `worker-author` path. The user asks Emily for a worker, watches Emily work in the right pane, edits the actual bundle in the middle pane, and continues revision in the left conversation. `/workers/new` becomes a compatibility route, then a redirect.
