# Test Plan — the operator (owner persona)

the operator installs workeros and uses it for his own work. Single-tenant. Knows the secret. Has Mac + Claude Code installed.

## Dogfooding flows (must work end-to-end)

### F1 — install via MCP and run a tool from Claude Code
1. `npx @floomhq/workeros install` on Mac, paste secret → restart Claude Code session.
2. In Claude Code: ask "list my workeros workers."
3. Expected: agent calls `workers.list` MCP tool, returns 12 workers.
4. Fail mode: tool not found, 401, empty list, syntax error in config.

### F2 — run research_brief via MCP
1. In Claude Code: "run research_brief on 'AI agents 2026' for executive audience"
2. Agent calls `workers.run` with worker_id=research_brief, inputs.
3. Watch run via `runs.watch` (SSE).
4. Expected: terminal state=completed, brief artifact written, transcript artifact written.
5. **Already proven**: this was just verified end-to-end (run_8c144e2b2907, completed in 25s).

### F3 — set up a real cron worker
1. Frontend: workers.floom.dev/workers/research_brief/edit → switch trigger=cron, expression=`0 9 * * *` (daily 9am).
2. PATCH /workers/research_brief lands.
3. Verify: scheduler picks up next_run_at, fires at 9am UTC next day.

### F4 — Composio-trigger a worker on a real Gmail event
1. Connect Gmail via /connections/browse.
2. Create a worker with `trigger.composio: { event: GMAIL_NEW_EMAIL, connection_id, filters }`.
3. Send an email to the operator's Gmail.
4. Expected: workeros receives Composio webhook → creates run → worker executes.
5. Fail mode: trigger not registered with Composio, signing-key mismatch, payload mapping wrong.

### F5 — upload a file and run a worker on it
1. POST /uploads with a small CSV.
2. Get sha256.
3. POST /workers/csv_enricher/runs with `{inputs: {file_sha: <sha>}}`.
4. Verify: run mounts file into `<artifacts>/<run_id>/inputs/`, worker reads it, output written.
5. Fail mode: stale file from previous run, bind-time revalidation rejects, sandbox can't read.

### F6 — webhook trigger
1. Generate webhook secret for webhook_test worker.
2. POST /webhooks/webhook_test with HMAC-signed body.
3. Verify: run created, output captured.
4. Fail mode: signature rejected, body parsing fails.

## Surface-coverage checks

| Surface | Coverage |
|---|---|
| MCP install + tool list | F1 |
| MCP run + watch | F2 |
| Cron trigger | F3 |
| Composio trigger | F4 |
| File inputs | F5 |
| Webhook trigger | F6 |
| OAuth flow (Composio) | F4 prerequisite |
| Auth gate (x-floom-secret) | implicit on every call |
| Frontend routes | manual visual check at workers.floom.dev |
| CLI | `floom run research_brief --inputs '{...}'` from Mac |
