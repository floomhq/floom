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

## 3. Missing output write

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
