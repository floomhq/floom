# Authoring Workers

> **If you are an agent (Claude Code / Cursor) authoring via the MCP, read [AGENT-COOKBOOK.md](AGENT-COOKBOOK.md) first** - it has the per-tool examples + end-to-end recipes. This doc is the schema + concept reference.

This is the canonical guide for writing, deploying, and updating workers on Workeros. It covers:

1. What a worker is
2. The two execution modes (script vs agent / SKILL.md)
3. The `worker.yml` schema (every field, with examples)
4. Inputs, outputs, secrets, connections, triggers, approvals
5. Deploying a Claude-style skill bundle as a worker
6. The CLI + MCP authoring flows
7. The agent-side "write a worker from a prompt" contract

Treat this as the source of truth. The README's worker section is a stub; everything operational lives here.

---

## 1. What a worker is

A **worker** is a folder under `workers/<name>/` containing exactly:

```
workers/<name>/
  worker.yml          # configuration (required)
  run.py              # entry code (script mode) OR
  SKILL.md            # agent prompt (agent mode)
  requirements.txt    # Python deps (optional but recommended)
  <any other files>   # bundled into the sandbox at runtime
```

The bundle is uploaded as-is to the run sandbox. You can include helper modules, data files, prompt fragments, anything. Files outside the folder are not visible to the worker.

When the worker runs, the runtime:

1. Materializes the bundle into a working directory.
2. Materializes named inputs at the paths declared in `exec.inputs[].path`.
3. Resolves declared secrets/connections from the host's secret store and exposes them as env vars.
4. Executes `exec.command` (script mode) or the agent loop (agent mode).
5. Captures stdout / stderr / structured events into the run's logs + parts stream.
6. Materializes named outputs from the paths declared in `exec.outputs[].path`.
7. Marks the run succeeded / failed / cancelled.

---

## 2. Execution modes

There are two modes; they are mutually exclusive per worker.

### Script mode (`run.py`)

Plain Python entry. Predictable, deterministic, no LLM tool loop. Use for:

- ETL: CSV enrichment, format conversion, deterministic transforms.
- Webhook fan-out: receive a payload, call an API, write a row.
- Scheduled jobs: pull data, summarize, send.

Contract:

```python
# run.py
import json
from pathlib import Path

inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))

# Produce declared output files under out/.
Path("out").mkdir(exist_ok=True)
Path("out/summary.md").write_text("# Summary\n\n...", encoding="utf-8")

# Always write result.json in the working directory. The runner reads this file
# to decide status and map declared output names to files.
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

Script mode is a process contract, not a callable shim: `exec.command` runs
`python run.py`, the worker reads `inputs.json`, and the worker must write
`result.json` in the working directory before exiting. Declared secrets are
available as environment variables. Declared Composio connection identifiers are
available in `connections.json` when the worker needs them. There is no
runtime-provided `context` object for script workers.

### Agent mode (`SKILL.md`)

LLM-driven tool loop. Use for:

- Tasks that need reasoning over unstructured input (CV writeup, research brief, candidate matching).
- Tasks where the steps vary per input (custom report, multi-tool research).
- Tasks where the output format depends on a description the user wrote.

The runner reads `SKILL.md` as the system prompt and runs an LLM loop with:
- Web search (when available; see runtime caveats in the worker.yml).
- File tools (read/write inside the sandbox).
- Connection tools (Composio actions for the declared connections).
- Output writers (one per declared `exec.outputs[]`).

`SKILL.md` is a plain markdown file. The shape that works in practice:

```markdown
# <Title>

You receive: <list of inputs>.

Your task:
1. ...
2. ...

Constraints:
- Output formats: ...
- When to call X tool: ...

Done = you have written every declared output.
```

The loop terminates when the agent calls the final output-writer or hits `exec.limits.max_tool_iterations`.

---

## 3. The `worker.yml` schema

Schema version: `0.3`. Every field below has been used in production workers in this repo (see `workers/research_brief/worker.yml`, `workers/resume_helper/worker.yml` for live references).

```yaml
schema_version: "0.3"

# === IDENTITY ===
name: my-worker              # unique slug, lowercase + dashes
title: My Worker             # human-readable title
description: One-liner.      # appears on the worker card
long_description: |
  Two-to-five paragraph plain-English description shown on the Overview tab.
  This is what readers see FIRST. Lead with what it does, not how.

use_cases:                   # bulleted list, shown on Overview
  - First use case in one sentence.
  - Second use case in one sentence.

example_input:               # dict; "Fill with sample input" button on /workers/<id>#run
  topic: Some example
  audience: executive

example_output: |            # rendered as markdown on Overview
  ## Example output
  ...

how_it_works: |              # plain-English steps, shown on Overview
  Step 1 -> Step 2 -> Step 3.

folder: Category/Subcategory # used for grouping in /workers nav rail
tags:                        # used by the tag filter row + search
  - tag1
  - tag2

version: 0.1.0               # semver; bump on any bundle change

# === EXECUTION ===
entrypoint: SKILL.md         # OR `run.py` for script mode
targets:                     # which runtimes are supported
  - generic
limits:                      # agent-mode only; ignored for script mode
  max_tool_iterations: 12
  max_output_tokens: 4096
  max_total_tokens: 50000
  timeout_seconds: 300

resources:                   # optional sandbox sizing request
  memory_mb: 2048            # capped by WORKEROS_MAX_WORKER_MEMORY_MB
  cpu_count: 2               # capped by WORKEROS_MAX_WORKER_CPU_COUNT

exec:
  command: python run.py     # script mode only
  runtime: python311         # python311 | node20
  runner: e2b                # e2b (default) | local (zero cold-start, trusted only)
  entry: run.py              # legacy field; should match `entrypoint`

  inputs:
    - name: topic            # field name (passed to run())
      kind: scalar           # scalar | file
      type: string           # string | number | boolean | textarea | select | url
      required: true
      label: Topic           # shown above the input on /workers/<id>#run
      placeholder: e.g., AI recruiting workflow tools
      default: ""            # optional
      enum:                  # required if type=select
        - option_a
        - option_b
      options:               # mirrors enum (legacy)
        - option_a
        - option_b

    - name: cv_file
      kind: file
      media_type: application/octet-stream
      path: inputs/cv_file   # where the file is materialized inside the sandbox
      required: true
      label: CV file (PDF, DOCX, TXT)
      accepts:               # optional MIME filter for the upload control
        - application/pdf
        - text/plain
      max_size_mb: 10        # optional
      accept_csv: false      # if true, surfaces the CSV column mapper

  outputs:
    - name: writeup
      kind: file
      media_type: text/markdown   # text/markdown is rendered inline
      path: out/writeup.md        # where the worker writes the output
      required: true
      label: Candidate Writeup
    - name: extracted_profile
      kind: file
      media_type: application/json
      path: out/extracted_profile.json
      required: true
      label: Extracted Profile (JSON)

  secrets:                   # env-var names the worker can read
    - OPENAI_API_KEY

capabilities:
  secrets:
    - OPENAI_API_KEY
  network:
    egress: true             # required for any worker that calls external APIs

approvals:
  required: false            # if true, runs pause before completing
  label: Review and approve before sending to client

# === TRIGGER ===
trigger:
  type: manual               # manual | schedule | webhook | composio

# OR for schedule:
# trigger:
#   type: schedule
#   cron: "0 9 * * MON"
#   timezone: "Europe/Berlin"

# OR for webhook:
# trigger:
#   type: webhook
#   webhook:
#     secret: true
#     allowed_methods: [POST]

# OR for app event (Composio):
# trigger:
#   type: composio
#   composio:
#     event: "gmail.new_message"
#     connection_id: "ca_<id>"
#     filters: {}

# === MULTIPLE TRIGGERS (S22+) ===
# triggers:                  # plural alternative; can mix types
#   - type: schedule
#     cron: "0 9 * * MON"
#     timezone: "Europe/Berlin"
#   - type: webhook
#     webhook: { secret: true, allowed_methods: [POST] }
```

### Required vs optional

**Required:** `schema_version`, `name`, `title`, `description`, `entrypoint`, `exec.runtime`, `exec.runner`, `exec.inputs` (can be empty `[]`), `exec.outputs` (can be empty `[]`), `trigger`.

**Recommended:** `long_description`, `example_input`, `example_output`, `use_cases`, `how_it_works`, `version`, `tags`, `folder`. These power the Overview tab.

**Conditional:** `limits` (agent mode), `secrets` (only the ones you read), `capabilities.network.egress` (set true if you call external APIs), `approvals` (only if you want human-in-the-loop), `calls` (only if this worker invokes other workers).

### Pre-defined inputs for automated triggers

A manual run takes inputs from the Run form. Scheduled / webhook / app-event
triggers have no form, so they use the worker's saved **input defaults**
(`input_values`) — set via `workers.update` (MCP/API) or the worker's settings.
Think of it as a reusable input template pinned per worker:

- **Schedule (cron):** the scheduler injects `input_values` on every fire
  (`scheduler.py: _effective_scheduled_inputs`). If a *required* input has no
  pre-set value, that scheduled fire is **skipped** (and logged) rather than run
  half-formed.
- **Webhook / app event:** `input_values` act as defaults and are **merged** with
  the incoming event payload — the payload wins where both set the same key.

### Worker-to-worker calls (`calls:`)

A worker can invoke other workers ("stacking"). Declare the allowlist at the top
level of `worker.yml`:

```yaml
calls:
  - data-enricher      # this worker may invoke ONLY these worker IDs
  - report-writer
```

Scoping is enforced **server-side** (not on the honor system):

- **Which workers:** a call to a worker not in `calls:` is rejected (403). The
  allowlist is also baked into the run's **signed** worker-call token, so it can't
  be forged from inside the sandbox.
- **Chain depth:** a call chain is capped at **3 levels** (`MAX_CALL_DEPTH`) — A
  calls B calls C, but C cannot reach a 4th. Prevents runaway recursion.
- **Fan-out count:** a single run may spawn at most **50 child runs**
  (`MAX_WORKER_CALLS_PER_RUN`) across all of its calls — a cost / runaway guard,
  enforced at child-run creation. (A per-workspace, user-configurable limit
  *within* this ceiling is planned — see the tracking issue.)

---

## 4. Inputs, outputs, secrets, connections, triggers

### Inputs

- Scalars (`kind: scalar`, `type: string|number|boolean|textarea|select|url`) arrive as values in `inputs[name]`.
- Files (`kind: file`, with `path`) arrive materialized at `path` inside the bundle. Read them as plain filesystem reads.
- Select inputs (`type: select` with `enum`) render as a dropdown in the UI. Display labels are humanized automatically (`branded_markdown` -> `Branded markdown`), but the raw enum value is what reaches `run()`.

### Outputs

- File outputs (`kind: file`, with `path`) are materialized from `path` after the run.
- `media_type: text/markdown` outputs render inline on the Run tab.
- `media_type: application/json` outputs are pretty-printed.
- Other media types are downloadable.

### Secrets

- Declare every env var the worker reads under `secrets` AND `capabilities.secrets`.
- The runtime resolves them from the host's secret store (`/secrets` API) and exposes them as env vars to the worker.
- Workers cannot read host env vars that are not declared. Failure mode is the var is unset, not a permission denial.

**Secrets encryption key (`.secrets.enc`):**

Worker secrets are stored encrypted in `.secrets.enc` in your workspace. The decryption key is stored out-of-band and managed automatically:

| Setup | Key location | Notes |
|---|---|---|
| Cloud (workeros.floom.dev) | Supabase Vault | Managed automatically, no action needed |
| Self-hosted + GitHub remote | GitHub repo Variable `WORKEROS_SECRETS_KEY` | Set automatically on first write; shared across team |
| Self-hosted, local git only | `~/.config/workeros/secrets.key` (mode 600) | Generated automatically on first write |

For local git setups: back up `~/.config/workeros/secrets.key`. Losing it means the existing `.secrets.enc` is unreadable and all secrets must be re-entered. The key is a 32-byte hex string.

### Connections (Composio)

- Composio connections (Gmail, Calendar, GitHub, etc.) are passed to the worker as objects on `context.connections[<provider>]`.
- Required connections are declared in `connections:` for tool access and in `triggers` for Composio event-triggered workers.
- The Connections UI and `connections__list` agent tool expose app slug, connected account label, status, scopes, and MCP allowed tools so the author can pick the right account.
- Legacy `connections: [gmail]` grants the worker access to any Gmail Composio tool that matches the app namespace.
- Use structured connection declarations to scope a full OAuth connection down to specific tools for one worker:

```yaml
connections:
  - app: gmail
    allowed_tools:
      - GMAIL_FETCH_EMAILS
      - GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID
```

- The E2B Composio proxy rejects undeclared apps and rejects tool slugs outside `allowed_tools`. This is platform-level enforcement against prompt injection or worker bugs; it does not shrink the underlying OAuth refresh token. For true OAuth least privilege, create a separate Composio auth config with narrower scopes such as Gmail readonly.
- E2B `run.py` workers call `POST /runs/{FLOOM_RUN_ID}/composio-execute/{TOOL_SLUG}` through `WORKEROS_API_URL`; they do not shell out to `composio execute` or carry `COMPOSIO_API_KEY` in the sandbox.

### Brain/context packs

Attach local or git-backed brain packs with `contexts:`. Script workers receive them under `context/<name>/` inside the E2B workdir. Agent workers receive the same `context/<name>/` layout in their staged run directory.

```yaml
contexts:
  - name: company-handbook
    source: local
  - name: external-notes
    source: git+https://github.com/example/notes.git
```

Local packs are copied from the workspace context store. Git-backed packs are cloned into the E2B sandbox at run time; they are read-only from Workeros' perspective. Add `writeable: true` only for local packs that the worker is allowed to persist back after a successful run.

For large packs, use `when` to mount them only for run inputs that actually need them. This keeps lightweight operations from paying the sandbox upload cost for data they never read.

```yaml
inputs:
  - name: operation
    type: select
    options: [search, profile]

contexts:
  - name: sample-search-data
    source: local
    when:
      input: operation
      not_in: [profile]
```

Supported predicates are `equals`/`eq`, `not_equals`/`neq`, `in`, `not_in`, `exists`, and `truthy`. Dotted input paths such as `candidate.source` are supported. Omitting `when` preserves the default behavior: the pack is mounted on every run.

E2B hosts can also keep successfully prepared sandboxes warm for repeat runs of the same worker/template/context shape:

```bash
WORKEROS_E2B_WARM_POOL_ENABLED=1
WORKEROS_E2B_WARM_POOL_SIZE_PER_KEY=1
WORKEROS_E2B_WARM_POOL_MAX_AGE_SECONDS=900
```

Warm pooling reuses only read-only local context mounts. Workers with writeable or git-backed contexts keep the cold path so writeback and clone semantics stay unchanged. Per-run files (`inputs/`, `outputs/`, `result.json`, `.env.local`, `secrets.json`, `connections.json`) are removed before reuse, and the pool key changes when the worker bundle or local context pack changes.

For larger workers, declare `resources.memory_mb` and point that size at an E2B template built with matching memory:

```bash
WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048=tpl-python-2gb
WORKEROS_E2B_NODE_TEMPLATE_MEMORY_2048=tpl-node-2gb
```

E2B memory/CPU is a template-build property, so an unconfigured resource request logs a warning and falls back to the normal runtime template. Operators can also register content-addressed worker templates with:

```bash
WORKEROS_E2B_TEMPLATE_CACHE_JSON='{"<bundle-cache-key>":"tpl-worker-specific"}'
# or
WORKEROS_E2B_TEMPLATE_CACHE_FILE=/path/to/e2b-template-cache.json
```

When the current worker bundle/runtime/resources hash matches that map, the runner uses the worker-specific template; otherwise it falls back to the configured shared template and normal tarball upload.

Working example:

```yaml
contexts:
  - name: hello-world
    source: git+https://github.com/octocat/Hello-World.git
```

Inside `run.py`, the cloned pack is available under `context/hello-world/`. A minimal smoke can list that directory and write `result.json` only after the clone succeeds.

Repo-testable E2B coverage:

```bash
python3 -m pytest tests/test_e2b_artifact_collection.py::test_uploads_git_context_clones_real_repo_into_context_dir -q
```

That test creates a temporary git repo, routes the E2B staging helper through a host-mapped fake sandbox, runs a real `git clone --depth 1`, and verifies the cloned files land under `context/hello-world/`.

Prod smoke command:

```bash
python3 scripts/smoke_git_context_worker.py --secret "$FLOOM_SECRET"
```

### Triggers

- **manual** - runs only from /workers/<id> Run tab or via `POST /workers/<id>/runs`.
- **schedule** - fires on cron (`cron`, `timezone`) via the scheduler service.
- **webhook** - fires when POST hits `http://localhost:8000/webhooks/<worker-id>?token=<derived>`. The token is a per-worker HMAC of the worker_id under the host's webhook signing key. The URL is shown in the Triggers tab after the worker is created.
- **composio** - fires when the named Composio event arrives, scoped to the named connection.

A worker can have multiple triggers (use the `triggers:` plural form). Prefer one trigger per worker unless there is a clear reason to combine them.

Use `type: schedule` for cron workers. Legacy manifests with `type: cron` are accepted and normalized to `schedule`, but new templates must emit `schedule`.

### Approvals (S47 two-run HITL model)

When `approvals.required: true`, runs use a **two-phase respawn model**:

1. **Run 1 - propose.** The worker does its work, drafts the action, then writes
   `decision_required` to `result.json` before exiting. The engine intercepts this,
   lands the run as `PENDING_APPROVAL`, and creates an approval record in the database.
   **Run 1 must NOT perform the real side-effect** (send email, delete data, spend money).

2. **Human decision.** The `/approvals` page (or the inline card on `/runs/[id]`) shows
   the pending approval. The reviewer can Approve, Edit-then-approve, or Reject.

3. **Run 2 - execute.** On approval, the engine spawns a fresh run of the same worker
   with the original inputs merged with `{decision: "approved", approved_output: <edited or original output>}`.
   Run 2 reads `inputs.decision` and `inputs.approved_output` and performs the real action.

#### result.json shape for Run 1

```json
{
  "status": "success",
  "outputs": { "message_draft": "..." },
  "decision_required": {
    "label": "Approve outbound message before sending",
    "preview": "Full message text shown on the approval card"
  }
}
```

#### Run 2 inputs

```python
# Workeros passes inputs as an inputs.json FILE in the working dir - NOT an env var.
with open("inputs.json") as f:
    inputs = json.load(f)
decision = inputs.get("decision")        # "approved"
approved_output = inputs.get("approved_output")  # the (possibly edited) proposed output
```

#### Idempotency constraint (mandatory)

Workers that use `approvals.required: true` MUST be **re-entrant**:

- Run 1 proposes, never executes.
- Run 2 executes, using `inputs.approved_output` as the source of truth.
- If Run 2 crashes and is retried, it must not double-fire the side-effect. Design
  your side-effect to be idempotent, or check a flag file / database record before acting.

#### Example worker structure (see `workers/outbound-approval-demo/`)

```yaml
approvals:
  required: true
  label: "Approve outbound message before sending"
```

```python
# run.py
import json
from pathlib import Path

inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
decision = inputs.get("decision")
if decision == "approved":
    # Phase 2: execute
    message = inputs["approved_output"]
    send_email(message)  # real side-effect happens here
    ...
else:
    # Phase 1: propose
    draft = compose_draft(inputs)
    result = {
        "status": "success",
        "outputs": {"message_draft": draft},
        "decision_required": {"label": "Approve before sending", "preview": draft},
    }
```

Reject path: the approval row is marked rejected, no follow-up run is spawned, and
the original run stays at PENDING_APPROVAL terminal state.

---

## 5. Deploying a Claude-style skill bundle as a worker

If you already have a Claude skill in `~/.claude/skills/<name>/SKILL.md`, the path to running it as a worker is:

1. Copy or symlink the skill directory to `workers/<name>/`:
   ```bash
   cp -r ~/.claude/skills/my-skill workers/my-skill
   ```
2. Add a `worker.yml` next to the `SKILL.md`. Minimum viable:
   ```yaml
   schema_version: "0.3"
   name: my-skill
   title: My Skill
   description: <one-liner>
   entrypoint: SKILL.md
   exec:
     runtime: python311
     runner: e2b
     inputs: []
     outputs:
       - name: result
         kind: file
         media_type: text/markdown
         path: out/result.md
         required: true
         label: Result
     secrets:
       - OPENAI_API_KEY
   capabilities:
     secrets: [OPENAI_API_KEY]
     network: { egress: true }
   trigger:
     type: manual
   ```
3. Validate and deploy the local bundle:
   ```bash
   workeros workers validate workers/my-skill
   workeros workers push workers/my-skill
   ```
4. Run from the UI, CLI, or MCP to smoke-test:
   ```bash
   workeros run my-skill --input topic="Smoke test"
   ```

**Gotchas:**

- Claude-skill bundles often assume the working directory is the skill folder (`~/.claude/skills/<name>/`). Inside the sandbox the working dir IS the bundle, so relative paths work; absolute paths to `~/.claude/...` won't.
- Skills that depend on Claude-Code-only tools (Read, Edit, Bash that hits the host filesystem) won't work - the runner exposes a different tool set. Audit the skill's tool calls before porting.
- Heavy Python deps (torch, transformers) won't fit in the E2B template. Trim dependencies or split the worker into smaller sandboxed steps.

`workeros workers push` creates a new worker id with `POST /workers` and updates
an existing worker id with `PUT /workers/<id>` when the target API supports
in-place source updates. If the API returns "does not support in-place worker
source updates", keep the validated bundle and deploy it under a new worker id
or upgrade the API.

---

## 6. CLI and MCP authoring flows

### CLI

```bash
npm i -g @floomhq/workeros
workeros login                              # browser/device auth flow
workeros doctor
workeros workers list
workeros workers validate ./workers/<id>
workeros workers push ./workers/<id>
workeros run <id> --input topic="AI tools"
```

The package also installs `floom` as a compatible alias. Use `workeros` when a
separate Floom CLI is already present on the machine.

### MCP (for Claude Code / Cursor agents)

```bash
npx -y @floomhq/workeros mcp install --target claude
```

Exposes tools the agent can call to create, update settings, run, watch, and
delete workers without leaving the chat. Use `WORKEROS_API_SECRET` env var to
skip the install-time prompt.

Current MCP source creation accepts `worker_yml` plus `run_py`. Use CLI
`workeros workers push <dir>` for local `SKILL.md` agent-mode bundles and for
source edits after the first deploy. MCP `workers.update` is for trigger,
cron, saved input defaults, documented capabilities, and webhook secret
rotation.

### API direct (for scripts / CI)

```bash
SECRET=$(cat ~/.workeros/secret)
curl -X POST http://localhost:8000/workers/<id>/runs \
  -H "x-floom-secret: $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"inputs": {"topic": "AI tools"}}'
```

---

## 7. Agent-side contract: "write a worker from a prompt"

When an agent (Claude Code / Cursor / a draft-and-create endpoint) writes a worker from a free-text prompt, it must produce:

1. `worker.yml` - well-formed, schema 0.3, every required field present.
2. `SKILL.md` (agent mode) OR `run.py` (script mode) - never both.
3. `requirements.txt` - pinned exact versions (no `^` or `~`). Skip if no third-party deps.

Rules the agent should follow (these are the failure modes observed in real drafts):

- **Default to agent mode** unless the task is deterministic / ETL-shaped. Script mode is faster to debug but loses the "describe in plain English" wedge.
- **Include `long_description`, `use_cases`, `how_it_works`** — these power the Overview tab and make the worker understandable before someone opens the source.
- **Pin every secret** the worker will read. Missing-secret failure = silent empty output.
- **Set `capabilities.network.egress: true`** if any external API is called. Default-deny.
- **Set realistic `limits.timeout_seconds`** - 300 is the safe default; longer needs justification.
- **Set `approvals.required: true`** for any worker that sends external messages, deletes data, or spends money. Default-off saves a click but raises a regret tax.
- **Default `trigger: manual`** unless the prompt explicitly says "every Monday" / "when X arrives".

The draft-and-create endpoint runs an LLM with this contract baked in. Look at `apps/api/main.py` for the prompt; keep the agent-side behavior consistent.

---

## Reference workers

Read these end-to-end before writing your first one:

- `workers/research_brief/` - agent mode, manual trigger, markdown output.
- `workers/resume_helper/` - agent mode, file input + multiple outputs, branded format.
- `workers/csv_enricher/` - script mode, CSV passthrough, OpenAI per row.
- `workers/github-digest/` - schedule trigger, Composio GitHub connection.
- `workers/gmail_intake_brief/` - composio trigger, Gmail connection, approval-gated output.

The pattern: copy the closest match, edit identity + inputs + outputs + SKILL.md, smoke-test from /workers/<id>#run, then enable the desired trigger.

---

## When to update this doc

If you ship a change that affects:

- The worker.yml schema (any new field, removed field, validation rule),
- The execution contract (`run()` signature, agent loop tools available),
- The CLI / MCP / API surface for workers,
- The trigger types or webhook URL shape,

...update this file in the SAME PR. Doc drift here is the highest-leverage bug we can ship - every new worker author reads this first.
