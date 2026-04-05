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
API_KEY=$(python3 -c "import json; print(json.load(open('$HOME/.claude/floom-config.json'))['api_key'])")
PLATFORM=$(python3 -c "import json; print(json.load(open('$HOME/.claude/floom-config.json')).get('platform_url','https://dashboard.floom.dev'))")
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

### Step 5: Test run

Before deploying, run the code in a sandbox to verify it works.

Determine test inputs:

- If the manifest has `scheduleInputs`, use those as defaults
- If inputs have `default` values, use those
- Otherwise, ask the user for test input values

```bash
# Write files to temp dir
mkdir -p /tmp/floom-deploy
cat > /tmp/floom-deploy/automation.py << 'PYEOF'
[ADAPTED CODE]
PYEOF

cat > /tmp/floom-deploy/manifest.json << 'JSONEOF'
[GENERATED MANIFEST]
JSONEOF

cat > /tmp/floom-deploy/inputs.json << 'JSONEOF'
[TEST INPUTS]
JSONEOF

# Build the JSON payload safely (avoids shell interpolation breaking JSON)
python3 -c "
import json
code = open('/tmp/floom-deploy/automation.py').read()
manifest = json.load(open('/tmp/floom-deploy/manifest.json'))
inputs = json.load(open('/tmp/floom-deploy/inputs.json'))
payload = json.dumps({'code': code, 'manifest': manifest, 'inputs': inputs})
open('/tmp/floom-deploy/test-payload.json', 'w').write(payload)
"

# Submit test run
API_KEY=$(python3 -c "import json; print(json.load(open('$HOME/.claude/floom-config.json'))['api_key'])")
PLATFORM=$(python3 -c "import json; print(json.load(open('$HOME/.claude/floom-config.json')).get('platform_url','https://dashboard.floom.dev'))")

TEST_RESULT=$(curl -s -X POST "$PLATFORM/api/test" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/floom-deploy/test-payload.json)

# The API waits up to 10s for results by default.
# Parse the response — it may already contain the result.
RESPONSE_FILE="/tmp/floom-deploy/test-response.json"
echo "$TEST_RESULT" > "$RESPONSE_FILE"

TEST_RUN_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['testRunId'])" <<< "$TEST_RESULT")
STATUS=$(python3 -c "import json; print(json.load(open('$RESPONSE_FILE')).get('status', 'pending'))")

echo "Test run: $TEST_RUN_ID (status: $STATUS)"
```

If the API returned a terminal status (`success`, `error`, `timeout`), the result is already in the response. If still `pending`/`running`, poll for completion (every 3s, timeout after 2 min):

```bash
if [ "$STATUS" != "success" ] && [ "$STATUS" != "error" ] && [ "$STATUS" != "timeout" ]; then
  TIMEOUT=120
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    sleep 3
    ELAPSED=$((ELAPSED + 3))
    curl -s "$PLATFORM/api/test-runs/$TEST_RUN_ID" \
      -H "Authorization: Bearer $API_KEY" \
      -o "$RESPONSE_FILE"

    STATUS=$(python3 -c "
import json
try:
    d = json.load(open('$RESPONSE_FILE'))
    print(d.get('status', 'unknown'))
except: print('pending')
")
    case "$STATUS" in
      success|error|timeout) break ;;
      pending|running) ;;
      *) echo "Unexpected status: $STATUS"; cat "$RESPONSE_FILE"; break ;;
    esac
  done
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "Timed out after ${TIMEOUT}s waiting for test run to complete."
  fi
fi

# Print results (from inline response or poll response)
python3 -c "
import json
d = json.load(open('$RESPONSE_FILE'))
# If result came inline from /api/test, the actual doc is nested under 'result'
doc = d.get('result', d)
print(f\"Status: {doc.get('status', 'unknown')}\")
if doc.get('outputs'): print(f\"Outputs: {json.dumps(doc['outputs'], indent=2)}\")
if doc.get('error'): print(f\"Error: {doc['error']}\")
if doc.get('logs'): print(f\"Logs:\n{doc['logs']}\")
"
```

**If test fails:**

```
Test failed: [error message]

Want me to fix the issue and re-test?
```

Fix the code, re-run Step 5 from the beginning.

**If test succeeds:**

```
Test passed! Here are the results:

  Outputs: [outputs from test]

Deploy this automation? (y/n)
```

Wait for user confirmation before proceeding to Step 6.

### Step 6: Deploy (only after successful test)

```bash
DEPLOY_RESULT=$(curl -s -X POST "$PLATFORM/api/deploy" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"testRunId\": \"$TEST_RUN_ID\"}")

echo "$DEPLOY_RESULT"
```

On success (JSON with `id` and `url`):

```
Deployed! Your automation is live:

  [URL from response]

Share this URL with your team — they can run it directly, no terminal needed.
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
5. Test the updated code:

```bash
# Build payload (same as deploy, but with automationId)
python3 -c "
import json
code = open('/tmp/floom-deploy/automation.py').read()
manifest = json.load(open('/tmp/floom-deploy/manifest.json'))
inputs = json.load(open('/tmp/floom-deploy/inputs.json'))
payload = json.dumps({'code': code, 'manifest': manifest, 'inputs': inputs, 'automationId': '[AUTOMATION_ID]'})
open('/tmp/floom-deploy/test-payload.json', 'w').write(payload)
"

TEST_RESULT=$(curl -s -X POST "$PLATFORM/api/test" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/floom-deploy/test-payload.json)

TEST_RUN_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['testRunId'])" <<< "$TEST_RESULT")
STATUS=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('status', 'pending'))" <<< "$TEST_RESULT")
echo "$TEST_RESULT" > /tmp/floom-deploy/test-response.json
```

6. The API waits up to 10s for results by default. If `STATUS` is already terminal (`success`/`error`/`timeout`), skip to results. Otherwise, poll for completion (same polling loop as Step 5 in Deploy Flow — every 3s, 2 min timeout)

**If test fails:** fix and re-test.

**If test succeeds:**

```
Test passed! Update to new version? (y/n)
```

7. Deploy update (only after user confirms):

```bash
curl -s -X POST "$PLATFORM/api/automations/[AUTOMATION_ID]/update" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"testRunId\": \"$TEST_RUN_ID\", \"changeNote\": \"...\"}"
```

On success: "Updated to v[N]. Same URL, new code."

---

## Rollback Flow

If the user wants to revert to a previous version:

```bash
curl -s -X POST "$PLATFORM/api/automations/[AUTOMATION_ID]/rollback" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"versionId": "[VERSION_ID]"}'
```

---

## Error Messages

| Error                         | What to say                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| 400 Validation failed         | "The code has an issue: [message]. Let me fix that."                           |
| 400 Test run did not succeed  | "Can't deploy — the test run didn't pass. Let me fix the code and re-test."    |
| 400 Test run already deployed | "That test run was already used for a deploy. Run a new test first."           |
| 401 Unauthorized              | "Your API key isn't working. Get a new one from dashboard.floom.dev/settings." |
| 403 Forbidden                 | "You don't have permission to update this automation."                         |
| Rate limit exceeded           | "You've hit the limit of 50 runs/hour. Try again in a bit."                    |
| Missing secret                | "This automation needs [SECRET_NAME] but it's not stored. Want to add it now?" |
