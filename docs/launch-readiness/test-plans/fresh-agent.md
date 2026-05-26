# Test Plan — Fresh AI agent persona

A new Claude Code / Cursor / Continue user installs the MCP and uses workeros for the first time. Has the secret. Hasn't seen the codebase.

## A1 — install command UX
1. Run `npx @floomhq/workeros install` in a fresh shell.
2. Expected: prompt for `WORKEROS_API_SECRET` → detect agent client config → patch the right file → idempotent on re-run.
3. Fail mode: hangs without TTY, duplicate config entry on re-run, wrong file patched, secret echoed to stdout/logs.

## A2 — tool discovery
1. In the agent: ask "what workeros tools do you have?"
2. Expected: agent lists `workers.{list,get,create,update,delete,run}` + `runs.{list,get,watch}`.
3. Fail mode: tool names wrong, schemas malformed, MCP server fails to start.

## A3 — create a worker via MCP
1. Agent crafts a minimal WorkerContract YAML for "say hello".
2. `workers.create` with worker_yml + (optional) run_py.
3. Expected: worker appears in `workers.list`, bundle dir created, can be run via `workers.run`.
4. Fail mode: schema validation rejects, bundle dir conflict, capability auto-fill misses.

## A4 — run + watch
1. `workers.run` returns run_id.
2. `runs.watch` SSE stream until terminal.
3. Expected: events delivered (status, log, artifact), stream closes on completed.
4. Fail mode: stream hangs, terminal event missing, queue leak.

## A5 — update worker
1. `workers.update` to switch trigger to cron with `expr=*/15 * * * *`.
2. Verify cron registered.
3. Fail mode: PATCH returns 400 on valid body, cron not picked up.

## A6 — delete worker
1. `workers.delete`.
2. Verify gone from list, bundle dir released if no other instance.
3. Fail mode: 404, runs orphaned, bundle dir leaked.

## A7 — error paths
- `workers.run` with invalid input shape → graceful tool_result error, not a runtime crash.
- `workers.run` on non-existent worker → 404 surfaced as tool_result.
- `workers.run` while worker disabled → clear error message.

## A8 — secret handling
- Agent never sees the secret value in tool responses or logs.
- If `WORKEROS_API_SECRET` is missing in env, MCP server fails fast with clear message.
