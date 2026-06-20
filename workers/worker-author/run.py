"""Worker Author — generates Workeros worker bundles from natural-language prompts.

This worker runs in an E2B sandbox as a pure-script worker. The E2B driver
executes ``python run.py`` and reads back ``result.json`` (schema
``{"status", "outputs", "error"}``). The worker-author-style context is mounted
at ``context/worker-author-style/`` inside the sandbox working directory.

Protocol (matches the E2B pure-script contract, e.g. gmail_intake_brief):
  1. Read inputs from ``inputs.json``.
  2. Load secrets from ``.env.local`` plus provider env passed by the API runner.
  3. Call the configured platform provider to draft worker.yml + SKILL.md / run.py,
     validate the YAML.
  4. Write the bundle to ``out/bundle.json``.
  5. Write ``result.json`` with ``{"status", "outputs": {"bundle": "out/bundle.json"},
     "artifacts": [...]}`` so the driver surfaces the result to the UI.

Earlier this file defined a ``run(inputs, context)`` function that was never
invoked under ``python run.py`` (no ``__main__`` block) and wrote out/bundle.json
but never result.json — so every run failed with error_code=missing_result.
"""

from __future__ import annotations

import ast
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional; OPENAI_API_KEY may already be in os.environ


# ---------------------------------------------------------------------------
# Code-generation model (kept in sync with apps/api/codegen_model.py).
# This worker runs in an E2B sandbox and cannot import the API module, so the
# strong default + the gpt-5.x param handling are duplicated here intentionally.
# Override with WORKEROS_CODEGEN_MODEL, or fall back to WORKEROS_CHAT_MODEL when
# the platform only configured Emily's provider.
# ---------------------------------------------------------------------------

_DEFAULT_CODEGEN_MODEL = "gpt-5.1"
_SUGGESTED_ID_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "for",
    "from",
    "into",
    "latest",
    "me",
    "my",
    "of",
    "on",
    "the",
    "to",
    "with",
}


def _codegen_model() -> str:
    return (
        (os.environ.get("WORKEROS_CODEGEN_MODEL") or "").strip()
        or (os.environ.get("WORKEROS_CHAT_MODEL") or "").strip()
        or _DEFAULT_CODEGEN_MODEL
    )


def _is_litellm_model(model: str) -> bool:
    if "/" not in model:
        return False
    return not model.startswith(("openai/", "litellm/openai/"))


def _is_anthropic_model(model: str) -> bool:
    m = model.lower()
    return "anthropic" in m or "claude" in m


def _suggested_id_from_prompt(prompt: str) -> str:
    words = [
        word
        for word in re.findall(r"[a-z0-9]+", (prompt or "").lower())
        if word not in _SUGGESTED_ID_STOPWORDS
    ]
    selected = words[:4] or ["worker"]
    slug = "-".join(selected)[:64].strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    if len(slug) < 3:
        slug = f"{slug}-worker".strip("-")
    return slug or "worker"


def _with_prompt_cache(messages: list, model: str) -> list:
    if not _is_anthropic_model(model):
        return list(messages)
    out: list = []
    cached = False
    for msg in messages:
        if not cached and msg.get("role") == "system" and isinstance(msg.get("content"), str):
            msg = {
                **msg,
                "content": [
                    {
                        "type": "text",
                        "text": msg["content"],
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            }
            cached = True
        out.append(msg)
    return out


def _provider_credentials_error(model: str) -> Optional[str]:
    if _is_litellm_model(model):
        if "bedrock" in model.lower():
            has_auth = bool(
                os.environ.get("AWS_ACCESS_KEY_ID")
                or os.environ.get("AWS_BEARER_TOKEN_BEDROCK")
                or os.environ.get("AWS_PROFILE")
            )
            has_region = bool(os.environ.get("AWS_REGION_NAME") or os.environ.get("AWS_DEFAULT_REGION"))
            if not has_auth:
                return "Bedrock model configured but AWS credentials are not available in the worker-author sandbox"
            if not has_region:
                return "Bedrock model configured but AWS_REGION_NAME or AWS_DEFAULT_REGION is not set"
        return None
    if not (os.environ.get("OPENAI_API_KEY") or os.environ.get("PLATFORM_OPENAI_API_KEY")):
        return "OpenAI model configured but OPENAI_API_KEY or PLATFORM_OPENAI_API_KEY is not available"
    return None


def _codegen_chat(
    *,
    messages: list,
    max_output_tokens: int,
    temperature: float = 0.2,
    response_format: Optional[Dict[str, Any]] = None,
) -> Any:
    """Provider-routed chat completion with an OpenAI-shaped response."""
    model = _codegen_model()
    credentials_error = _provider_credentials_error(model)
    if credentials_error:
        raise RuntimeError(credentials_error)

    if _is_litellm_model(model):
        import litellm  # type: ignore

        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": _with_prompt_cache(messages, model),
            "max_tokens": max_output_tokens,
        }
        if response_format is not None:
            kwargs["response_format"] = response_format
        try:
            return litellm.completion(temperature=temperature, **kwargs)
        except Exception as exc:  # noqa: BLE001 - some providers reject temperature
            if "temperature" in str(exc).lower():
                return litellm.completion(**kwargs)
            raise

    ml = model.lower()
    token_kwarg = (
        "max_completion_tokens"
        if ml.startswith(("gpt-5", "o1", "o3", "o4"))
        else "max_tokens"
    )
    from openai import OpenAI  # type: ignore

    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY") or os.environ.get("PLATFORM_OPENAI_API_KEY"))

    def _create(token_param: str, *, include_temperature: bool = True) -> Any:
        kwargs: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            token_param: max_output_tokens,
        }
        if include_temperature:
            kwargs["temperature"] = temperature
        if response_format is not None:
            kwargs["response_format"] = response_format
        return client.chat.completions.create(**kwargs)

    try:
        return _create(token_kwarg)
    except Exception as exc:  # noqa: BLE001 - retry once on the param-name 400
        msg = str(exc).lower()
        if "max_completion_tokens" in msg and token_kwarg == "max_tokens":
            return _create("max_completion_tokens")
        if "max_tokens" in msg and token_kwarg == "max_completion_tokens":
            return _create("max_tokens")
        if (
            "temperature" in msg
            and (
                "unsupported" in msg
                or "does not support" in msg
                or "only the default" in msg
                or "only temperature=1" in msg
            )
        ):
            return _create(token_kwarg, include_temperature=False)
        raise


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_context_file(context_name: str, rel_path: str) -> Optional[str]:
    """Read a file from the mounted context directory."""
    base = Path("context") / context_name
    target = (base / rel_path).resolve()
    # Safety: must stay inside context dir
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    if target.is_file():
        return target.read_text(encoding="utf-8", errors="replace")
    return None


def _list_context_dir(context_name: str, rel_path: str = "") -> List[str]:
    """List files in a context subdirectory."""
    base = Path("context") / context_name
    target = (base / rel_path).resolve() if rel_path else base.resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return []
    if target.is_dir():
        return sorted(str(p.relative_to(target)) for p in target.rglob("*") if p.is_file())
    return []


def _read_existing_workers(workers_dir: Optional[str] = None) -> List[str]:
    """Read existing worker IDs from the bundle directory (mounted at workers/ if present)."""
    search_paths = [
        Path("workers"),
        Path("/workers"),
    ]
    if workers_dir:
        search_paths.insert(0, Path(workers_dir))
    for base in search_paths:
        if base.is_dir():
            return sorted(d.name for d in base.iterdir() if d.is_dir() and not d.name.startswith("."))
    return []


def _validate_worker_yml(yml_string: str) -> Optional[str]:
    """Validate a worker.yml string. Returns error string or None if valid."""
    try:
        import yaml as pyyaml
        manifest = pyyaml.safe_load(yml_string)
        if not isinstance(manifest, dict):
            return "worker_yml must be a YAML mapping"
        manifest = _repair_generated_worker_manifest(manifest)
        schema_ver = manifest.get("schema_version")
        if schema_ver != "0.3":
            return f"schema_version must be '0.3', got {schema_ver!r}"
        for required in ("name", "title", "description", "version", "exec"):
            if required not in manifest:
                return f"Missing required field: {required!r}"
        name = manifest.get("name", "")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,62}[a-z0-9]", name):
            return f"name must be lowercase letters/digits/hyphens, 3-64 chars: {name!r}"
        exec_block = manifest.get("exec", {})
        runner = exec_block.get("runner", "e2b")
        if runner not in ("e2b", "local"):
            return f"exec.runner must be 'e2b', got {runner!r}"
        entry = exec_block.get("entry")
        if entry and not (entry.endswith(".md") or entry.endswith(".py") or
                          entry.endswith(".sh") or entry.endswith(".js")):
            return f"exec.entry must end in .md, .py, .sh, or .js; got {entry!r}"
        return None
    except Exception as exc:
        return f"YAML parse error: {exc}"


def _load_manifest(yml_string: str) -> Optional[Dict[str, Any]]:
    try:
        import yaml as pyyaml

        parsed = pyyaml.safe_load(yml_string)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _repair_generated_worker_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize tiny schema drift in generated WorkerContract YAML."""
    repaired = dict(manifest)
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


def _exec_block(manifest: Dict[str, Any]) -> Dict[str, Any]:
    block = manifest.get("exec")
    return block if isinstance(block, dict) else {}


def _entry(manifest: Dict[str, Any]) -> str:
    exec_block = _exec_block(manifest)
    return str(exec_block.get("entry") or exec_block.get("entrypoint") or manifest.get("entrypoint") or "").strip()


def _trigger_types(manifest: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    triggers = manifest.get("triggers")
    if isinstance(triggers, list):
        for item in triggers:
            if isinstance(item, dict):
                out.append(str(item.get("type") or "manual").strip().lower())
    trigger = manifest.get("trigger")
    if isinstance(trigger, dict):
        out.append(str(trigger.get("type") or "manual").strip().lower())
    return [("schedule" if t in {"cron", "scheduled"} else t) for t in out if t]


_SCHEDULE_INTENT_RE = re.compile(
    r"\b("
    r"cron|schedule|scheduled|every|daily|weekly|monthly|hourly|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"morning|afternoon|evening|night|at\s+\d{1,2}(:\d{2})?\s*(am|pm)?"
    r")\b",
    re.IGNORECASE,
)


def _prompt_requests_schedule(prompt: str) -> bool:
    return bool(_SCHEDULE_INTENT_RE.search(prompt or ""))


_PLACEHOLDER_CODE_MARKERS = (
    "replace with the real output",
    "TODO",
    "pass  #",
    "NotImplementedError",
    "_write_result(\"success\", outputs={\"result\": result_value})",
    "_write_result('success', outputs={'result': result_value})",
)


def _declared_output_names(manifest: Dict[str, Any]) -> List[str]:
    exec_block = _exec_block(manifest)
    raw_outputs = exec_block.get("outputs")
    if not isinstance(raw_outputs, list):
        raw_outputs = manifest.get("outputs")
    if not isinstance(raw_outputs, list):
        return []
    names: List[str] = []
    for item in raw_outputs:
        if isinstance(item, dict) and item.get("name"):
            names.append(str(item["name"]))
    return names


def _validate_generated_bundle(parsed: Dict[str, Any], prompt: str) -> Optional[str]:
    """Reject valid-looking bundles that cannot become useful workers.

    The YAML validator only checks shape. This gate checks generation intent:
    no accidental schedule trigger, script-mode workers must include real
    executable code, and agent-mode workers must include a real SKILL.md.
    """
    worker_yml = parsed.get("worker_yml")
    if not isinstance(worker_yml, str) or not worker_yml.strip():
        return "worker_yml is empty"

    yaml_error = _validate_worker_yml(worker_yml)
    if yaml_error:
        return yaml_error

    manifest = _load_manifest(worker_yml)
    if not manifest:
        return "worker_yml must be a YAML mapping"

    trigger_types = _trigger_types(manifest)
    if any(t == "schedule" for t in trigger_types) and not _prompt_requests_schedule(prompt):
        return (
            "trigger.type is schedule, but the prompt did not request a schedule. "
            "Use trigger.type: manual unless the operator explicitly asks for recurring execution."
        )

    entry = _entry(manifest).lower()
    if entry.endswith(".py"):
        run_code = parsed.get("run_code")
        if not isinstance(run_code, str) or not run_code.strip():
            return "exec.entry is run.py, but run_code is empty"
        try:
            ast.parse(run_code)
        except SyntaxError as exc:
            return f"run_code is invalid Python: {exc}"
        lower_code = run_code.lower()
        for marker in _PLACEHOLDER_CODE_MARKERS:
            if marker.lower() in lower_code:
                return f"run_code still contains placeholder logic marker: {marker}"
        output_names = _declared_output_names(manifest)
        missing = [name for name in output_names if name not in run_code]
        if missing:
            return (
                "run_code does not produce every declared output: "
                + ", ".join(missing)
            )
    elif entry.endswith(".md"):
        skill_md = parsed.get("skill_md")
        if not isinstance(skill_md, str) or len(skill_md.strip()) < 40:
            return "exec.entry is SKILL.md, but skill_md is empty or too thin"

    return None


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_HEADER = """You are the Worker Author — a meta-worker that generates Workeros worker bundles from natural-language descriptions.

Output ONLY a JSON object (no markdown, no code fences) with this exact shape:
{
  "worker_yml": "<YAML string>",
  "skill_md": "<agent system prompt string or null>",
  "run_code": "<Python code string or null>",
  "requirements_txt": "<pip deps string or null>",
  "suggested_id": "<lowercase-slug>",
  "sample_input_json": "<JSON object string with realistic values>"
}

Rules:
- worker_yml must be schema_version "0.3", include version: "0.1.0", be valid YAML (all strings double-quoted), and use exec.runner: "e2b"
- Agent mode (entry: SKILL.md): set skill_md, leave run_code null
- Script mode (entry: run.py): set run_code, leave skill_md null; always add exec.command

Script-mode run.py rules (these EXACT mistakes crash generated workers — never make them):
- Use ONLY the Python standard library unless you ALSO list the package in
  requirements_txt. NEVER `import dotenv` / `from dotenv import ...` (it is NOT
  preinstalled -> ModuleNotFoundError). Read secrets from os.environ with a
  secrets.json fallback (see the template's _load_secrets helper).
- import EVERY module you reference (os, json, csv, io, re, statistics, ...).
- Write result.json to the WORKING DIRECTORY ("result.json"), NEVER "out/result.json".
- Write output files under out/; map each declared output to its out/ path.
- Read scalar inputs as literal values. A FILE input's value IS already the
  relative path (e.g. "inputs/csv_file"); open(inputs["x"]) directly — NEVER
  os.path.join("inputs", inputs["x"]) (double-prepending inputs/ is a top crash).
- End with `if __name__ == "__main__": main()`.
- If you `import requests`/`openai`/any third-party lib, requirements_txt MUST list it.
- IMPLEMENT EVERY DECLARED OUTPUT FULLY: if the prompt asks for several things
  (e.g. word count AND sentence count AND average word length), declare an output
  for each and compute ALL of them in run.py. A worker that returns only the first
  is an under-implemented no-op. Don't under-deliver vs the prompt.
- name must be lowercase hyphens/digits, 3-64 chars, unique (avoid the IDs listed below)
- is_example must be false
- system_worker must be false or absent
- trigger.type: "manual" unless the prompt explicitly describes a schedule or webhook
- if you include "use_cases", it MUST contain EXACTLY 3 to 5 short items; otherwise omit the field entirely
- if you include "tags", it MUST contain 8 or fewer flat (no "/") non-empty strings; otherwise omit it
- KISS and YAGNI: the smallest bundle that does exactly what was described

Output media_type rule for worker.yml (CRITICAL — wrong media_type makes a correct worker look broken):
- For a structured/JSON result (e.g. stats like {"min":1,"max":9,"mean":5}, parsed
  records, key-value summaries, any object/array the worker writes via json.dumps),
  the output MUST declare media_type: "application/json" and a path under out/
  (e.g. path: "out/<name>.json"). The validator gates JSON outputs on
  parseability, not size, so a small valid JSON document passes; declaring it as
  text/* would wrongly fail it against a byte floor.
- For prose/markdown/CSV results, use the matching text media_type
  (text/markdown, text/plain, text/csv) and a path under out/.

Input-path rule for worker.yml (CRITICAL — gets workers wrong constantly):
- SCALAR inputs (type: string | textarea | number | boolean | select | url):
  use kind: "scalar" and NO `path:` field. The value is passed inline.
- FILE inputs (an uploaded file): use kind: "file" and path: "inputs/<name>"
  where <name> is the input's own name. The value the worker reads is that
  relative path; open() it to get the bytes.

example_input rule for worker.yml (so the worker is ONE-CLICK runnable from the
"Fill with sample input" button — non-technical users never hand-craft a file):
- ALWAYS include an `example_input:` block covering EVERY input the worker
  declares, scalar AND file.
- For a FILE input, the example_input value MUST be the file's INLINE TEXT
  CONTENT as a string (e.g. a small CSV like "name\nalice\nbob\n"), NOT a path
  and NOT a placeholder. The UI synthesizes a real uploaded file from this
  string so the operator can run the worker immediately with no manual upload.
- sample_input_json MUST mirror the same realistic values (file inputs as their
  inline text content), so the smoke run and the UI sample agree.

run.py rule (CRITICAL — most generated script workers crash on first run):
- The run_code you emit MUST follow the canonical contract shown below EXACTLY:
  read inputs.json, distinguish scalar (literal) vs file (relative path under
  inputs/) inputs, import EVERY module you reference (os, json, csv, io, re,
  statistics, ...), write output files under out/, and write result.json with
  {"status","outputs","artifacts","error?"} on BOTH the success and error
  paths, ending with `if __name__ == "__main__": main()`. A missing `import`
  or a missing result.json is the #1 cause of a worker failing its first run.
"""


def _build_messages(
    prompt: str,
    mode: str,
    parent_worker_id: Optional[str],
    existing_worker_ids: List[str],
    context_schema: Optional[str],
    context_style: Optional[str],
    context_anti_patterns: Optional[str],
    example_files: List[tuple[str, str]],
    run_py_template: Optional[str] = None,
) -> list[dict]:
    system_parts = [SYSTEM_PROMPT_HEADER]

    if existing_worker_ids:
        system_parts.append(
            "\nExisting worker IDs (do NOT reuse these names):\n"
            + ", ".join(existing_worker_ids)
        )

    if context_schema:
        system_parts.append(f"\n## Schema reference\n{context_schema[:3000]}")

    if run_py_template:
        # The canonical, copy-pasteable run.py contract. For SCRIPT-mode workers
        # the emitted run_code MUST follow this verbatim. This is the single
        # source of truth (contexts/worker-author-style/RUN_PY_TEMPLATE.py).
        system_parts.append(
            "\n## Canonical run.py contract (script mode — follow EXACTLY)\n"
            "When entry is run.py, your run_code MUST match the contract in this "
            "template: read inputs.json, treat scalar inputs as literal values and "
            "file inputs as relative paths under inputs/, import every module you "
            "use, write outputs under out/, and write result.json on success AND "
            "error. Do not deviate.\n"
            f"```python\n{run_py_template[:9000]}\n```"
        )

    if context_style:
        system_parts.append(f"\n## Style conventions\n{context_style[:2000]}")

    if context_anti_patterns:
        system_parts.append(f"\n## Anti-patterns to avoid\n{context_anti_patterns[:2000]}")

    for fname, fcontent in example_files:
        system_parts.append(f"\n## Example: {fname}\n```yaml\n{fcontent[:1500]}\n```")

    system_content = "\n".join(system_parts)

    user_parts = [f"Design a Workeros worker for this task:\n\n{prompt}"]
    if mode == "create":
        user_parts.append("\nMode: create. Include the full bundle so it can be registered immediately.")
    else:
        user_parts.append("\nMode: draft. Return the bundle for review.")
    if parent_worker_id:
        user_parts.append(f"\nFork from existing worker: {parent_worker_id}")

    return [
        {"role": "system", "content": system_content},
        {"role": "user", "content": "\n".join(user_parts)},
    ]


# ---------------------------------------------------------------------------
# Generation logic
# ---------------------------------------------------------------------------

def _stdout_log(msg: str, **kwargs: Any) -> None:
    """Default logger: print to stdout so the E2B driver streams it to the
    run's SSE log (the GeneratingPanel reads these lines)."""
    level = kwargs.get("level", "info")
    print(f"[{level}] {msg}", flush=True)


def generate_bundle(inputs: Dict[str, Any], log: Any = None) -> Dict[str, Any]:
    """Draft a worker bundle from the prompt. Returns the bundle dict.

    Raises ValueError for a missing prompt and RuntimeError if provider
    credentials are not available. A bundle whose YAML failed validation after
    all retries is still returned (with a ``bundle["error"]`` key) so the
    operator can fix it in the editor rather than seeing a hard failure.
    """
    log = log or _stdout_log
    started_at = time.perf_counter()
    prompt = str(inputs.get("prompt") or "").strip()
    mode = str(inputs.get("mode") or "draft").strip()
    parent_worker_id = str(inputs.get("parent_worker_id") or "").strip() or None

    if not prompt:
        raise ValueError("prompt is required")

    stage_at = time.perf_counter()
    log("worker-author: reading style context")
    schema_md = _read_context_file("worker-author-style", "SCHEMA.md")
    style_md = _read_context_file("worker-author-style", "STYLE.md")
    anti_patterns_md = _read_context_file("worker-author-style", "ANTI-PATTERNS.md")
    run_py_template = _read_context_file("worker-author-style", "RUN_PY_TEMPLATE.py")
    example_filenames = _list_context_dir("worker-author-style", "EXAMPLES")

    example_files: list[tuple[str, str]] = []
    for fname in example_filenames[:3]:  # read up to 3 examples
        content = _read_context_file("worker-author-style", f"EXAMPLES/{fname}")
        if content:
            example_files.append((fname, content))
    log(f"worker-author: style context read in {time.perf_counter() - stage_at:.2f}s")

    stage_at = time.perf_counter()
    log("worker-author: listing existing workers")
    existing_ids = _read_existing_workers()
    log(f"worker-author: existing worker scan took {time.perf_counter() - stage_at:.2f}s")

    stage_at = time.perf_counter()
    log(f"worker-author: building prompt (mode={mode})")
    messages = _build_messages(
        prompt=prompt,
        mode=mode,
        parent_worker_id=parent_worker_id,
        existing_worker_ids=existing_ids,
        context_schema=schema_md,
        context_style=style_md,
        context_anti_patterns=anti_patterns_md,
        example_files=example_files,
        run_py_template=run_py_template,
    )
    log(f"worker-author: prompt assembled in {time.perf_counter() - stage_at:.2f}s")

    log(f"worker-author: calling LLM (model={_codegen_model()})")
    max_attempts = 2
    parsed: Dict[str, Any] = {}
    last_error: Optional[str] = None

    for attempt in range(1, max_attempts + 1):
        call_messages = list(messages)
        if last_error:
            call_messages.append({
                "role": "user",
                "content": (
                    f"Previous attempt failed validation: {last_error}\n"
                    "Fix the YAML. Double-quote every string scalar. "
                    "Preserve the original intent exactly."
                ),
            })

        attempt_started_at = time.perf_counter()
        resp = _codegen_chat(
            messages=call_messages,
            temperature=0.2,
            max_output_tokens=8000,
            response_format={"type": "json_object"},
        )
        log(
            f"worker-author: LLM attempt {attempt}/{max_attempts} took "
            f"{time.perf_counter() - attempt_started_at:.2f}s"
        )
        raw = (resp.choices[0].message.content or "").strip()
        # Bedrock/Anthropic Claude (and some other providers) wrap JSON in a
        # ```json ... ``` markdown fence or add a short preamble, so a bare
        # json.loads fails at char 0 ("Expecting value: line 1 column 1"). Strip a
        # fence if present, else fall back to the outermost {...} object.
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1] if "\n" in raw else raw[3:]
            if raw.rstrip().endswith("```"):
                raw = raw.rstrip()[:-3]
            raw = raw.strip()
            if raw.lower().startswith("json"):
                raw = raw[4:].lstrip()
        if not raw.startswith("{"):
            _start, _end = raw.find("{"), raw.rfind("}")
            if _start != -1 and _end > _start:
                raw = raw[_start : _end + 1]

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            last_error = f"LLM returned non-JSON: {exc}"
            log(f"worker-author: attempt {attempt} JSON parse error: {exc}", level="warning")
            continue

        worker_yml = parsed.get("worker_yml", "")
        if not worker_yml:
            last_error = "worker_yml is empty"
            log(f"worker-author: attempt {attempt} empty worker_yml", level="warning")
            continue

        validation_error = _validate_generated_bundle(parsed, prompt)
        if validation_error:
            last_error = validation_error
            log(f"worker-author: attempt {attempt} validation failed: {validation_error}", level="warning")
            continue

        import yaml as pyyaml

        repaired_manifest = _repair_generated_worker_manifest(_load_manifest(worker_yml) or {})
        parsed["worker_yml"] = pyyaml.safe_dump(
            repaired_manifest,
            sort_keys=False,
            default_flow_style=False,
        )
        last_error = None
        break

    # Build output bundle
    bundle: Dict[str, Any] = {
        "worker_yml": parsed.get("worker_yml"),
        "skill_md": parsed.get("skill_md"),
        "run_code": parsed.get("run_code"),
        "requirements_txt": parsed.get("requirements_txt"),
        "suggested_id": parsed.get("suggested_id") or _suggested_id_from_prompt(prompt),
        "sample_input_json": parsed.get("sample_input_json") or "{}",
        "created_worker_id": None,
    }

    if last_error:
        # Return the broken bundle + the error so the operator can fix it
        bundle["error"] = f"YAML validation failed after {max_attempts} attempts: {last_error}"
        log(f"worker-author: returning bundle with validation error: {last_error}", level="warning")
    else:
        log(f"worker-author: bundle valid, suggested_id={bundle['suggested_id']!r}")

    log(f"worker-author: total generation time {time.perf_counter() - started_at:.2f}s")
    return bundle


# ---------------------------------------------------------------------------
# E2B pure-script entry: read inputs.json, write result.json
# ---------------------------------------------------------------------------

def _write_error(error: str) -> None:
    Path("result.json").write_text(
        json.dumps({"status": "error", "error": error}), encoding="utf-8"
    )


def main() -> None:
    try:
        inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
        if not isinstance(inputs, dict):
            inputs = {}
    except FileNotFoundError:
        _write_error("inputs.json not found in sandbox working directory")
        return
    except json.JSONDecodeError as exc:
        _write_error(f"inputs.json is not valid JSON: {exc}")
        return

    try:
        bundle = generate_bundle(inputs, log=_stdout_log)
    except ValueError as exc:
        _write_error(str(exc))
        return
    except RuntimeError as exc:
        # OPENAI_API_KEY missing or other hard runtime failure.
        _write_error(str(exc))
        return
    except Exception as exc:  # pragma: no cover - defensive
        _write_error(f"worker-author failed: {exc}")
        return

    # Write the bundle artifact + result.json with the declared output.
    os.makedirs("out", exist_ok=True)
    bundle_json = json.dumps(bundle, ensure_ascii=False, indent=2)
    Path("out/bundle.json").write_text(bundle_json, encoding="utf-8")

    result = {
        "status": "success",
        "outputs": {"bundle": "out/bundle.json"},
        "artifacts": [
            {
                "name": "bundle.json",
                "relative_path": "out/bundle.json",
                "type": "application/json",
            }
        ],
    }
    Path("result.json").write_text(json.dumps(result), encoding="utf-8")
    _stdout_log("worker-author: done")


if __name__ == "__main__":
    main()
