---
name: floom
description: |
  Deploy Python scripts to the cloud and share them with your team.
  Use when: "deploy automation", "deploy python script", "floom",
  "schedule a script", "update automation".
---

# Floom

Deploy Python scripts as cloud automations — no infra required.

## Setup

Your API key is stored in `~/.claude/floom-config.json`.
If it's not there yet, get it from **dashboard.floom.dev/settings**.

```bash
# Check config
cat ~/.claude/floom-config.json 2>/dev/null || echo "NOT_CONFIGURED"
```

If NOT_CONFIGURED:

```
Paste your Floom API key from dashboard.floom.dev/settings:
```

Then write it:

```bash
echo '{"api_key": "PASTE_KEY_HERE", "platform_url": "https://dashboard.floom.dev"}' > ~/.claude/floom-config.json
```

---

## Deploy Flow (`/floom`)

### Step 1: Get the script

Get the user's Python script. Be flexible:

- If the user points to a file, read it
- If the user pastes code, use that
- If unclear, ask: "Which Python script do you want to deploy?"

### Step 2: Adapt to platform format

The platform requires a `run()` function that takes inputs as parameters and returns a dict.

**If the script already has a `run()` function:** validate it returns a dict and move on.

**If it doesn't:** adapt the script:

1. Identify inputs — look for hardcoded values, config variables, CLI args (`sys.argv`, `argparse`), environment variables (`os.environ`), or constants that should be parameterized
2. Identify outputs — look for print statements, return values, file writes, or data that represents the result
3. Wrap the script body in `def run(param1, param2, ...) -> dict:` with inputs as parameters
4. Capture outputs as a return dict: `return {"key1": value1, "key2": value2}`
5. Preserve all imports and helper functions outside `run()`

**Rules:**

- Function named exactly `run`
- All inputs are function parameters (no globals, no CLI args, no env vars for user inputs)
- Returns a dict — keys match manifest output names exactly
- No `exec(..., globals())` — subprocess isolation is handled by the platform
- Secrets (API keys, tokens) stay as `os.environ["SECRET_NAME"]` — the platform injects them

**Dependency selection:**

- Anthropic SDK: `anthropic` (always available in E2B)
- Data/CSV/Excel: `pandas`, `openpyxl`
- PDF parsing: `PyMuPDF`
- HTTP requests: `requests`, `httpx` (always available)
- Unknown deps: list them in `python_dependencies` — platform pip installs at run time

### Step 3: Generate manifest

Derive the manifest from the adapted code:

```json
{
  "name": "Automation Name",
  "description": "One-sentence description",
  "schedule": "0 9 * * 1",
  "scheduleInputs": { "param1": "default_value" },
  "inputs": [
    {
      "name": "param_name",
      "label": "Human Label",
      "type": "text|textarea|url|file|integer|enum",
      "description": "What to put here",
      "required": true,
      "options": ["opt1", "opt2"],
      "accept": ".pdf,.csv,.txt",
      "min": 1,
      "max": 100,
      "default": "default_value"
    }
  ],
  "outputs": [
    {
      "name": "output_key",
      "label": "Human Label",
      "type": "text|table|integer",
      "columns": ["col1", "col2"]
    }
  ],
  "secrets_needed": ["ANTHROPIC_API_KEY"],
  "python_dependencies": ["anthropic", "pandas"],
  "manifest_version": "1.0"
}
```

**Input type guide:**

- `text` — short strings (name, query, ID)
- `textarea` — long text (transcript, document, prompt) — use for 500+ char inputs
- `url` — links (CSV URL, API endpoint)
- `file` — file upload (.pdf, .csv, .xlsx) — function receives R2 URL string
- `integer` — numbers (limit, count, year)
- `enum` — fixed choices (tone: professional/casual)

**Output type guide:**

- `text` — string output
- `table` — list of dicts (include `columns` array)
- `integer` — numeric output
- `html` — rendered HTML
- `pdf` — PDF document

For schedule: convert natural language to cron directly. "Every Monday at 9am" -> `0 9 * * 1`. If scheduled and has required inputs, set `scheduleInputs` with defaults.

Only ask the user questions if something is genuinely ambiguous (e.g., can't tell what the inputs should be). Otherwise, infer everything from the code.

### Step 4: Handle secrets

Read config:

```bash
API_KEY=$(cat ~/.claude/floom-config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
PLATFORM=$(cat ~/.claude/floom-config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('platform_url','https://dashboard.floom.dev'))")
```

For each secret in `secrets_needed`, ask one at a time:

```
This automation needs ANTHROPIC_API_KEY. Do you have one?
If yes: paste it and I'll store it securely for all your workspace's automations.
If no: I'll skip this — you can add it in Settings before running.
```

Store each secret:

```bash
curl -s -X POST "$PLATFORM/api/secrets" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "SECRET_NAME", "value": "SECRET_VALUE"}'
```

### Step 5: Deploy

```bash
# Write files to temp dir
mkdir -p /tmp/floom-deploy
cat > /tmp/floom-deploy/automation.py << 'PYEOF'
[ADAPTED CODE]
PYEOF

cat > /tmp/floom-deploy/manifest.json << 'JSONEOF'
[GENERATED MANIFEST]
JSONEOF

# Deploy
API_KEY=$(cat ~/.claude/floom-config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
PLATFORM=$(cat ~/.claude/floom-config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('platform_url','https://dashboard.floom.dev'))")

curl -s -X POST "$PLATFORM/api/deploy" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"code\": $(python3 -c 'import json,sys; print(json.dumps(open("/tmp/floom-deploy/automation.py").read()))'), \"manifest\": $(cat /tmp/floom-deploy/manifest.json)}"
```

On success (JSON with `id` and `url`):

```
Deployed! Your automation is live:

  [URL from response]

Share this URL with your team — they can run it directly, no terminal needed.

Want me to run a test?
```

On error:

```
Deploy failed: [error message]

Want me to fix the issue and try again?
```

---

## Update Flow (`/floom update [url or name]`)

1. Fetch current code from platform (ask user to paste current code or re-describe changes)
2. Show existing code, ask what to change
3. Apply changes to the function
4. Ask: "What changed? (optional note for version history)"
5. Deploy update:

```bash
curl -s -X POST "$PLATFORM/api/automations/[AUTOMATION_ID]/update" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"code\": ..., \"manifest\": ..., \"changeNote\": \"...\"}"
```

On success: "Updated to v[N]. Same URL, new code."

---

## Test Run Flow

After deploy or update, offer to test:

```bash
curl -s -X POST "$PLATFORM/api/automations/[ID]/run" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"inputs": {"param1": "test_value"}}'
```

Poll for completion (every 3s, up to 5 min):

```bash
while true; do
  STATUS=$(curl -s "$PLATFORM/api/runs/[RUN_ID]" -H "Authorization: Bearer $API_KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'])")
  if [ "$STATUS" = "success" ] || [ "$STATUS" = "error" ] || [ "$STATUS" = "timeout" ]; then
    curl -s "$PLATFORM/api/runs/[RUN_ID]" -H "Authorization: Bearer $API_KEY"
    break
  fi
  sleep 3
done
```

---

## Error Messages

| Error                 | What to say                                                                    |
| --------------------- | ------------------------------------------------------------------------------ |
| 400 Validation failed | "The code has an issue: [message]. Let me fix that."                           |
| 401 Unauthorized      | "Your API key isn't working. Get a new one from dashboard.floom.dev/settings." |
| 403 Forbidden         | "You don't have permission to update this automation."                         |
| Rate limit exceeded   | "You've hit the limit of 50 runs/hour. Try again in a bit."                   |
| Missing secret        | "This automation needs [SECRET_NAME] but it's not stored. Want to add it now?" |
