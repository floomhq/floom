# The Floom Protocol

Floom is infra for agentic work. This spec defines how a tool becomes a Floom app.

## One manifest, four surfaces

A tool becomes a Floom app by providing a `floom.yaml` manifest. From that single file, Floom auto-generates four equivalent interfaces:

1. **Chat UI** — a conversational surface at floom.dev with a prompt box that routes natural language to the tool
2. **MCP server** — an MCP-compliant HTTP+SSE endpoint at floom.dev/mcp/app/{slug} that any MCP agent can call
3. **HTTP API** — a REST endpoint at floom.dev/api/{slug}/run that any HTTP client can call
4. **CLI tool** — `floom run {slug} --input=value` via the Floom CLI

All four surfaces call the same underlying sandbox. Manifest is the source of truth.

## The manifest

```yaml
name: flyfast              # slug, lowercase, dashes, unique
display_name: FlyFast      # human-readable
description: "..."         # one-line
creator: "@federicodeponte"
category: travel
runtime: python3.12        # python3.12 | node20 | go1.22 | rust | docker | auto
build: pip install -r requirements.txt
run: python -m flyfast.search "${query}"
inputs:
  - name: query
    type: string           # string | number | boolean | file | json
    required: true
    label: "What are you looking for?"
    placeholder: "cheap flights from Berlin to Lisbon next week"
outputs:
  type: markdown
  field: results
secrets:
  - SKYSCANNER_API_KEY
memory_mb: 1024            # default 512, bump for heavy apps
timeout: 60s
egress_allowlist:
  - api.skyscanner.com
```

## Auto-detect (for GitHub repos without a manifest)

In priority order:
1. `floom.yaml` exists — use it
2. `Dockerfile` exists — runtime: docker, use as-is
3. `pyproject.toml` — Python, `pip install .`, look at `[project.scripts]`
4. `requirements.txt` — Python, `pip install -r requirements.txt`
5. `package.json` — Node, `npm install` (or `pnpm install` if `workspace:` protocol detected)
6. `Cargo.toml` — Rust, `cargo build --release`
7. `go.mod` — Go, `go build -o app` at the DEEPEST go.mod dir

Workdir: the deepest runtime manifest in the tree (supports monorepos).

## Runtime

v1 uses Docker-per-app. v2 migrates to e2b sandboxes via pause/connect (611ms warm). Runtime is interchangeable — manifest is the contract.

## What gets generated at register time

```
manifest.yaml -> Floom registry ->
  |- MCP route generated automatically
  |- CLI command wired via slug
  |- HTTP endpoint live
  +- Chat UI shows in the Browse grid
```

## Normalized manifest shape (v2)

The internal representation Floom uses after parsing any manifest source:

```typescript
interface NormalizedManifest {
  name: string;
  description: string;
  runtime: 'python' | 'node';
  manifest_version: '1.0' | '2.0';
  actions: Record<string, ActionSpec>;
  python_dependencies: string[];
  node_dependencies: Record<string, string>;
  secrets_needed: string[];
  apt_packages?: string[];
}

interface ActionSpec {
  label: string;
  description?: string;
  inputs: InputSpec[];
  outputs: OutputSpec[];
}

interface InputSpec {
  name: string;
  type: 'text' | 'textarea' | 'url' | 'number' | 'enum' | 'boolean' | 'date' | 'file';
  label: string;
  required?: boolean;
  default?: unknown;
  options?: string[];     // for enum
  placeholder?: string;
}

interface OutputSpec {
  name: string;
  type: 'text' | 'json' | 'table' | 'number' | 'html' | 'markdown' | 'pdf' | 'image' | 'file';
  label: string;
}
```

## App execution protocol

Every app is wrapped by a Floom entrypoint. The entrypoint receives input via `argv[1]` (Python) or `argv[2]` (Node) as a JSON string `{"action": "...", "inputs": {...}}`, and writes a single line to stdout:

```
__FLOOM_RESULT__{"ok": true, "outputs": {...}}
```

or on failure:

```
__FLOOM_RESULT__{"ok": false, "error": "...", "error_type": "runtime_error"}
```

Everything written to stdout/stderr before `__FLOOM_RESULT__` is treated as user-visible log output and streamed live to the chat UI.

## MCP surface

Each app exposes a per-app MCP server at `/mcp/app/{slug}`. The MCP server uses HTTP+SSE transport (MCP spec 2024-11-05). Tools are generated from the app's actions: each action becomes one MCP tool, with the action's `inputs` mapped to JSON Schema properties.

Example: an app with slug `blast-radius` and action `analyze` exposes:

```
GET  /mcp/app/blast-radius          -> SSE stream (MCP notifications)
POST /mcp/app/blast-radius          -> MCP JSON-RPC (tool calls, initialize, etc.)
```

## API surface

```
GET  /api/hub                       -> list all apps
GET  /api/hub/:slug                 -> app detail + manifest
POST /api/pick  { prompt, limit }   -> ranked app picks for a query
POST /api/parse { prompt, app_slug, action } -> structured inputs from prose
POST /api/run   { app_slug, inputs, action, thread_id } -> { run_id, status }
GET  /api/run/:id                   -> run snapshot
GET  /api/run/:id/stream            -> SSE: log lines + status transitions
POST /api/thread                    -> create thread
POST /api/thread/:id/turn           -> save turn
GET  /api/health                    -> { ok: true, ... }
```
