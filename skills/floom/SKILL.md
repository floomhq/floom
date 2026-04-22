---
name: floom
description: Build and deploy AI apps to Floom from Claude Code. Use when the user says "deploy to Floom", "publish this to Floom", "/floom-init", "/floom-deploy", or "/floom-status". Creates a floom.yaml manifest, publishes the app to floom.dev, and returns a live URL plus an MCP install snippet.
---

# Floom Skill

Three commands to ship an AI app to Floom without leaving the terminal:

- `/floom-init` — scaffold a `floom.yaml` in the current directory
- `/floom-deploy` — publish the current app, return live URL + MCP snippet
- `/floom-status` — list the caller's published apps and recent runs

Docs: https://floom.dev/docs. Examples: https://github.com/floomhq/floom/tree/main/examples.

---

## One-time setup (auth)

Config lives at `~/.claude/floom-skill-config.json`. Check it on first run:

```bash
cat ~/.claude/floom-skill-config.json 2>/dev/null || echo "NOT_CONFIGURED"
```

If `NOT_CONFIGURED`, prompt the user:

```
Floom needs an API token. Two options:

  1. Cloud (floom.dev): the API-key UI is coming in v1.1. Until then, sign in at
     https://floom.dev/login, open DevTools > Application > Cookies, and copy
     the value of `better-auth.session_token`. token_type is "session_cookie".

  2. Self-host: paste FLOOM_AUTH_TOKEN from your Floom server env. token_type
     is "bearer".

Instance URL? (https://floom.dev, https://preview.floom.dev, or http://localhost:3051)
```

Write the config (chmod 600). Never hardcode values:

```bash
cat > ~/.claude/floom-skill-config.json <<JSON
{"base_url": "BASE_URL", "token": "TOKEN", "token_type": "session_cookie_or_bearer"}
JSON
chmod 600 ~/.claude/floom-skill-config.json
```

Verify with `bash skills/floom/scripts/floom-api.sh GET /api/health`. Expect `{"status":"ok",...}`. On HTTP 401, clear the config and re-prompt.

---

## `/floom-init` — scaffold a new app

Ask one question at a time:

1. "What's the app called? (e.g. 'Lead Scorer')"
2. "One-sentence description?"
3. "Type? (a) wraps an existing OpenAPI service, or (b) custom Python code"
4. If `a`: "OpenAPI spec URL?"
5. If `b`: "Secrets needed? (comma-separated, e.g. GEMINI_API_KEY)"

Derive slug: lowercase, dashes only, matches `^[a-z0-9][a-z0-9-]{0,47}$`.

### OpenAPI scaffold

Validate the spec with `/api/hub/detect`:

```bash
bash skills/floom/scripts/floom-api.sh POST /api/hub/detect \
  '{"openapi_url":"<URL>","slug":"<SLUG>","name":"<NAME>"}'
```

Write `floom.yaml`:

```yaml
name: <NAME>
slug: <SLUG>
description: <DESCRIPTION>
type: proxied
openapi_spec_url: <URL>
visibility: private
manifest_version: "2.0"
```

### Python scaffold (lead-scorer shape)

Write `floom.yaml`:

```yaml
name: <NAME>
slug: <SLUG>
description: <DESCRIPTION>
category: custom
runtime: python
actions:
  run:
    label: Run
    description: <DESCRIPTION>
    inputs:
      - {name: input, label: Input, type: textarea, required: true}
    outputs:
      - {name: result, label: Result, type: text}
python_dependencies: []
secrets_needed: [<COMMA_SEPARATED_SECRETS>]
manifest_version: "2.0"
```

Also write a stub `main.py`:

```python
import json, sys
def run(input: str) -> dict:
    return {"result": f"Echo: {input}"}
if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    out = run(**payload.get("inputs", {}))
    print("__FLOOM_RESULT__" + json.dumps(out))
```

And a `Dockerfile` mirroring `examples/lead-scorer/Dockerfile`: `FROM python:3.11-slim`, copy `main.py`, `CMD ["python","main.py"]`.

Stop after scaffolding. Do NOT deploy from `/floom-init`.

---

## `/floom-deploy` — publish to Floom

### 1. Validate

```bash
test -f floom.yaml || { echo "No floom.yaml in $(pwd). Run /floom-init first."; exit 1; }
bash skills/floom/scripts/floom-validate.sh floom.yaml
```

### 2. Branch on app type

**Proxied (OpenAPI):** call `POST /api/hub/ingest`.

```bash
SLUG=$(yq -r .slug floom.yaml)
NAME=$(yq -r .name floom.yaml)
DESC=$(yq -r .description floom.yaml)
SPEC=$(yq -r .openapi_spec_url floom.yaml)
VIS=$(yq -r '.visibility // "private"' floom.yaml)
bash skills/floom/scripts/floom-api.sh POST /api/hub/ingest \
  "{\"openapi_url\":\"$SPEC\",\"slug\":\"$SLUG\",\"name\":\"$NAME\",\"description\":\"$DESC\",\"visibility\":\"$VIS\"}"
```

On 200/201, print:

```
Published: <name>
  App page:    https://floom.dev/p/<slug>
  MCP URL:     https://floom.dev/mcp/app/<slug>
  Owner view:  https://floom.dev/me/apps/<slug>

Add to Claude Desktop config:
  {"mcpServers":{"floom-<slug>":{"command":"npx","args":["-y","mcp-remote","https://floom.dev/mcp/app/<slug>"]}}}
```

On 409 `slug_taken`: show the response `suggestions` array, ask the user to pick one, retry.

**Python/Node (custom code):** no public publish HTTP API yet. Print:

```
Custom Python/Node apps can't be published via HTTP yet. Options:
  1. Open a PR against floomhq/floom with your dir under examples/<slug>/.
  2. Wrap your code in a thin HTTP server, publish an OpenAPI spec, and use /floom-deploy with that URL.
Want me to draft the PR for option 1?
```

### 3. Dry-run flag

If the user passes `--dry-run`, set `FLOOM_DRY_RUN=1` on the api call. The wrapper prints the exact request without sending.

---

## `/floom-status` — my apps + recent runs

```bash
bash skills/floom/scripts/floom-api.sh GET /api/hub/mine
bash skills/floom/scripts/floom-api.sh GET /api/me/runs?limit=10
```

Render two tables: `slug / visibility / status / runs / last_run`, and `run_id / app / action / status / duration`. If both responses are empty:

```
No apps yet. Run /floom-init to scaffold one.
```

---

## Error handling

| HTTP | Code | What to say |
|------|------|-------------|
| 401 | auth_required | "Floom token isn't working. Delete ~/.claude/floom-skill-config.json and retry to re-auth." |
| 400 | invalid_body | Show `details` from response, point at the bad field. |
| 400 | detect_failed | "Couldn't reach or parse <url>. Does `curl <url>` return valid JSON/YAML?" |
| 409 | slug_taken | Show `suggestions`, ask user to pick, retry. |
| 5xx | — | "Floom returned <code>. Retry in a minute or check https://floom.dev/status." |

Never retry on 4xx. 5xx may retry once with 2s backoff.

---

## Gaps flagged for launch

1. **No API-key UI.** `/me/settings#studio` shows "Personal access tokens — Coming v1.1". Skill falls back to pasting the better-auth session cookie.
2. **No publish endpoint for custom runtimes.** `POST /api/hub/ingest` only accepts OpenAPI URLs; Python/Docker apps like `lead-scorer` get seeded from `examples/` on server boot. The skill routes users to open a PR.
3. **No server-side dry-run.** Skill simulates dry-run client-side via `FLOOM_DRY_RUN=1`. A `?dry_run=1` on `/api/hub/ingest` would let users preview the parsed manifest.
