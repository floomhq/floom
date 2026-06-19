# Anti-Patterns — Things Worker Author Must Never Do

These are production-observed failure modes. Avoiding them is non-negotiable.

## 1. Secrets in code

**Never** hardcode API keys, tokens, or passwords in `run.py` or `SKILL.md`.

```python
# BAD
client = OpenAI(api_key="your-key-goes-here")  # hardcoded — never do this

# GOOD — declare in exec.secrets and read from env
client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
```

Declare the secret in `exec.secrets`:
```yaml
exec:
  secrets:
    - "OPENAI_API_KEY"
```

## 2. Unbounded loops

**Never** write loops with no exit condition. Always bound iteration counts.

```python
# BAD
while True:
    result = client.chat.completions.create(...)
    if check_done(result):
        break

# GOOD
for attempt in range(5):
    result = client.chat.completions.create(...)
    if check_done(result):
        break
```

## 3. `connections:` nested under `exec:`

**Never** put `connections:` inside the `exec:` block. It is a **top-level field**, a sibling of `exec:`, not a child.

```yaml
# BAD — Pydantic silently drops connections nested under exec
exec:
  entry: "SKILL.md"
  runner: "e2b"
  connections:          # ← WRONG PLACEMENT
    - app: "gmail"
      allowed_tools: [GMAIL_FETCH_EMAILS]

# GOOD — connections at top level, exec has no connections key
connections:
  - app: "gmail"
    allowed_tools:
      - GMAIL_FETCH_EMAILS
exec:
  entry: "SKILL.md"
  runner: "e2b"
```

When `connections:` is under `exec:`, the server silently drops it, the agent never receives Gmail/Calendar/Slack tools, and the run fails with "worker not directly invokable" or "missing_connection". This is the single most common generated-worker failure.

## 4. Missing output write

**Never** finish a `run.py` without writing declared outputs. Undeclared outputs are invisible to the platform.

```python
# BAD — return value not captured as output
return {"content": "..."}

# GOOD — write to the declared path
os.makedirs("out", exist_ok=True)
Path("out/result.md").write_text(content)
```

In SKILL.md, always end with `finish_with_outputs({...})`.

## 4. Overly broad connections

**Never** declare a connection unless the worker actually uses it.

```yaml
# BAD
connections:
  - gmail
  - hubspot
  - slack
  - github

# GOOD — only what the task actually needs
connections:
  - github
```

For Composio workers, prefer per-worker tool scope over full app access:

```yaml
# BAD — lets the worker call any Gmail tool
connections:
  - gmail

# GOOD — this worker can only read messages through the proxy
connections:
  - app: gmail
    allowed_tools:
      - GMAIL_FETCH_EMAILS
      - GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID
```

Never call Composio through a local subprocess:

```python
# BAD — the Composio CLI is not installed in E2B
subprocess.run(["composio", "execute", "GMAIL_FETCH_EMAILS"])

# GOOD — use the stdlib proxy helper from RUN_PY_TEMPLATE.py
composio_execute("gmail", "GMAIL_FETCH_EMAILS", {"query": "is:unread"})
```

## 5. Generic names

**Never** use vague names like `my-worker`, `test`, `automation`, `new-worker`.

```yaml
# BAD
name: "automation"
title: "Automation Worker"

# GOOD
name: "github-pr-digest"
title: "GitHub PR Digest"
```

## 6. Schedules without user request

**Never** set `trigger.type: "schedule"` unless the prompt explicitly mentions timing (e.g., "every morning", "weekly", "on Mondays").

```yaml
# BAD — prompt says "sends an email" — you added schedule without being asked
trigger:
  type: schedule
  cron: "0 9 * * *"

# GOOD — default to manual
trigger:
  type: manual
```

## 7. Hypothetical features

**Never** add inputs or outputs that weren't asked for. YAGNI.

```yaml
# BAD — prompt asked for a digest, not language/format options
inputs:
  - name: language
    ...
  - name: output_format
    ...
  - name: include_closed_prs
    ...

# GOOD — one input, what was asked
inputs:
  - name: since_days
    ...
```

## 8. system_worker: true on user workers

**Never** set `system_worker: true` on a user-created worker. That flag is reserved for platform-internal workers (like worker-author itself).

```yaml
# BAD
system_worker: true

# GOOD — omit entirely or set false
is_example: false
```

## 9. Wrong exec.runtime

**Never** use `exec.runtime: "skill"` with `exec.entry: "run.py"`. Use the correct pair:

| Entry | Runtime |
|-------|---------|
| `SKILL.md` | `skill` |
| `run.py` | `python311` |
| `run.js` | `node22` |
| `run.sh` | `bash` |

## 10. Missing exec.command for script mode

**Never** omit `exec.command` when using script mode.

```yaml
# BAD — missing command
exec:
  entry: run.py
  runtime: python311

# GOOD
exec:
  entry: run.py
  command: python run.py
  runtime: python311
  runner: e2b
```

## 11. Swallowing errors silently

**Never** catch exceptions and return a success response with empty content. Fail loudly.

```python
# BAD
try:
    result = call_api()
except:
    result = "Error occurred"  # operator never knows what went wrong

# GOOD
try:
    result = call_api()
except Exception as exc:
    raise RuntimeError(f"API call failed: {exc}") from exc
```

## 12. Non-YAML strings

**Never** return JSON or Python dicts as the `worker_yml` field. It must be a valid YAML string.

```json
// BAD
{"worker_yml": {"schema_version": "0.3", ...}}

// GOOD
{"worker_yml": "schema_version: \"0.3\"\nname: \"my-worker\"..."}
```
