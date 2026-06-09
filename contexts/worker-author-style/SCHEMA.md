# Worker YAML Schema — v0.3

This is the reference for generating valid `worker.yml` files.

## Required fields

```yaml
schema_version: "0.3"        # always exactly this
name: "my-worker"            # lowercase letters, digits, hyphens; 3-64 chars; start+end alphanumeric
title: "My Worker"           # human-readable; 5-60 chars; title case
description: "One sentence." # 20-120 chars; starts with a verb; no trailing period needed
version: "0.1.0"             # semver; new workers always start at 0.1.0
exec:                        # execution block (see below)
  ...
```

## Optional identity fields

```yaml
long_description: |          # 2-5 paragraphs shown on Overview tab; lead with what it does
  ...

use_cases:                   # bullet list shown on Overview
  - "First use case."
  - "Second use case."

example_input:               # dict; populates "Fill with sample input" button
  topic: "AI tools"
  audience: "executive"
  # For a FILE input, give the file's INLINE TEXT CONTENT as a string (not a
  # path). The UI turns it into a real uploaded file so the worker is
  # one-click runnable from the sample. ALWAYS include every file input here.
  #   names_csv: "name\nalice\nbob\ncharlie\n"

example_output: |            # shown on Overview; markdown rendered
  ## Example output
  ...

how_it_works: |              # plain-English steps
  Input -> Step 1 -> Step 2 -> Output

folder: "Category/Sub"       # groups worker in nav rail
tags:                        # used by tag filter
  - "tag1"
  - "tag2"

is_example: false            # always false for new user-created workers
```

## Execution block — agent mode (SKILL.md)

Use for reasoning, writing, research, summarization — anything that benefits from an LLM tool loop.

```yaml
exec:
  entry: "SKILL.md"
  runtime: "skill"
  runner: "e2b"
  inputs:
    - name: "topic"
      kind: "scalar"
      type: "string"       # string | textarea | number | boolean | select | url
      required: true
      label: "Topic"
      placeholder: "e.g. AI recruiting workflow tools"
  outputs:
    - name: "brief"
      kind: "file"
      media_type: "text/markdown"
      path: "out/brief.md"
      required: true
      label: "Research Brief"
```

## Execution block — script mode (run.py)

Use for deterministic transforms, ETL, webhook fan-out, scheduled API calls.

The run.py is a STANDALONE script (`python run.py`), NOT a `run(inputs, context)`
function. See `RUN_PY_TEMPLATE.py` for the canonical, copy-pasteable contract and
`workers/csv_enricher/run.py` for a working example.

```yaml
exec:
  entry: "run.py"
  command: "python run.py"
  runtime: "python311"     # python311 | node22 | bash
  runner: "e2b"
  inputs:
    # SCALAR input: no `path:` — value passed inline in inputs.json.
    - name: "instruction"
      kind: "scalar"
      type: "textarea"
      required: true
      label: "Instruction"
    # FILE input: path MUST be "inputs/<name>"; value read from inputs.json is
    # that relative path, which run.py open()s.
    - name: "csv_file"
      kind: "file"
      media_type: "text/csv"
      path: "inputs/csv_file"
      required: true
      label: "Input CSV"
  outputs:
    - name: "enriched_csv"
      kind: "file"
      media_type: "text/csv"
      path: "out/enriched_csv.csv"   # always under out/
      required: true
      label: "Enriched CSV"
```

### Input `path` rule (script mode)

- **Scalar inputs** (`type: string | textarea | number | boolean | select | url`):
  `kind: "scalar"`, **omit `path:`**. The value is the literal value inline.
- **File inputs**: `kind: "file"`, `path: "inputs/<name>"` (use the input's own
  `name`). run.py reads the relative path from inputs.json and `open()`s it.

### Output `kind` rule (scalar vs file) — DECLARE the kind correctly

Pick the output kind that matches the result, and declare its required fields.
A scalar output MUST declare `type`; a file output MUST declare `media_type`.

- **Scalar output** (a single short string or number — reverse/title-case/sum/
  median results): `kind: "scalar"` and **declare `type`**
  (`string | textarea | number | boolean | select | url`); **omit `media_type`
  and `path`**. A scalar output WITHOUT `type` fails registration with
  "scalar field '<name>' must declare type". run.py returns the literal value:
  `outputs={"<name>": <value>}` (no out/ file).
  ```yaml
  outputs:
    - name: reversed_string
      kind: "scalar"
      type: "string"
  ```
- **File output** — declare `kind: "file"` + `media_type` + `path` (below):
  - **Structured / JSON results** (a dict/list the worker writes via `json.dumps`,
    e.g. `{"min":1,"max":9,"mean":5}`): `media_type: "application/json"` and
    `path: "out/<name>.json"`. The validator gates JSON outputs on **parseability,
    not byte size**, so a small valid JSON document passes. Declaring such an output
    as `text/*` would wrongly fail it against the prose byte floor.
  - **Prose / markdown / CSV results**: use the matching text media_type
    (`text/markdown`, `text/plain`, `text/csv`) and `path: "out/<name>.<ext>"`.

## Trigger types

```yaml
trigger:
  type: "manual"            # default; operator runs it manually

trigger:
  type: "schedule"
  cron: "0 9 * * 1"        # every Monday at 9am
  timezone: "UTC"

trigger:
  type: "webhook"
  webhook:
    secret: true
    allowed_methods: ["POST"]
```

Use `type: "schedule"` for cron-based workers. `type: "cron"` is a legacy alias that the engine accepts, but templates and new worker drafts must not emit it.

## Contexts (read-only knowledge mounts)

```yaml
contexts:
  - name: "my-style-guide"    # must exist in contexts/ directory
    writeable: false
```

## Connections (Composio integrations)

**`connections:` is a TOP-LEVEL field — it is a sibling of `exec:`, never a child of it.**
Placing it under `exec:` causes Pydantic to silently drop it, the agent never receives
the tools, and the run fails. This is the #1 generated-worker bug.

```yaml
# CORRECT structure — connections and exec are siblings at the top level
schema_version: "0.3"
name: "my-worker"
connections:              # ← TOP LEVEL, sibling of exec
  - app: "gmail"
    allowed_tools:
      - GMAIL_FETCH_EMAILS
      - GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID
exec:                     # ← TOP LEVEL, no connections key inside here
  entry: "SKILL.md"
  runtime: "skill"
  runner: "e2b"
  inputs: []
```

```yaml
connections:
  - "github"               # legacy full app access
  - app: "gmail"           # scoped access for this worker
    allowed_tools:
      - GMAIL_FETCH_EMAILS
      - GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID
```

Connection selection is account-aware. Check the current workspace inventory before choosing an app: `connections__list` reports app slug, account label, status, scopes, and MCP allowed tools. `allowed_tools` is enforced by the Workeros Composio proxy for E2B workers. It limits what this worker can execute even when the underlying OAuth connection has broader scopes. If the token itself must be read-only, use a separate Composio readonly auth config such as `gmail.readonly`.

## Secrets

```yaml
# Declared secrets are exposed as env vars inside the sandbox
exec:
  secrets:
    - "OPENAI_API_KEY"
    - "MY_API_KEY"
```

## Limits (agent mode only)

```yaml
limits:
  max_tool_iterations: 12      # default
  max_output_tokens: 4096      # default
  max_total_tokens: 50000      # default
  timeout_seconds: 300         # default
```

## Full minimal examples

### Agent mode (SKILL.md entry)

```yaml
schema_version: "0.3"
name: "research-brief"
title: "Research Brief"
description: "Generates a structured research brief from a topic and audience."
version: "0.1.0"
is_example: false
targets:
  - "generic"
exec:
  entry: "SKILL.md"
  runtime: "skill"
  runner: "e2b"
  inputs:
    - name: "topic"
      kind: "scalar"
      type: "string"
      required: true
      label: "Topic"
  outputs:
    - name: "brief"
      kind: "file"
      media_type: "text/markdown"
      path: "out/brief.md"
      required: true
      label: "Brief"
trigger:
  type: "manual"
```

### Script mode (run.py entry)

```yaml
schema_version: "0.3"
name: "csv-enricher"
title: "CSV Enricher"
description: "Adds a derived column to a CSV file."
version: "0.1.0"
is_example: false
targets:
  - "generic"
exec:
  entry: "run.py"
  command: "python run.py"
  runtime: "python311"
  runner: "e2b"
  inputs:
    - name: "input_csv"
      kind: "file"
      media_type: "text/csv"
      path: "inputs/input_csv"   # file input path = inputs/<name>
      required: true
      label: "Input CSV"
  outputs:
    - name: "output_csv"
      kind: "file"
      media_type: "text/csv"
      path: "out/output.csv"
      required: true
      label: "Enriched CSV"
trigger:
  type: "manual"
```
