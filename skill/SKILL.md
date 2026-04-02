# Deploy Skill

Deploy Python automations and share them with your team — no infra required.

## Setup

Your API key is stored in `~/.claude/deploy-skill-config.json`.
If it's not there yet, get it from **yourplatform.com/settings**.

```bash
# Check config
cat ~/.claude/deploy-skill-config.json 2>/dev/null || echo "NOT_CONFIGURED"
```

If NOT_CONFIGURED:
```
Paste your Deploy Skill API key from yourplatform.com/settings:
```
Then write it:
```bash
echo '{"api_key": "PASTE_KEY_HERE", "platform_url": "https://yourplatform.com"}' > ~/.claude/deploy-skill-config.json
```

---

## Deploy Flow (`/deploy-skill`)

Run this when the user wants to deploy a new automation.

### Step 1: Gather requirements

Ask the user to describe the automation. One question at a time:

1. "What does this automation do? Describe it in plain language."
2. "What information does it need as input? (e.g., a URL, a text paste, a file)"
3. "What should the output look like? (a table, a number, a text summary)"
4. "Which department is this for? (Sales / CS / Marketing / Finance / Product / Other)"
5. "Does it need any external APIs or services? (e.g., Salesforce, Anthropic, Clearbit)"
6. "Should it run automatically on a schedule? (e.g., every Monday at 9am, daily at 8am)"

For the schedule question: if yes, convert to cron directly:
- "Every Monday at 9am" → `0 9 * * 1`
- "Daily at 8am" → `0 8 * * *`
- No confirmation needed — just use the cron string.

If scheduled and has required inputs: ask "What default values should it use when it runs automatically?"

### Step 2: Generate code

Write a Python function with this exact signature:

```python
def run(param1: type, param2: type = default) -> dict:
    """
    One-sentence description.

    Args:
        param1: Description
        param2: Description (default: X)

    Returns:
        key1: Description
        key2: Description
    """
    # implementation
    return {"key1": value1, "key2": value2}
```

**Rules:**
- Function named exactly `run`
- All inputs are function parameters (no globals)
- Returns a dict — keys match manifest output names exactly
- No `exec(..., globals())` — subprocess isolation is handled by the platform
- Use `# type: ignore` only if truly necessary

**Dependency selection:**
- Anthropic SDK: `anthropic` (always available in E2B `enrichment` template)
- Data/CSV/Excel: `pandas`, `openpyxl` (in E2B `data-science` template)
- PDF parsing: `PyMuPDF` (in E2B `data-science` template)
- HTTP requests: `requests`, `httpx` (always available)
- Unknown deps: list them in `python_dependencies` — platform pip installs at run time

### Step 3: Generate manifest

```json
{
  "name": "Automation Name",
  "description": "One-sentence description",
  "department": "sales|cs|marketing|finance|product|other",
  "schedule": "0 9 * * 1",
  "scheduleInputs": {"param1": "default_value"},
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
  "secrets_needed": ["ANTHROPIC_API_KEY", "SALESFORCE_TOKEN"],
  "python_dependencies": ["anthropic", "pandas"],
  "manifest_version": "1.0"
}
```

**Input type guide:**
- `text` — short strings (name, query, ID)
- `textarea` — long text (transcript paste, document, prompt) — use for 500+ char inputs
- `url` — links (CSV URL, API endpoint, image URL)
- `file` — file upload (.pdf, .csv, .xlsx, image) — function receives R2 URL string
- `integer` — numbers (limit, count, year)
- `enum` — fixed choices (tone: professional/casual, format: summary/bullets)

### Step 4: Show for review

Show both files to the user. Say:
```
Here's what I'll deploy:

**automation.py** — [X lines]
[code block]

**manifest.json**
[json block]

Does this look right? I'll deploy when you confirm.
```

### Step 5: Handle secrets

Read config:
```bash
cat ~/.claude/deploy-skill-config.json
```

Check which secrets from `secrets_needed` the user already has stored.
Call the platform to get stored secret names:
```bash
API_KEY=$(cat ~/.claude/deploy-skill-config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
PLATFORM=$(cat ~/.claude/deploy-skill-config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('platform_url','https://yourplatform.com'))")
# Note: check stored secrets via the platform's HTTP action (once deployed)
```

For each missing secret, ask one at a time:
```
This automation needs ANTHROPIC_API_KEY. Do you have one?
If yes: paste it and I'll store it securely for all your org's automations.
If no: I'll skip this for now — you can add it in Settings before running.
```

Store each secret:
```bash
curl -s -X POST "$PLATFORM/api/secrets" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "SECRET_NAME", "value": "SECRET_VALUE"}'
```

### Step 6: Deploy

```bash
# Write files to temp dir
mkdir -p /tmp/deploy-skill-deploy
cat > /tmp/deploy-skill-deploy/automation.py << 'PYEOF'
[GENERATED CODE]
PYEOF

cat > /tmp/deploy-skill-deploy/manifest.json << 'JSONEOF'
[GENERATED MANIFEST]
JSONEOF

# Deploy
API_KEY=$(cat ~/.claude/deploy-skill-config.json | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])")
PLATFORM=$(cat ~/.claude/deploy-skill-config.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('platform_url','https://yourplatform.com'))")

curl -s -X POST "$PLATFORM/api/deploy" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"code\": $(python3 -c 'import json,sys; print(json.dumps(open("/tmp/deploy-skill-deploy/automation.py").read()))'), \"manifest\": $(cat /tmp/deploy-skill-deploy/manifest.json)}"
```

On success (JSON with `id` and `url`):
```
✓ Deployed! Your automation is live:

  [URL from response]

Share this URL with your team. They can run it directly — no terminal needed.

Want me to run a test right now?
```

On error:
```
Deploy failed: [error message]

Want me to fix the issue and try again?
```

---

## Update Flow (`/deploy-skill update [url or name]`)

1. Fetch current code from platform (via Convex SDK — not HTTP, so ask user to paste current code or re-describe changes)
2. Show existing code, ask what to change
3. Regenerate function with changes
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

## Fix Flow (`/deploy-skill fix [url]`)

When a run errors, offer to debug:

1. Fetch the error from the platform
2. Analyze the traceback
3. Identify the fix
4. Update the automation via the update flow

---

## Canonical Examples

### Sales: Outbound Personalization
- Inputs: `leads_url` (url), `tone` (enum: professional/casual/direct), `max_leads` (integer, default 50)
- Output: `messages` (table: name, company, subject, body), `processed_count` (integer)
- Deps: anthropic, pandas, requests
- No schedule (manual)

### CS: Customer Health Score
- Inputs: `usage_csv_url` (url), `tickets_csv_url` (url)
- Output: `scores` (table: account, health_score, risk_flag), `at_risk_count` (integer)
- Deps: anthropic, pandas, requests

### Marketing: Content Repurposing
- Inputs: `blog_post` (textarea), `formats` (enum: all/linkedin/twitter/email)
- Output: `linkedin_post` (text), `tweet_thread` (text), `email_newsletter` (text)
- Deps: anthropic

### Finance: Pipeline Digest
- Inputs: `crm_url` (url), `min_amount` (integer, default 10000)
- Output: `deals` (table: name, stage, amount, owner), `pipeline_total` (integer)
- Schedule: `0 9 * * 1` (Monday 9am UTC)
- Schedule inputs: `{"crm_url": "stored_in_secrets_or_ask", "min_amount": 10000}`
- Deps: anthropic, requests

### Marketing: Competitor Monitoring
- Inputs: `competitor_urls` (textarea), `notify_email` (text)
- Output: `changes` (table: competitor, change_type, description), `change_count` (integer)
- Schedule: `0 8 * * 1` (Weekly Monday 8am)
- Deps: anthropic, requests

---

## Error Messages

| Error | What to say |
|-------|-------------|
| 400 Validation failed | "The code has an issue: [message]. Let me fix that." |
| 401 Unauthorized | "Your API key isn't working. Get a new one from yourplatform.com/settings." |
| 403 Forbidden | "You don't have permission to update this automation." |
| Rate limit exceeded | "You've hit the limit of 50 runs/hour. Try again in a bit." |
| Missing secret | "This automation needs [SECRET_NAME] but it's not stored. Want to add it now?" |
