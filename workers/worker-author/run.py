"""Worker Author — generates Workeros worker bundles from natural-language prompts.

This worker runs in an E2B sandbox as a pure-script worker. The E2B driver
executes ``python run.py`` and reads back ``result.json`` (schema
``{"status", "outputs", "error"}``). The worker-author-style context is mounted
at ``context/worker-author-style/`` inside the sandbox working directory.

Protocol (matches the E2B pure-script contract, e.g. gmail_intake_brief):
  1. Read inputs from ``inputs.json``.
  2. Load secrets from ``.env.local`` (python-dotenv) — OPENAI_API_KEY ships here
     because worker.yml declares ``exec.secrets: [OPENAI_API_KEY]``.
  3. Call OpenAI to draft worker.yml + SKILL.md / run.py, validate the YAML.
  4. Write the bundle to ``out/bundle.json``.
  5. Write ``result.json`` with ``{"status", "outputs": {"bundle": "out/bundle.json"},
     "artifacts": [...]}`` so the driver surfaces the result to the UI.

Earlier this file defined a ``run(inputs, context)`` function that was never
invoked under ``python run.py`` (no ``__main__`` block) and wrote out/bundle.json
but never result.json — so every run failed with error_code=missing_result.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional; OPENAI_API_KEY may already be in os.environ


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
- worker_yml must be schema_version 0.3, valid YAML (all strings double-quoted), exec.runner: "e2b"
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
            f"```python\n{run_py_template[:4000]}\n```"
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

    Raises ValueError for a missing prompt and RuntimeError if OPENAI_API_KEY
    is not available. A bundle whose YAML failed validation after all retries
    is still returned (with a ``bundle["error"]`` key) so the operator can fix
    it in the editor rather than seeing a hard failure.
    """
    log = log or _stdout_log
    prompt = str(inputs.get("prompt") or "").strip()
    mode = str(inputs.get("mode") or "draft").strip()
    parent_worker_id = str(inputs.get("parent_worker_id") or "").strip() or None

    if not prompt:
        raise ValueError("prompt is required")

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

    log("worker-author: listing existing workers")
    existing_ids = _read_existing_workers()

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

    # Call OpenAI
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if not openai_key:
        raise RuntimeError("OPENAI_API_KEY is not set in the sandbox environment")

    from openai import OpenAI  # type: ignore
    client = OpenAI(api_key=openai_key)

    log("worker-author: calling LLM")
    max_attempts = 3
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

        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=call_messages,  # type: ignore
            temperature=0.2,
            max_tokens=4000,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or ""

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

        validation_error = _validate_worker_yml(worker_yml)
        if validation_error:
            last_error = validation_error
            log(f"worker-author: attempt {attempt} validation failed: {validation_error}", level="warning")
            continue

        last_error = None
        break

    # Build output bundle
    bundle: Dict[str, Any] = {
        "worker_yml": parsed.get("worker_yml"),
        "skill_md": parsed.get("skill_md"),
        "run_code": parsed.get("run_code"),
        "requirements_txt": parsed.get("requirements_txt"),
        "suggested_id": parsed.get("suggested_id") or "my-worker",
        "sample_input_json": parsed.get("sample_input_json") or "{}",
        "created_worker_id": None,
    }

    if last_error:
        # Return the broken bundle + the error so the operator can fix it
        bundle["error"] = f"YAML validation failed after {max_attempts} attempts: {last_error}"
        log(f"worker-author: returning bundle with validation error: {last_error}", level="warning")
    else:
        log(f"worker-author: bundle valid, suggested_id={bundle['suggested_id']!r}")

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
