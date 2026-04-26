# Runtime specs

A Floom app is a **manifest plus code**. The manifest declares inputs, outputs, runtime, and secrets. The runtime is either **proxied** (wrap an existing HTTP API) or **hosted** (run a Python or Node container per request).

## The two runtimes

### Proxied (OpenAPI-based)

Point Floom at an OpenAPI spec and it generates an app that forwards each call to the upstream API. Floom adds:

- A web form and output renderer per action.
- An MCP server surface at `/mcp/app/<slug>`.
- Auth handling (bearer, API key, basic, OAuth2 client credentials).
- Optional secret injection.

No container runtime cost. Best for existing SaaS APIs.

```yaml
# apps.yaml entry — proxied
- slug: resend
  type: proxied
  openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
  auth: bearer
  secrets: [RESEND_API_KEY]
  display_name: Resend
  description: "Transactional email API."
  category: communication
```

### Hosted (Python or Node container)

Write a `floom.yaml` manifest plus a `main.py` or `main.js`. Floom builds one Docker image from your code and starts a fresh container for every run. Best for apps that need LLM calls, file processing, or custom logic.

```yaml
# floom.yaml — hosted
name: Lead Scorer
slug: lead-scorer
description: Score leads against an ICP using Gemini 3.
runtime: python
manifest_version: "2.0"
actions:
  score:
    label: Score Leads
    inputs:
      - name: data
        label: Leads CSV
        type: file
        required: true
      - name: icp
        label: Ideal Customer Profile
        type: textarea
        required: true
    outputs:
      - name: rows
        label: Scored Leads
        type: table
python_dependencies:
  - google-genai==1.64.0
secrets_needed:
  - GEMINI_API_KEY
network:
  allowed_domains:
    - generativelanguage.googleapis.com
```

## `floom.yaml` reference

Top-level fields (see [spec/protocol.md §3](https://github.com/floomhq/floom/blob/main/spec/protocol.md)):

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Display name. |
| `slug` | string | yes | URL segment. Must match `^[a-z0-9][a-z0-9-]*$`. |
| `description` | string | yes | One-line description. |
| `manifest_version` | `"1.0"` or `"2.0"` | yes | Use `"2.0"` for new apps. |
| `runtime` | `"python"` or `"node"` | no | Defaults to `"python"`. |
| `actions` | object | yes (v2) | Keyed by action name. At least one. |
| `python_dependencies` | string[] | no | pip requirement strings. |
| `node_dependencies` | object | no | Package -> version map. |
| `apt_packages` | string[] | no | OS packages available at runtime. |
| `secrets_needed` | string[] | no | Env var names the app needs. |
| `network.allowed_domains` | string[] | yes for new hosted apps | Outbound domains the container can reach. `[]` blocks all outbound network. |
| `primary_action` | string | no | Which action to show by default in the runner. |

### Network policy

Hosted app containers are outbound-denied by default. Declare each external
API the app needs:

```yaml
network:
  allowed_domains:
    - api.openai.com
    - "*.example-api.com"
```

Use exact domains or `*.domain` globs. `*`, URLs, ports, and IP literals are
rejected. See `docs/security/network-policy.md` for the runtime model and
legacy compatibility behavior.

### Action spec

Each entry in `actions` declares:

- `label` — human string.
- `description` — optional short paragraph.
- `inputs` — array of input fields.
- `outputs` — array of output fields.

### Input types

Exact list from [`apps/server/src/types.ts`](https://github.com/floomhq/floom/blob/main/apps/server/src/types.ts):

`text`, `textarea`, `url`, `number`, `enum`, `boolean`, `date`, `file`.

Unknown types are rejected on ingest. Fields whose name contains `password` or `secret` are rendered as masked inputs regardless of type.

### Output types

`text`, `number`, `json`, `table`, `markdown`, `url`, `file`.

## Runtime defaults

What a single app run gets on Floom Cloud. Self-host defaults match but every limit is configurable.

| Resource | Cloud default | Notes |
|---|---|---|
| Memory per run | **512 MB** | Container RSS cap. Hit = OOM-killed. |
| CPU per run | **1 vCPU** | Docker `--cpus=1` equivalent. |
| Sync run timeout | **5 min** | `POST /api/run` and `POST /api/:slug/run` stop at 300s. |
| Async job timeout | **30 min** | Default for `POST /api/:slug/jobs`. Override per-app. |
| Build timeout | **10 min** | First deploy stops at 600s. |
| Network | **bridge** | Outbound yes. No inbound, no host access. |

Source: [`apps/server/src/services/runner.ts`](https://github.com/floomhq/floom/blob/main/apps/server/src/services/runner.ts), [`apps/web/src/assets/docs/limits.md`](https://github.com/floomhq/floom/blob/main/apps/web/src/assets/docs/limits.md).

## Rate limits

| Scope | Limit | Applies to |
|---|---|---|
| Anon IP | 150 runs / hour | All apps combined. |
| Signed-in user | 300 runs / hour | All apps combined. |
| `(IP, app)` pair | 500 runs / hour | Per combo. |
| Demo BYOK | 5 free runs / 24h / IP / demo slug | Launch demos only. BYOK unlocks unlimited. |

Self-host: uncapped by default, configurable via `FLOOM_RATE_LIMIT_*` env vars.

## Lifecycle of a run

1. Client calls `POST /api/:slug/run` with JSON inputs.
2. Floom validates inputs against the manifest's input schema.
3. For hosted apps: fresh container starts from the app's pre-built image. Secrets injected as env vars. File inputs mounted read-only at `/floom/inputs/`.
4. For proxied apps: HTTP call to upstream with secrets merged into auth header / query / cookie.
5. App writes a final line to stdout: `__FLOOM_RESULT__{"ok": true, "outputs": {...}}`.
6. Floom parses the marker line, stores the run, returns structured JSON.

Long-running work: use async jobs.

```bash
# Enqueue
curl -X POST https://api.floom.dev/api/openpaper/jobs \
  -H "Authorization: Bearer $FLOOM_KEY" \
  -d '{"action":"generate_paper","inputs":{...}}'

# Poll
curl https://api.floom.dev/api/openpaper/jobs/<job_id>
```

Default async timeout: 30 minutes. Optional webhook delivery on completion.

## File inputs

For `type: file`, the wire format is a `FileEnvelope`:

```json
{
  "__file": true,
  "name": "data.csv",
  "mime_type": "text/csv",
  "size": 512,
  "content_base64": "..."
}
```

The container sees the file mounted at `/floom/inputs/<name>` (read-only). The `inputs.<name>` string the app receives is the file path, not the content.

## Output marker protocol

Your app MUST end stdout with one line:

```
__FLOOM_RESULT__{"ok": true, "outputs": {"rows": [...], "total": 47}}
```

Anything before that line becomes run logs. If your app errors, emit:

```
__FLOOM_RESULT__{"ok": false, "error": "Gemini quota exhausted"}
```

Floom stores `ok: false` as a failed run. Exit codes are also respected: non-zero = failed.

## Related pages

- [/docs/mcp-install](/docs/mcp-install)
- [/docs/self-host](/docs/self-host)
- [/docs/api-reference](/docs/api-reference)
- [/protocol](/protocol) — full protocol spec
