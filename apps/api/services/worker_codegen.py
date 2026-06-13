"""Prompt-to-worker codegen: the LLM drafting subsystem.

The authoritative draft system prompt, the Composio app-keyword table, the
auth-method tables, the per-caller draft rate limiter (deque store + the
20/hour cap), and the helpers that call the codegen LLM, parse its JSON, detect
required connections, enrich auth methods, and repair the generated worker
manifest. Backs the draft-from-prompt / new-from-prompt / draft-and-create
routes. Extracted verbatim from main.py.

Self-contained: stdlib + fastapi only; the OpenAI client is passed in by the
route and ``codegen_model.chat_completion_codegen`` is imported lazily inside
``_call_draft_llm``. The draft-rate store is module state here and is reset
between tests by tests/conftest.py::_clear_rate_buckets. Never imports main.
"""

from __future__ import annotations

import collections
import hashlib
import json
import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request

logger = logging.getLogger("floom.api")


_COMPOSIO_APP_KEYWORDS: Dict[str, List[str]] = {
    "gmail": ["gmail"],
    "hubspot": ["hubspot"],
    "slack": ["slack"],
    "notion": ["notion"],
    "granola": ["granola"],
    "salesforce": ["salesforce", "sfdc"],
    "google-calendar": ["google calendar", "google cal"],
    "github": ["github"],
    "linear": ["linear"],
    "google-sheets": ["google sheets", "google sheet"],
    "airtable": ["airtable"],
    "stripe": ["stripe"],
    "jira": ["jira"],
    "figma": ["figma"],
    "discord": ["discord"],
    "twitter": ["twitter", "x.com"],
    "linkedin": ["linkedin"],
    "dropbox": ["dropbox"],
    "google-drive": ["google drive", "gdrive"],
    "apollo": ["apollo"],
}


_DRAFT_SYSTEM_PROMPT = """You are a Workeros worker designer. Given a natural-language description of an automation task, you output a skill bundle: a set of files that define the worker.

The bundle is returned via the `files` array. Every file has `path` (relative, e.g. "worker.yml") and `content` (UTF-8 string). The bundle MUST contain `worker.yml` at the root.

=== WORKER ARCHETYPES ===

The execution mode is derived from `exec.entry`:

- `entry: SKILL.md` -> agent mode. The platform runs an LLM tool loop with web_search, file tools, and any declared connections.
- `entry: run.py` (or `.sh` / `.js`) -> script mode. The platform just runs the file in an E2B sandbox.

Both shapes are first-class. Pick the one the task needs:

A - AGENT (pure reasoning, web research, agent-driven orchestration):
Use when: the task is reasoning, analysis, summarisation, writing, or anything that benefits from live web search.
Files: worker.yml + SKILL.md
worker.yml exec block:
  exec:
    entry: "SKILL.md"
    runtime: "skill"
    runner: "e2b"

B - SCRIPT (deterministic data transform, you control the code):
Use when: the task is a predictable data transform, file conversion, calculation, or API choreography you want to write yourself.
Files: worker.yml + run.py + requirements.txt
worker.yml exec block:
  exec:
    entry: "run.py"
    command: "python run.py"
    runtime: "python311"
    runner: "e2b"

Both are valid. A script that needs to call an LLM is just script-mode with an openai import; no separate "hybrid" mode is needed.

=== WORKED EXAMPLES ===

Example A (agent):
files:
  worker.yml: |
    schema_version: "0.3"
    name: "research-brief"
    title: "Research Brief Generator"
    description: "Generate a structured research brief from topic and audience."
    version: "0.1.0"
    entrypoint: "SKILL.md"
    targets: [generic]
    exec:
      entry: "SKILL.md"
      runtime: "skill"
      runner: "e2b"
      inputs:
      - name: topic
        kind: scalar
        type: string
        required: true
        label: "Research topic"
      - name: audience
        kind: scalar
        type: string
        required: false
        label: "Target audience"
        default: "general"
      outputs:
      - name: brief
        kind: file
        media_type: text/markdown
        path: out/brief.md
        required: true
        label: "Research brief"
    trigger:
      type: manual
  SKILL.md: |
    You are a research analyst. The user provides a topic, audience, and depth.
    Generate a structured markdown brief. Call write_output(name="brief", content="...").

Example B (script):
files:
  worker.yml: |
    schema_version: "0.3"
    name: "csv-enricher"
    title: "CSV Enricher"
    description: "Enrich a CSV file with computed columns."
    version: "0.1.0"
    targets: [generic]
    exec:
      entry: "run.py"
      runtime: "python311"
      runner: "e2b"
      command: "python run.py"
      inputs:
      - name: csv_data
        kind: file
        media_type: text/csv
        required: true
        label: "Input CSV"
      outputs:
      - name: result
        kind: file
        media_type: text/csv
        path: out/result.csv
        required: true
        label: "Enriched CSV"
    trigger:
      type: manual
  run.py: |
    import json, csv, io, os
    from pathlib import Path
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
    csv_path = inputs["csv_data"]            # FILE input -> value IS the path
    rows = list(csv.reader(open(csv_path, encoding="utf-8")))
    # ...enrich rows...
    os.makedirs("out", exist_ok=True)
    out_path = "out/result.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    Path("result.json").write_text(json.dumps({
        "status": "success",
        "outputs": {"result": out_path},
        "artifacts": [{"name": out_path, "relative_path": out_path, "type": "text/csv"}],
    }, encoding='utf-8'), encoding="utf-8")
  requirements.txt: |
    # stdlib only — no third-party deps needed

Example C (script that calls an LLM):
files:
  worker.yml: |
    schema_version: "0.3"
    name: "granola-hubspot-sync"
    title: "Granola to HubSpot Meeting Sync"
    description: "Fetch recent Granola meetings and update HubSpot with action items."
    version: "0.1.0"
    targets: [generic]
    exec:
      entry: "run.py"
      runtime: "python311"
      runner: "e2b"
      command: "python run.py"
      secrets:
      - GRANOLA_API_KEY
      connections:
      - hubspot
      outputs:
      - name: summary
        kind: file
        media_type: text/markdown
        path: out/summary.md
        required: true
        label: "Sync summary"
    trigger:
      type: schedule
      cron: "0 9 * * *"
      timezone: "Europe/Berlin"
  SKILL.md: |
    You are summarising a Granola meeting transcript into HubSpot-ready action items.
    Input: meeting transcript. Output JSON: {"summary": str, "action_items": [str]}.
  run.py: |
    import json, os
    from pathlib import Path
    from agent import run as run_agent
    from lib.granola_client import fetch_recent_meetings
    from lib.hubspot_client import create_note
    granola_key = os.environ.get("GRANOLA_API_KEY") or json.load(open("secrets.json")).get("GRANOLA_API_KEY", "")
    for meeting in fetch_recent_meetings(granola_key):
        result = run_agent("SKILL.md", input=meeting["transcript"])
        hubspot_token = os.environ.get("HUBSPOT_ACCESS_TOKEN", "")
        create_note(hubspot_token, meeting["id"], result["summary"])
    json.dump({"status": "completed", "outputs": {}, "artifacts": []}, open("result.json", "w"))
  lib/granola_client.py: |
    import requests
    def fetch_recent_meetings(api_key):
        resp = requests.get("https://api.granola.so/v1/meetings", headers={"Authorization": f"Bearer {api_key}"})
        return resp.json().get("meetings", [])
  lib/hubspot_client.py: |
    import requests
    def create_note(token, contact_id, body):
        requests.post("https://api.hubapi.com/crm/v3/objects/notes", json={"properties": {"hs_note_body": body}}, headers={"Authorization": f"Bearer {token}"})
  requirements.txt: |
    requests>=2.31

=== YAML RULES ===

The WorkerContract YAML must follow schema_version "0.3":
- `name`: lowercase slug 3-64 chars (letters, digits, hyphens). DERIVE IT FROM
  THE USER'S PROMPT — pick the primary verb + the primary noun/object and slugify
  them (e.g. "follow up with applicants" -> "applicant-followup", "summarise
  Granola meetings into HubSpot" -> "granola-hubspot-summary", "chase overdue
  invoices" -> "invoice-chaser"). The name MUST reflect THIS prompt's task.
  NEVER reuse a generic placeholder or a name from the examples above when it
  does not match the prompt. Two different prompts must produce two different names.
- `title`: human-readable title
- `description`: 1-2 sentence description (max 500 chars)
- ALWAYS double-quote every string scalar value (colons inside strings cause parse errors)
- `trigger.cron`: REQUIRED when trigger.type is "schedule". Default: "0 9 * * *" if not specified.
- `version`: semver like "0.1.0"
- `targets`: ["generic"]

=== INTEGRATION RULES ===

- Only include integrations for apps EXPLICITLY NAMED in the user's prompt.
- Choose ONE auth method per app: "oauth" (for Gmail/HubSpot/Slack/etc.) or "api_key" (for Granola/Apollo/Stripe/etc.)
- Never list the same app twice.

=== RESPONSE FORMAT ===

Respond with ONLY valid JSON (no markdown fences). The `files` array is mandatory. `worker_yml` must match the content of the worker.yml file.

{
  "files": [
    {"path": "worker.yml", "content": "<full YAML string>"},
    {"path": "SKILL.md", "content": "<agent instructions>"},
    {"path": "run.py", "content": "<python code>"},
    {"path": "requirements.txt", "content": "<pip deps>"}
  ],
  "worker_yml": "<same as files[0].content>",
  "skill_md": "<same as SKILL.md content or null>",
  "suggested_name": "<slug>",
  "suggested_title": "<human title>",
  "requirements": [
    {"app": "<app-slug>", "method": "oauth_or_api_key", "reason": "<one-line why>"}
  ],
  "available_methods_hint": {"<app-slug>": ["oauth", "api_key"]},
  "required_connections": ["<oauth-app-slugs>"],
  "required_secrets": ["<UPPER_SNAKE_CASE_API_KEY>"],
  "inputs": [{"name": "field_name", "type": "string", "label": "Human label", "required": false, "default": null}],
  "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
  "sample_input_json": "<JSON object string with a realistic value for EVERY input>"
}

=== SAMPLE INPUT RULE (so the worker is one-click runnable) ===
- ALWAYS return `sample_input_json`: a JSON object string with one realistic
  value for EVERY input the worker declares, scalar AND file.
- For a FILE input, the value MUST be the file's INLINE TEXT CONTENT as a string
  (e.g. a small CSV "name\\nalice\\nbob\\n"), NEVER a path or placeholder. The
  platform turns it into a real uploaded file so the operator can run the worker
  immediately with no manual upload.

=== RUN.PY CONTRACT (script mode — these EXACT mistakes crash generated workers) ===
When you emit run.py, follow this contract EXACTLY:
- Read inputs: `inputs = json.loads(Path("inputs.json").read_text(encoding='utf-8'))`. A SCALAR
  input is the literal value inline (use it directly, never open() it). A FILE
  input's value IS already the relative path (e.g. "inputs/csv_file") — open() it
  directly; NEVER os.path.join("inputs", value) (double-prepend is a top crash).
- Use ONLY the Python standard library unless you ALSO list the package in
  requirements.txt. NEVER `import dotenv` / `from dotenv import ...` (NOT installed
  -> ModuleNotFoundError). Read secrets from os.environ with a secrets.json fallback.
- import EVERY module you reference (os, json, csv, io, re, statistics, ...).
- OUTPUT CONTRACT (scalar vs file): a SCALAR output -> outputs[name] is the LITERAL
  VALUE (string/number), NEVER a path, no out/ file, no artifact (e.g.
  outputs={"reversed":"olleh"}). A FILE output -> write under out/ (mkdir it) and
  put the relative path in outputs[name] + one artifacts[] entry.
- IMPLEMENT EVERY declared output FULLY: if the prompt asks for several results
  (words AND sentences AND average length), compute ALL of them — never return
  only the first.
- Write result.json to the WORKING DIRECTORY ("result.json", NOT "out/result.json")
  on BOTH success and error: {"status":"success"|"error","outputs":{...},
  "artifacts":[{"name","relative_path","type"}],"error":<msg-on-error>}.
- End with `if __name__ == "__main__": main()`.

Worked run.py examples (copy the matching shape):
  # reverse a string (scalar in -> scalar out):
  #   import json; from pathlib import Path
  #   inputs = json.loads(Path("inputs.json").read_text(encoding='utf-8'))
  #   Path("result.json").write_text(json.dumps({"status":"success",
  #     "outputs":{"reversed": str(inputs["text"], encoding='utf-8')[::-1]}, "artifacts":[], "error":None}))
  # word+char+sentence count (scalar in -> json file out, ALL three computed):
  #   import json, re, os; from pathlib import Path
  #   t = str(json.loads(Path("inputs.json").read_text(encoding='utf-8')).get("text") or "")
  #   c = {"words":len(t.split()),"chars":len(t),
  #        "sentences":len([s for s in re.split(r"[.!?]+",t) if s.strip()])}
  #   os.makedirs("out",exist_ok=True); Path("out/counts.json").write_text(json.dumps(c), encoding='utf-8')
  #   Path("result.json").write_text(json.dumps({"status":"success",
  #     "outputs":{"counts":"out/counts.json"},
  #     "artifacts":[{"name":"out/counts.json","relative_path":"out/counts.json","type":"application/json"}],"error":None}), encoding='utf-8')

Only include files that are needed. Omit run.py for agent-only (A), omit SKILL.md for pure-script (B).
The `requirements` array is the authoritative source. `required_connections` = oauth slugs only. `required_secrets` = API_KEY names only."""


_BOTH_METHODS: frozenset = frozenset({
    "gmail",
    "hubspot",
    "slack",
    "notion",
    "github",
    "linear",
    "googlecalendar",
    "google-calendar",
    "googlesheets",
    "google-sheets",
    "googledrive",
    "google-drive",
    "googledocs",
    "google-docs",
    "salesforce",
    "linkedin",
    "discord",
    "dropbox",
    "airtable",
    "jira",
    "granola",
    "asana",
    "monday",
    "trello",
    "twitter",
})


_API_KEY_ONLY: frozenset = frozenset({
    "apollo",
    "stripe",
    "openai",
    "perplexityai",
    "anthropic",
    "serpapi",
    "firecrawl",
    "tavily",
})


def _available_methods_for_app(app_slug: str) -> List[str]:
    """Return the authoritative list of available auth methods for an app.

    Normalises slug to lowercase before lookup.
    """
    slug = (app_slug or "").lower().strip()
    if slug in _API_KEY_ONLY:
        return ["api_key"]
    if slug in _BOTH_METHODS:
        return ["oauth", "api_key"]
    # Unknown app: default to both so the user is not blocked
    return ["oauth", "api_key"]


_draft_rate_lock = threading.Lock()


_draft_rate_store: Dict[str, collections.deque] = {}


def _draft_rate_limit_hour() -> int:
    # Read live (not at import) so the env-driven cap stays correct across test
    # reloads: this module is not reloaded per-test the way main.py was, so a
    # frozen import-time constant would ignore a test's WORKEROS_DRAFT_RATE_HOUR.
    return int(os.environ.get("WORKEROS_DRAFT_RATE_HOUR", "20"))


_DRAFT_RATE_WINDOW_SECONDS = 3600.0


def _draft_rate_key(request: Request) -> str:
    """Per-secret bucket key for draft endpoints.

    Hashes x-floom-secret so the raw value is never persisted in-memory logs.
    In dev mode (no header), all callers share the same "anon" bucket.
    """
    secret = request.headers.get("x-floom-secret") or ""
    if not secret:
        return "anon"
    return "s:" + hashlib.sha256(secret.encode()).hexdigest()[:16]


def _claim_draft_slot(request: Request) -> Optional[int]:
    """Reserve one draft slot.

    Returns:
      - None when allowed
      - retry_after_seconds when rate-limited
    """
    now = time.monotonic()
    cutoff = now - _DRAFT_RATE_WINDOW_SECONDS
    key = _draft_rate_key(request)
    with _draft_rate_lock:
        dq = _draft_rate_store.setdefault(key, collections.deque())
        while dq and dq[0] <= cutoff:
            dq.popleft()
        if not dq:
            _draft_rate_store.pop(key, None)
            dq = _draft_rate_store.setdefault(key, collections.deque())
        if len(dq) >= _draft_rate_limit_hour():
            oldest = dq[0]
            retry_after = max(1, int(_DRAFT_RATE_WINDOW_SECONDS - (now - oldest)))
            return retry_after
        dq.append(now)
        return None


def _drafts_last_hour_total() -> int:
    """Total accepted drafts in the last hour across all callers."""
    now = time.monotonic()
    cutoff = now - _DRAFT_RATE_WINDOW_SECONDS
    total = 0
    with _draft_rate_lock:
        stale_keys: List[str] = []
        for key, dq in _draft_rate_store.items():
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if dq:
                total += len(dq)
            else:
                stale_keys.append(key)
        for key in stale_keys:
            _draft_rate_store.pop(key, None)
    return total


def _enforce_draft_rate_limit(request: Request) -> None:
    retry_after = _claim_draft_slot(request)
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail=f"Draft rate limit reached: {_draft_rate_limit_hour()}/hour. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )


def _detect_connections(prompt_lower: str) -> List[str]:
    """Keyword-match Composio app slugs from the prompt text."""
    found: List[str] = []
    for slug, keywords in _COMPOSIO_APP_KEYWORDS.items():
        if any(kw in prompt_lower for kw in keywords):
            found.append(slug)
    return found


def _call_draft_llm(
    client: Any,
    user_message: str,
    extra_system_instructions: Optional[str] = None,
) -> Dict[str, Any]:
    """Single OpenAI call returning a parsed JSON payload. Raises HTTPException on transport/JSON errors."""
    system_prompt = _DRAFT_SYSTEM_PROMPT
    if extra_system_instructions:
        system_prompt = f"{system_prompt}\n\n{extra_system_instructions}"

    try:
        from codegen_model import chat_completion_codegen

        response = chat_completion_codegen(
            client,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0.2,
            max_output_tokens=8000,
            response_format={"type": "json_object"},
        )
    except Exception as exc:
        logger.exception("OpenAI call failed in draft-from-prompt")
        raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}") from exc

    raw_content = (response.choices[0].message.content or "").strip()
    if raw_content.startswith("```"):
        raw_content = "\n".join(raw_content.split("\n")[1:])
    if raw_content.endswith("```"):
        raw_content = "\n".join(raw_content.split("\n")[:-1])
    raw_content = raw_content.strip()

    try:
        return json.loads(raw_content)
    except json.JSONDecodeError as exc:
        logger.error("LLM returned non-JSON for draft-from-prompt: %s", raw_content[:500])
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {exc}") from exc


def _repair_generated_worker_manifest(raw_manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize small schema drift in generated WorkerContract YAML.

    The worker-author and draft-from-prompt LLMs occasionally emit `schema_version`
    as a numeric scalar and omit the required top-level `version`. Repair those
    two cases in the generation path so the backend returns a valid contract
    instead of bouncing a retry on a trivially fixable format error.
    """
    repaired = dict(raw_manifest)
    schema_version = repaired.get("schema_version")
    if schema_version is not None and not isinstance(schema_version, str):
        repaired["schema_version"] = str(schema_version)
    if repaired.get("schema_version") == "0.3":
        version = repaired.get("version")
        if not isinstance(version, str) or not version.strip():
            repaired["version"] = "0.1.0"
        elif not version:
            repaired["version"] = "0.1.0"
    if "version" in repaired and repaired["version"] is not None and not isinstance(repaired["version"], str):
        repaired["version"] = str(repaired["version"])
    return repaired
