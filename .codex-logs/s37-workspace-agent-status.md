# S37 Workspace Agent — Status

**Branch:** lane/s37-workspace
**Date:** 2026-05-29
**Status:** ✅ COMPLETE

## What shipped

### Step 1 — POST /chat SSE endpoint
- Streams AI SDK parts: text deltas, tool-call, tool-result, finish
- Finish event carries `conversation_id` + `message_id`
- Uses `gpt-4.1-mini` by default (override via `WORKEROS_CHAT_MODEL`)

### Step 2 — workspace-agent worker bundle
- `workers/workspace-agent/worker.yml` (system_worker: true, hidden from /workers)
- `workers/workspace-agent/SKILL.md` — instructions + worker.yml format reference
- Dynamic preamble (worker count, recent runs, contexts) injected via `{{WORKSPACE_PREAMBLE}}`

### Step 3 — workspace.md
- `GET /workspace` — returns markdown content
- `PUT /workspace` — updates it (requires x-floom-secret)
- `workspace.md.template` — seed for new installs (gitignored)

### Step 4 — Conversation persistence (SQLite migration 34)
- `conversations` + `conversation_messages` tables
- `GET /conversations` — list conversations
- `GET /conversations/{id}` — get with messages
- Eviction: summarise after 50 msgs, keep summary + last 20 verbatim
- Tool result truncation at 2KB

### Step 5 — Workspace-management tools
- workers__list_all, workers__get, workers__create, workers__update, workers__run
- runs__list, runs__get, runs__cancel
- secrets__list_names, secrets__set (only workspace-agent has access)
- connections__list, connections__add_mcp
- contexts__list, contexts__read, contexts__write

### Step 6 — MCP export
- `workspace.chat(message, conversation_id?, timeout_ms?)` in `apps/mcp/src/server.ts`
- Consumes /chat SSE, returns `{reply, tool_calls, conversation_id, message_id}`

### Step 7 — Example workers
- `workers/slack-listener/` (is_example: true, cron every 10min)
- `workers/whatsapp-listener/` (is_example: true, cron every 10min)

## Smoke evidence

```
POST /chat "list my workers"
→ tool: workers__list_all
→ "You have 18 workers: 1. CSV Enricher..."
→ finish {conversation_id: "conv_...", message_id: "msg_..."}

POST /chat "what runs failed today?"
→ tool: runs__list
→ "No runs have failed today..."

POST /chat "yes, create that worker now" (with conversation_id)
→ tool: workers__create → worker_id: hn-top5-pinger created in DB

POST /chat "run the first one" (with conversation_id)
→ tool: workers__run → csv_enricher run created
→ anaphor resolved: "CSV Enricher (first listed in prior turn)"
```

## Scope notes
- No Slack/WhatsApp adapter live test (requires SLACK_BOT_TOKEN + active Composio WhatsApp)
- The workers are cron-driven v0 examples per the brief
- MCP TypeScript compiles without errors (npx tsc --noEmit)

## PRs
- https://github.com/floomhq/workeros/pull/new/lane/s37-workspace (pending merge)
