# Workeros MCP

Workeros lets agents create, update, run, watch, and delete production worker automations through a local stdio MCP server backed by the Workeros API. The package installs into Claude Code, Cursor, or Continue and exposes worker lifecycle and run observability tools without requiring custom agent-side code.

## Install

```bash
npx @floomhq/workeros install
```

The installer uses `WORKEROS_API_SECRET` from the environment when present, otherwise it prompts for it. It patches the first existing config file it finds in this order: `~/.claude/settings.json`, `~/.cursor/mcp.json`, `~/.continue/.continuerc.json`. Re-running the installer updates the existing `workeros` entry instead of duplicating it.

## Manual Config

Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "workeros": {
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>"
      }
    }
  }
}
```

Continue (`~/.continue/.continuerc.json`):

```json
{
  "mcpServers": [
    {
      "name": "workeros",
      "command": "npx",
      "args": ["-y", "@floomhq/workeros"],
      "env": {
        "WORKEROS_API_SECRET": "<WORKEROS_API_SECRET>"
      }
    }
  ]
}
```

The server targets `https://workers-api.floom.dev` by default. For development, set `WORKEROS_API_BASE`.

## Tools

> **For full worked examples per tool, end-to-end recipes (deploy a worker from prompt, port a Claude skill, schedule + webhook + composio triggers), and the agent draft contract, see [docs/AGENT-COOKBOOK.md](../../docs/AGENT-COOKBOOK.md).**

| Tool | Description |
| --- | --- |
| `workers.list` | List available Workeros workers. |
| `workers.get` | Read one worker, including config and recent run metadata. |
| `workers.create` | Create a worker from `worker_yml` and either `run_py` (script mode) or `skill_md` (agent mode). |
| `workers.update` | Patch trigger, cron, default inputs, documented capabilities, or rotate a webhook secret. |
| `workers.delete` | Delete a worker and dependent run data. |
| `workers.run` | Start a manual worker run with input values. |
| `runs.list` | List runs, optionally filtered by worker id or status. |
| `runs.get` | Read one run with logs, outputs, artifacts, and approval state. |
| `runs.watch` | Stream SSE run events (text / tool-call / tool-result / reasoning / step-start / finish) until a terminal state. |
| `secrets.list` / `secrets.set` / `secrets.delete` | Manage env-var secrets the worker can read. |
| `connections.list` | List configured Composio app connections. |
| `triggers.list` | List configured Composio triggers, globally or per worker/app. |

## Quick example — write + deploy + verify a worker in one MCP session

```js
// 1. Create
await workers.create({
  name: "text-summarizer",
  worker_yml: `
schema_version: "0.3"
name: text-summarizer
title: Text Summarizer
description: Summarizes any text in 3 bullets using GPT-4.1.
entrypoint: run.py
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - { name: text, kind: scalar, type: textarea, required: true, label: Text }
  outputs:
    - { name: summary, kind: file, media_type: text/markdown, path: out/summary.md, required: true, label: Summary }
  secrets: [OPENAI_API_KEY]
capabilities:
  secrets: [OPENAI_API_KEY]
  network: { egress: true }
trigger: { type: manual }
`,
  run_py: `
def run(inputs, context):
    client = context.openai()
    r = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "system", "content": "Summarize in 3 bullets."},
            {"role": "user", "content": inputs["text"]},
        ],
    )
    summary = r.choices[0].message.content
    context.write_output("summary", summary)
    return {"summary": summary}
`,
});

// 2. Run
const { run_id } = await workers.run({
  worker_id: "text-summarizer",
  inputs: { text: "Lorem ipsum dolor sit amet..." },
});

// 3. Watch until terminal
for await (const part of runs.watch({ run_id })) {
  if (part.type === "tool-call") console.log("tool:", part.name);
  if (part.type === "finish") break;
}

// 4. Verify
const { run } = await runs.get({ id: run_id });
console.log(run.status); // "succeeded"
console.log(run.outputs.summary);
```

See [docs/AGENT-COOKBOOK.md §1](../../docs/AGENT-COOKBOOK.md) for the full annotated walkthrough plus six more recipes (agent mode, Gmail trigger, cron schedule, webhook, approval gate, claude-skill port).
