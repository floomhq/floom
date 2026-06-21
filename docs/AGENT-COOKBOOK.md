# Agent Cookbook - Building & Deploying Workers

For agents (Claude Code / Cursor / custom) installing the `@floomhq/floom` MCP and producing real workers from prompts. This is the **read-this-first** recipe book.

If you only have time for one doc, read this. If you want the full schema reference, see [AUTHORING.md](AUTHORING.md).

---

## 0. Fresh-agent path

Use this path when you have a blank shell, a Floom secret, and a prompt to
create or edit a worker.

### 0.1 Install + verify MCP

The npm package exposes three binaries:

- `floom` - preferred CLI name in these docs.
- `workeros` - compatibility alias for older installs.
- `floom-mcp` - stdio MCP fallback binary for clients that cannot use HTTP MCP.
- `workeros-mcp` - compatibility alias for older MCP client configs.

If an older guide mentions `workeros`, use `floom` for new installs.

```bash
npx -y @floomhq/floom mcp install --target claude
# OR
npx -y @floomhq/floom mcp install --target cursor
```

Set `WORKEROS_API_BASE` to your API URL before install; for local development
that is usually `http://localhost:8000`. Set `WORKEROS_API_SECRET` to skip the
secret prompt when your API is protected by `FLOOM_SECRET`. For older harnesses
that need a local stdio process, configure `npx -y -p @floomhq/floom floom-mcp`.
Verify:

```bash
# Inside the agent, call the MCP tool:
workers.list
# Expect: array of {id, name, status, ...}. If it returns an error, the secret is wrong.
```

For CLI use outside an MCP client:

```bash
npm i -g @floomhq/floom@latest
floom login
floom doctor
floom workers list
```

Hosted workspaces use the hosted login flow:

```bash
floom login --cloud
floom workspace list
floom workspace switch <workspace-name-or-id>
```

Workspace switching also works for self-hosted local workspaces. `floom mcp list` /
`floom mcp switch <label>` switch the active MCP server the same way, and
`floom mcp test [label]` live-probes a server (defaults to the active one).
`workspaces` and `use` remain as aliases.

Credentials live in `~/.config/floom/credentials.json`. Existing `~/.config/workeros/credentials.json` files are still read for compatibility.

### 0.2 Create, edit, deploy, and run from a local bundle

For a local worker directory, the deploy command is `floom workers push`.
It creates the worker when the id is new and updates it when the id already
exists on an API that supports in-place source updates.

```bash
mkdir -p workers/text-summarizer
# write workers/text-summarizer/worker.yml
# write workers/text-summarizer/run.py OR workers/text-summarizer/SKILL.md

floom workers validate workers/text-summarizer
floom workers push workers/text-summarizer
floom run text-summarizer --input text="Long text here..."
floom runs show <run_id> --json
```

`workers validate` checks the local bundle shape before any network write. It
also catches Composio-in-E2B mistakes such as shelling out to `composio execute`
instead of using the Floom proxy.

When `workers push` reports that the API does not support in-place source
updates, the local source is valid but the target API cannot overwrite that
worker id. Use a new worker id on that deployment or upgrade the API.

### 0.3 Create and run through MCP

The current MCP source-creation tool accepts `worker_yml` plus `run_py`:

```
workers.create({ worker_yml: "<yaml>", run_py: "<python source>" })
workers.run({ id: "text-summarizer", inputs: { text: "Long text here..." } })
runs.watch({ id: "<run_id>" })
```

Use CLI `floom workers push <dir>` for `SKILL.md` agent-mode bundles. The
MCP `workers.update` tool edits instance settings such as trigger, cron, saved
input defaults, capabilities, and webhook secret rotation; it does not replace
`run.py`, `SKILL.md`, or `worker.yml` source.

### 0.4 Raw source vs rendered surfaces

- `worker.yml`, `run.py`, `SKILL.md`, and `requirements.txt` are raw bundle
  source. Edit these files locally, validate, then push.
- Overview cards render manifest fields such as `long_description`,
  `use_cases`, `example_output`, and `how_it_works`.
- Run outputs render according to `exec.outputs[].media_type`; markdown renders
  inline, JSON is pretty-printed, and other media types are downloadable.
- Select input labels are humanized in the UI, but the raw enum value is what
  appears in `inputs.json`.

---

## 1. Recipe: "Write me a Markdown summarizer"

The shortest possible worker. Plain Python, OpenAI summarization, one input, one output.

### 1.1 Author the bundle

```python
# run.py
import json
import os
from pathlib import Path

from openai import OpenAI

inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
text = inputs["text"]

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
response = client.chat.completions.create(
    model="gpt-5-mini",
    messages=[
        {"role": "system", "content": "Summarize the user's text in 3 bullets."},
        {"role": "user", "content": text},
    ],
)
summary = response.choices[0].message.content or ""

Path("out").mkdir(exist_ok=True)
Path("out/summary.md").write_text(summary, encoding="utf-8")
Path("result.json").write_text(
    json.dumps({
        "status": "success",
        "outputs": {"summary": "out/summary.md"},
        "artifacts": [],
        "error": None,
    }),
    encoding="utf-8",
)
```

```yaml
# worker.yml
schema_version: "0.3"
name: text-summarizer
title: Text Summarizer
description: Summarizes any text in 3 bullets using GPT-4.1.
long_description: |
  Takes a block of text and returns a concise 3-bullet summary. Useful for
  long emails, meeting notes, article previews.
use_cases:
  - Compress an email thread before sharing internally.
  - Pre-read a long article into bullets.
example_input:
  text: "Lorem ipsum..."
example_output: |
  - First key point.
  - Second key point.
  - Third key point.
how_it_works: |
  Text -> OpenAI gpt-5-mini chat completion -> 3-bullet summary.
folder: Productivity
tags: [summarize, text, openai]
version: 0.1.0
entrypoint: run.py
targets: [generic]
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs:
    - name: text
      kind: scalar
      type: textarea
      required: true
      label: Text to summarize
      placeholder: Paste your text here
  outputs:
    - name: summary
      kind: file
      media_type: text/markdown
      path: out/summary.md
      required: true
      label: Summary
  secrets:
    - OPENAI_API_KEY
capabilities:
  secrets: [OPENAI_API_KEY]
  network:
    egress: true
trigger:
  type: manual
```

```
openai==1.51.0
```

### 1.2 Deploy via MCP

```
workers.create({
  worker_yml: "<paste the YAML above>",
  run_py: "<paste the Python above>",
})
```

### 1.3 Smoke-test

```
workers.run({ id: "text-summarizer", inputs: { text: "Long text here..." } })
runs.watch({ id: "<returned-id>" })
```

Watch streams parts until `finish`. Look for `tool-result` with the OpenAI completion and the final `summary` output.

### 1.4 Verify the deployed worker

```
workers.get({ id: "text-summarizer" })
# Expect: status=ready, last run with status=succeeded
```

Open `http://localhost:3000/workers/text-summarizer` in browser to confirm the Overview tab renders.

---

## 2. Recipe: "Run an agent-mode skill (SKILL.md)"

When the task needs reasoning, web search, or multi-step tool calls, use agent mode. Same `worker.yml` shape, but `entrypoint: SKILL.md` and no `run.py`.

```markdown
# SKILL.md - Research Brief

You receive:
  - topic (string): the subject to research.
  - audience (string): "executive" or "technical".
  - depth (string): "summary" or "detailed".

Your task:
1. Build an outline appropriate for the audience.
2. Synthesize 3-5 key points from prior knowledge.
3. Adapt the writing tone to the audience.
4. Write a structured markdown brief.

Constraints:
- Markdown only. No HTML.
- Use H2 for section headings, never H1.
- Qualify cutoff-sensitive claims explicitly.

When done, call write_output("brief", "<markdown content>").
```

```yaml
# worker.yml (delta from script mode)
entrypoint: SKILL.md
limits:
  max_tool_iterations: 12
  max_output_tokens: 4096
  max_total_tokens: 50000
  timeout_seconds: 300
exec:
  runtime: python311
  runner: e2b
  inputs:
    - name: topic
      kind: scalar
      type: string
      required: true
      label: Topic
    - name: audience
      kind: scalar
      type: select
      enum: [executive, technical]
      default: executive
      label: Audience
    - name: depth
      kind: scalar
      type: select
      enum: [summary, detailed]
      default: detailed
      label: Depth
  outputs:
    - name: brief
      kind: file
      media_type: text/markdown
      path: out/brief.md
      required: true
      label: Research Brief
  secrets:
    - OPENAI_API_KEY
```

Live reference: [workers/research_brief/](../workers/research_brief/).

---

## 3. Recipe: "Worker triggered by Gmail"

App-event trigger (Composio). Fires when a Gmail label arrives. Required: the user has already connected Gmail under /connections.

```yaml
trigger:
  type: composio
  composio:
    event: "gmail.new_message"
    connection_id: "ca_<gmail-connection-id>"
    filters:
      labels: ["INBOX/Briefs"]
```

In agent mode, the SKILL.md will receive the Gmail message payload in `inputs["event"]`. In script mode:

```python
import json
from pathlib import Path

inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
connections = json.loads(Path("connections.json").read_text(encoding="utf-8"))

msg = inputs["event"]  # full Gmail message payload
gmail_connection_id = connections["gmail"]
# Use the Floom API or Composio SDK with this connection id.
...
```

Live reference: [workers/gmail_intake_brief/](../workers/gmail_intake_brief/).

---

## 4. Recipe: "Worker on a cron schedule"

```yaml
trigger:
  type: schedule
  cron: "0 9 * * MON"
  timezone: "Europe/Berlin"
```

The scheduler service picks up the worker on the cron tick and starts a run
with the worker's saved default inputs.

Live reference: [workers/github-digest/](../workers/github-digest/) (cron + Composio GitHub connection).

---

## 5. Recipe: "Worker triggered by HTTP webhook"

```yaml
trigger:
  type: webhook
  webhook:
    secret: true
    allowed_methods: [POST]
```

After deploy, `workers.get({ id })` returns `webhook_url`. POSTing to that URL with `?token=<derived>` fires a run; the request body is `inputs["event"]`.

```bash
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"key": "value"}}'
```

---

## 6. Recipe: "Approval-gated worker"

For workers that send external messages, delete data, or spend money. The run pauses; the user approves in /approvals or by ID.

```yaml
approvals:
  required: true
  label: Review and approve before sending to client
```

In script mode, use the two-run approval protocol: Run 1 writes
`decision_required` to `result.json`; after approval, Run 2 receives
`decision: "approved"` and `approved_output` in `inputs.json`.

```python
import json
from pathlib import Path

inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))

if inputs.get("decision") == "approved":
    send(inputs["approved_output"])
    result = {"status": "success", "outputs": {"sent": True}, "artifacts": []}
else:
    draft = generate_draft(inputs)
    result = {
        "status": "success",
        "outputs": {"message_draft": draft},
        "decision_required": {
            "label": "Review and approve before sending",
            "preview": draft,
        },
        "artifacts": [],
    }

Path("result.json").write_text(json.dumps(result), encoding="utf-8")
```

---

## 7. Recipe: "Port a Claude skill bundle to a worker"

If the skill lives at `~/.claude/skills/my-skill/SKILL.md`:

### 7.1 Read the skill

```
Use Read tool to fetch ~/.claude/skills/my-skill/SKILL.md.
Note: required inputs, expected outputs, any external API calls.
```

### 7.2 Generate the worker.yml

Heuristics:
- `entrypoint: SKILL.md` (agent mode by default).
- Inputs: parse from the SKILL.md "You receive: ..." or "Inputs: ..." block.
- Outputs: one markdown file output (`out/result.md`) unless the skill writes structured JSON.
- Secrets: `OPENAI_API_KEY` if the skill uses OpenAI, plus any explicit `<API_KEY>` references.
- Network egress: true if any external API is referenced.
- Trigger: `manual` (let the user choose schedule/webhook/composio after deploy).

### 7.3 Deploy via CLI

```bash
floom workers validate workers/my-skill
floom workers push workers/my-skill
```

### 7.4 Verify

Smoke-test with `floom run` or MCP `workers.run` + `runs.watch`. If the
skill referenced `~/.claude/skills/...` absolute paths, those will fail in the
sandbox; patch to relative paths first.

**Gotchas:**
- Claude-Code-only tools (Read/Edit/Bash on host filesystem) are not available in the sandbox runtime. Audit the skill's tool calls before porting.
- Heavy Python deps (torch, transformers, playwright) won't fit in the E2B template. Trim dependencies or split the worker into smaller sandboxed steps.
- Skills that use Claude's `web_search` work; the runner exposes equivalent search.

---

## 8. MCP tool reference (with examples)

Every tool, what it returns, and a worked example.

### workers.list

**Returns:** `{ workers: [{ id, name, title, status, trigger_type, last_run_at, ... }] }`

```
workers.list()
// -> { workers: [{ id: "text-summarizer", name: "text-summarizer", status: "ready", ... }] }
```

### workers.get

**Args:** `{ id: string }`
**Returns:** `{ worker: { ...full config, recent_runs: [...], webhook_url, status } }`

```
workers.get({ id: "text-summarizer" })
```

### workers.create

**Args:** `{ worker_yml, run_py }`
- MCP creation currently accepts script-mode Python source. Use CLI
  `floom workers push <dir>` for `SKILL.md` agent-mode bundles.

**Returns:** `{ worker: { id, ... } }`

```
workers.create({
  worker_yml: "schema_version: '0.3'\nname: my-worker\n...",
  run_py: "import json\nfrom pathlib import Path\ninputs=json.loads(Path('inputs.json').read_text())\nPath('result.json').write_text(json.dumps({'status':'success','outputs':{},'artifacts':[]}))",
})
```

### workers.update

**Args:** `{ id, trigger_type?, cron_expr?, cron_timezone?, input_values?, capabilities?, webhook_secret_rotate? }`

```
workers.update({
  id: "text-summarizer",
  trigger_type: "schedule",
  cron_expr: "0 9 * * *",
  cron_timezone: "Europe/Berlin",
  input_values: { text: "Daily standup notes..." },
})
```

### workers.delete

```
workers.delete({ id: "text-summarizer" })
```

### workers.run

**Args:** `{ id, inputs, trigger_source? }`
**Returns:** `{ run_id, status }`

```
const { run_id } = await workers.run({
  id: "text-summarizer",
  inputs: { text: "long text here..." },
})
```

### runs.list

**Args:** `{ worker_id?, status?, limit? }`

```
runs.list({ worker_id: "text-summarizer", limit: 10 })
```

### runs.get

**Args:** `{ id }`
**Returns:** `{ run: { id, status, inputs, outputs, logs, artifacts, ... } }`

```
runs.get({ id: "run_abc123" })
```

### runs.watch

**Args:** `{ run_id }`
**Returns:** stream of SSE events until terminal.

Events emitted:
- `text` - agent narration
- `tool-call` - agent called a tool
- `tool-result` - tool returned
- `reasoning` - agent internal reasoning (if enabled)
- `step-start` - new step
- `finish` - terminal; run is done

```
for await (const part of runs.watch({ run_id: "run_abc123" })) {
  if (part.type === "tool-call") log(`Tool: ${part.tool}`)
  if (part.type === "finish") break
}
```

### secrets.list / secrets.set / secrets.delete

```
secrets.list()
// -> { secrets: [{ key: "OPENAI_API_KEY", set: true }, ...] }

secrets.set({ key: "STRIPE_API_KEY", value: "sk_test_..." })

secrets.delete({ key: "STRIPE_API_KEY" })
```

### connections.list / triggers.list

```
connections.list()
// -> { connections: [{ id, provider, status, expires_at, ... }] }

triggers.list({ worker_id: "text-summarizer" })
```

When authoring a worker with Composio tools, declare both the app and the exact tools the worker may call:

```yaml
connections:
  - app: google_search_console
    allowed_tools:
      - GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY
      - GOOGLE_SEARCH_CONSOLE_LIST_SITEMAPS
```

Run `floom workers validate ./workers/<id>` before pushing. It catches E2B anti-patterns like `subprocess.run(["composio", "execute", ...])`, missing `connections:`, and tool slugs not listed in `allowed_tools`.

---

## 9. The agent-side draft contract

When an agent is asked "build me a worker that does X", produce:

1. **Default to agent mode** unless X is deterministic / ETL-shaped.
2. **Include `long_description`, `use_cases`, `how_it_works`** - these power the Overview tab.
3. **Pin every secret** the worker will read.
4. **`capabilities.network.egress: true`** if any external API is called.
5. **`approvals.required: true`** for any worker that sends, deletes, or pays.
6. **Default `trigger: manual`** unless the prompt explicitly says "every X" or "when Y arrives".
7. **Pin dep versions** exactly (`openai==1.51.0`, not `openai`).
8. **Use `gpt-5-mini` by default**; reserve larger models for prompts that explicitly need them.

After writing, ALWAYS:

- Call `workers.create` for script-mode MCP creation, or `floom workers push`
  for local bundles and `SKILL.md` workers.
- Call `workers.run` with `example_input` to smoke-test.
- Call `runs.watch` and confirm terminal status === "succeeded".
- Report back to the user with the worker URL + run URL + run duration.

If smoke-test fails:
- Read the logs with `runs.get`.
- Patch settings with `workers.update`, or patch source locally and run
  `floom workers push <dir>`.
- Re-test.

---

## 10. Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Missing secret | Run fails with `KeyError` or empty output | Declare in `secrets:` AND `capabilities.secrets:` |
| Egress not enabled | OpenAI calls hang | `capabilities.network.egress: true` |
| Timeout too low | Run cancelled at 60s | Set `exec.limits.timeout_seconds: 300` (or higher) |
| Floating dep version | "It worked yesterday" | Pin exact versions in requirements.txt |
| Modal claude-code tools | `Read is not defined` in sandbox | Switch to plain Python `open()` / `pathlib` |
| Relative path to ~/ | `FileNotFoundError` in sandbox | Use bundle-relative paths only |
| Saving output to wrong path | Run succeeds but UI shows no output | Match `exec.outputs[].path` exactly |
| Forgot to declare output | UI says "No output" | Add the entry to `exec.outputs[]` |
| Two trigger types stacked | UI confused | Pick one; multi-trigger is for power users |

---

## 11. When in doubt

- Check [AUTHORING.md](AUTHORING.md) for the full schema.
- Read the reference workers in [workers/](../workers/) - copy the closest match.
- If a tool returns an unclear error, call `runs.get` and read the logs.
- The MCP server prints structured errors; never just retry - diagnose first.
