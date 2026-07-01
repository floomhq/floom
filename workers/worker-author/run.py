"""Worker Author — generates Floom worker bundles from natural-language prompts.

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
  5. Write ``result.json`` with ``{"status", "outputs": {"summary": "...", "bundle": "out/bundle.json"},
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


_GEMINI_KEY_FALLBACK_RE = re.compile(
    r"invalid api key|api[_ -]?key|authentication|permission|unauthorized|forbidden"
    r"|billing|quota|exceeded your current quota|rate.?limit|resource_exhausted"
    r"|429|401|403",
    re.IGNORECASE,
)


def _is_direct_gemini_api_key_model(model: str) -> bool:
    normalized = model.lower()
    if normalized.startswith("litellm/"):
        normalized = normalized.removeprefix("litellm/")
    return normalized.startswith("gemini/")


def _gemini_primary_key() -> Optional[str]:
    return (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip() or None


def _gemini_fallback_key() -> Optional[str]:
    return (
        os.environ.get("GEMINI_API_KEY_FALLBACK")
        or os.environ.get("GOOGLE_API_KEY_FALLBACK")
        or ""
    ).strip() or None


def _should_retry_gemini_with_fallback(exc: BaseException) -> bool:
    return bool(_GEMINI_KEY_FALLBACK_RE.search(str(exc)))


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


def _title_from_worker_id(worker_id: str) -> str:
    words = [word for word in re.split(r"[-_\s]+", worker_id or "") if word]
    title = " ".join(word.capitalize() for word in words).strip()
    return title or "Generated Worker"


def _description_from_prompt(prompt: str, title: str) -> str:
    clean = re.sub(r"\s+", " ", (prompt or "").strip())
    if clean:
        return clean[:220]
    return f"Worker generated from the prompt: {title}."


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


def _extract_json_object(raw: str) -> Dict[str, Any]:
    """Parse the first JSON object from an LLM response.

    Some providers honor ``response_format={"type": "json_object"}`` loosely and
    still append commentary after the object. ``json.loads`` then fails with
    ``Extra data`` even though the leading object is usable.
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1] if "\n" in text else text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
        text = text.strip()
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    if not text.startswith("{"):
        start = text.find("{")
        if start != -1:
            text = text[start:]
    parsed, _end = json.JSONDecoder().raw_decode(text)
    if not isinstance(parsed, dict):
        raise json.JSONDecodeError("top-level JSON value is not an object", text, 0)
    return parsed


def _provider_credentials_error(model: str) -> Optional[str]:
    if _is_litellm_model(model):
        if _is_direct_gemini_api_key_model(model) and not (_gemini_primary_key() or _gemini_fallback_key()):
            return (
                "Gemini model configured but GEMINI_API_KEY, GOOGLE_API_KEY, "
                "GEMINI_API_KEY_FALLBACK, or GOOGLE_API_KEY_FALLBACK is not available in the worker-author sandbox"
            )
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
        last_kwargs = kwargs
        try:
            if _is_direct_gemini_api_key_model(model) and "api_key" not in kwargs:
                primary_key = _gemini_primary_key()
                fallback_key = _gemini_fallback_key()
                if primary_key:
                    kwargs["api_key"] = primary_key
                last_kwargs = kwargs
                try:
                    return litellm.completion(temperature=temperature, **kwargs)
                except Exception as exc:  # noqa: BLE001 - litellm/provider exception classes vary
                    if (
                        not fallback_key
                        or fallback_key == primary_key
                        or not _should_retry_gemini_with_fallback(exc)
                    ):
                        raise
                    retry_kwargs = {**kwargs, "api_key": fallback_key}
                    last_kwargs = retry_kwargs
                    return litellm.completion(temperature=temperature, **retry_kwargs)
            return litellm.completion(temperature=temperature, **kwargs)
        except Exception as exc:  # noqa: BLE001 - some providers reject temperature
            if "temperature" in str(exc).lower():
                return litellm.completion(**last_kwargs)
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


def _validate_worker_yml(yml_string: str, *, prompt: str = "", suggested_id: str = "") -> Optional[str]:
    """Validate a worker.yml string. Returns error string or None if valid."""
    try:
        import yaml as pyyaml
        manifest = pyyaml.safe_load(yml_string)
        if not isinstance(manifest, dict):
            return "worker_yml must be a YAML mapping"
        manifest = _repair_generated_worker_manifest(manifest, prompt=prompt, suggested_id=suggested_id)
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


_PROMPT_CONNECTION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "gmail",
        re.compile(
            r"\b(gmail|google\s+mail|inbox|mailbox|latest\s+email|latest\s+mail|"
            r"my\s+email|my\s+mail|unread\s+email|unread\s+mail)\b",
            re.IGNORECASE,
        ),
    ),
    ("googlecalendar", re.compile(r"\b(google\s+calendar|gcal)\b", re.IGNORECASE)),
    ("slack", re.compile(r"\bslack\b", re.IGNORECASE)),
    ("notion", re.compile(r"\bnotion\b", re.IGNORECASE)),
    ("linear", re.compile(r"\blinear\b(?!\s+(regression|algebra|model|scale|equation))", re.IGNORECASE)),
    ("github", re.compile(r"\b(github|git\s+hub)\b", re.IGNORECASE)),
    ("hubspot", re.compile(r"\bhubspot\b", re.IGNORECASE)),
    ("stripe", re.compile(r"\bstripe\b", re.IGNORECASE)),
    ("apollo", re.compile(r"\bapollo\b", re.IGNORECASE)),
    ("salesforce", re.compile(r"\bsalesforce\b", re.IGNORECASE)),
)

_PROMPT_CONNECTION_READ_TOOLS: Dict[str, List[str]] = {
    # Compact mirror of apps/api/models.py READ_ONLY_TOOL_PRESETS. worker-author
    # runs inside E2B and cannot import API modules, so keep the common
    # integration defaults here too. Unknown integrations still get declared,
    # then the verifier forces the model to explain how the worker will use them.
    "gmail": [
        "GMAIL_FETCH_EMAILS",
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        "GMAIL_LIST_THREADS",
        "GMAIL_GET_PROFILE",
    ],
    "googlecalendar": [
        "GOOGLECALENDAR_EVENTS_LIST",
        "GOOGLECALENDAR_FIND_EVENT",
        "GOOGLECALENDAR_LIST_CALENDARS",
        "GOOGLECALENDAR_FREE_BUSY_QUERY",
    ],
    "github": [
        "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
        "GITHUB_LIST_PULL_REQUESTS",
        "GITHUB_GET_A_PULL_REQUEST",
        "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    ],
    "slack": [
        "SLACK_FETCH_CONVERSATION_HISTORY",
        "SLACK_SEARCH_MESSAGES",
        "SLACK_LIST_ALL_CHANNELS",
        "SLACK_FETCH_CONVERSATION_REPLIES",
    ],
}

_CREDENTIAL_INPUT_RE = re.compile(
    r"\b(api[_\s-]*key|access[_\s-]*token|auth[_\s-]*token|bearer[_\s-]*token|"
    r"client[_\s-]*secret|private[_\s-]*key|password|passwd|credential|secret)\b",
    re.IGNORECASE,
)

_GENERIC_CREDENTIAL_RE = re.compile(
    r"^(api[_\s-]*key|access[_\s-]*token|auth[_\s-]*token|bearer[_\s-]*token|"
    r"client[_\s-]*secret|private[_\s-]*key|password|passwd|credential|secret)$",
    re.IGNORECASE,
)


def _slug_to_secret_prefix(slug: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", slug.upper()).strip("_")


def _secret_name_from_credential_input(item: Dict[str, Any], prompt: str) -> str:
    raw_name = str(item.get("name") or item.get("label") or "API_KEY")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", raw_name).strip("_").upper()
    if cleaned and not _GENERIC_CREDENTIAL_RE.match(cleaned.replace("_", " ")):
        return cleaned
    inferred = _infer_connections_from_prompt(prompt)
    if len(inferred) == 1:
        return f"{_slug_to_secret_prefix(inferred[0])}_API_KEY"
    return cleaned or "API_KEY"


def _is_credential_input_item(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    name = str(item.get("name") or "")
    label = str(item.get("label") or "")
    return bool(_CREDENTIAL_INPUT_RE.search(f"{name} {label}"))


def _repair_credential_inputs_to_secrets(manifest: Dict[str, Any], prompt: str) -> None:
    exec_block = manifest.get("exec")
    if not isinstance(exec_block, dict):
        return
    raw_inputs = exec_block.get("inputs")
    if not isinstance(raw_inputs, list):
        return

    kept_inputs: List[Any] = []
    moved_secret_names: List[str] = []
    for item in raw_inputs:
        if _is_credential_input_item(item):
            moved_secret_names.append(_secret_name_from_credential_input(item, prompt))
        else:
            kept_inputs.append(item)
    if not moved_secret_names:
        return

    raw_secrets = exec_block.get("secrets")
    secrets: List[str] = [str(secret) for secret in raw_secrets] if isinstance(raw_secrets, list) else []
    seen = {secret.upper() for secret in secrets}
    for secret in moved_secret_names:
        if secret.upper() not in seen:
            secrets.append(secret)
            seen.add(secret.upper())

    exec_block["inputs"] = kept_inputs
    exec_block["secrets"] = secrets


def _connection_app_from_item(item: Any) -> Optional[str]:
    if isinstance(item, str):
        return item.strip().lower() or None
    if isinstance(item, dict):
        app = item.get("app") or item.get("composio")
        if isinstance(app, str) and app.strip():
            return app.strip().lower()
    return None


def _connection_item_with_tools(app: str, tools: List[str]) -> Any:
    return {"app": app, "allowed_tools": tools} if tools else app


def _merge_connection_tools(item: Any, app: str, tools: List[str]) -> Any:
    if not tools:
        return item
    if isinstance(item, str):
        return {"app": app, "allowed_tools": tools}
    if not isinstance(item, dict):
        return item
    merged = dict(item)
    existing = merged.get("allowed_tools")
    raw_allowed = [str(t) for t in existing] if isinstance(existing, list) else []
    known = {tool.upper() for tool in tools}
    known_prefixes = {tool.split("_", 1)[0] for tool in tools if "_" in tool}
    # For known first-party integrations, do not preserve model-invented action
    # slugs with the same app prefix. They make the proxy allow a tool that does
    # not exist and then the generated SKILL.md instructs the agent to call it.
    allowed = [
        tool
        for tool in raw_allowed
        if tool.upper() in known
        or (tool.split("_", 1)[0] not in known_prefixes)
    ]
    seen = {tool.upper() for tool in allowed}
    for tool in tools:
        if tool.upper() not in seen:
            allowed.append(tool)
            seen.add(tool.upper())
    merged["allowed_tools"] = allowed
    if not merged.get("app") and not merged.get("composio"):
        merged["app"] = app
    return merged


def _infer_connections_from_prompt(prompt: str) -> List[str]:
    found: List[str] = []
    for app, pattern in _PROMPT_CONNECTION_PATTERNS:
        if pattern.search(prompt or ""):
            found.append(app)
    return found


def _repair_prompt_declared_connections(manifest: Dict[str, Any], prompt: str) -> None:
    inferred = _infer_connections_from_prompt(prompt)
    if not inferred:
        return
    existing = manifest.get("connections")
    if existing is None:
        connections: List[Any] = []
    elif isinstance(existing, list):
        connections = list(existing)
    else:
        return

    existing_apps = {}
    for idx, item in enumerate(connections):
        app = _connection_app_from_item(item)
        if not app:
            continue
        existing_apps[app] = idx
        tools = _PROMPT_CONNECTION_READ_TOOLS.get(app, [])
        if tools:
            connections[idx] = _merge_connection_tools(item, app, tools)
    for app in inferred:
        tools = _PROMPT_CONNECTION_READ_TOOLS.get(app, [])
        if app in existing_apps:
            idx = existing_apps[app]
            connections[idx] = _merge_connection_tools(connections[idx], app, tools)
        else:
            connections.append(_connection_item_with_tools(app, tools))
            existing_apps[app] = len(connections) - 1
    manifest["connections"] = connections


def _repair_missing_operator_output(manifest: Dict[str, Any]) -> None:
    """Every worker needs at least one useful Output-tab field.

    Some creator attempts produce a plausible SKILL.md but forget ``outputs`` in
    worker.yml. That is a deterministic contract miss, not a semantic choice, so
    add the minimal operator-facing markdown summary before verifier review.
    Script-mode workers need their run.py code to produce every declared output,
    so do not add a contract that the generated code may not satisfy.
    """
    if not _entry(manifest).lower().endswith(".md"):
        return
    if _declared_output_names(manifest):
        return
    exec_block = manifest.get("exec")
    if not isinstance(exec_block, dict):
        exec_block = {}
        manifest["exec"] = exec_block
    exec_block["outputs"] = [
        {
            "name": "summary",
            "kind": "scalar",
            "type": "markdown",
            "required": True,
            "label": "Summary",
        }
    ]


def _infer_script_output_names(run_code: str) -> List[str]:
    """Infer result output keys from generated script-mode code.

    Creator attempts sometimes write a good ``result.json``/``_write_result``
    call but forget the matching ``exec.outputs`` YAML contract. Prefer the keys
    already used by the script so the manifest matches runtime behavior.
    """
    if not isinstance(run_code, str) or not run_code.strip():
        return []

    names: List[str] = []
    seen: set[str] = set()

    def add(name: str) -> None:
        clean = str(name or "").strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$", clean):
            return
        if clean not in seen:
            seen.add(clean)
            names.append(clean)

    try:
        tree = ast.parse(run_code)
    except SyntaxError:
        tree = None

    if tree is not None:
        for node in ast.walk(tree):
            candidate: ast.AST | None = None
            if isinstance(node, ast.Call):
                for kw in node.keywords:
                    if kw.arg == "outputs":
                        candidate = kw.value
                        break
            elif isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if isinstance(key, ast.Constant) and key.value == "outputs":
                        candidate = value
                        break
            if isinstance(candidate, ast.Dict):
                for key in candidate.keys:
                    if isinstance(key, ast.Constant) and isinstance(key.value, str):
                        add(key.value)

    if names:
        return names

    for match in re.finditer(r"outputs\s*=\s*\{(?P<body>[^{}]{0,1000})\}", run_code, re.DOTALL):
        for key in re.finditer(r"[\"']([A-Za-z_][A-Za-z0-9_-]{0,63})[\"']\s*:", match.group("body")):
            add(key.group(1))
    return names


def _repair_script_outputs_from_run_code(manifest: Dict[str, Any], run_code: str) -> None:
    if not _entry(manifest).lower().endswith(".py"):
        return
    if _declared_output_names(manifest):
        return

    output_names = _infer_script_output_names(run_code)
    if not output_names:
        output_names = ["summary"]

    exec_block = manifest.get("exec")
    if not isinstance(exec_block, dict):
        exec_block = {}
        manifest["exec"] = exec_block
    exec_block["outputs"] = [
        {
            "name": name,
            "kind": "scalar",
            "type": "markdown" if any(token in name.lower() for token in ("summary", "report", "checklist", "brief", "digest")) else "string",
            "required": True,
            "label": _title_from_worker_id(name.replace("_", "-")),
        }
        for name in output_names
    ]


def _ensure_script_default_summary_output(run_code: str) -> str:
    """Make script-mode fallback output contract executable.

    If the creator emits no declared outputs and no inferable result output key,
    worker-author repairs the manifest with a ``summary`` output. This wrapper
    preserves the generated script but guarantees result.json contains that
    declared key on success, so validation and the Output tab line up.
    """
    if not isinstance(run_code, str) or "summary" in run_code:
        return run_code
    patched = re.sub(
        r"if\s+__name__\s*==\s*[\"']__main__[\"']\s*:\s*\n\s*main\(\)\s*\n?",
        "",
        run_code,
        count=1,
    ).rstrip()
    patched = re.sub(r"\ndef\s+main\s*\(", "\ndef _floom_original_main(", patched, count=1)
    if "_floom_original_main" not in patched:
        return run_code
    return patched + r'''


def main():
    import json as _floom_json
    from pathlib import Path as _FloomPath

    try:
        _floom_original_main()
        result_path = _FloomPath("result.json")
        if result_path.exists():
            try:
                data = _floom_json.loads(result_path.read_text(encoding="utf-8"))
            except Exception:
                data = {"status": "success", "outputs": {}, "artifacts": [], "error": None}
        else:
            data = {"status": "success", "outputs": {}, "artifacts": [], "error": None}
        outputs = data.get("outputs")
        if not isinstance(outputs, dict):
            outputs = {}
        if "summary" not in outputs:
            outputs["summary"] = "Completed successfully."
        data["outputs"] = outputs
        data.setdefault("artifacts", [])
        data.setdefault("error", None)
        result_path.write_text(_floom_json.dumps(data), encoding="utf-8")
    except Exception as exc:
        _FloomPath("result.json").write_text(
            _floom_json.dumps({
                "status": "error",
                "outputs": {},
                "artifacts": [],
                "error": str(exc),
            }),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
'''


def _agent_skill_tool_instructions(manifest: Dict[str, Any], prompt: str) -> str:
    inferred = _infer_connections_from_prompt(prompt)
    lines: List[str] = []
    connections = manifest.get("connections")
    if not isinstance(connections, list):
        return ""
    for item in connections:
        app = _connection_app_from_item(item)
        if not app or (inferred and app not in inferred):
            continue
        tools: List[str] = []
        if isinstance(item, dict) and isinstance(item.get("allowed_tools"), list):
            tools = [str(t) for t in item.get("allowed_tools") if str(t).strip()]
        if not tools:
            tools = _PROMPT_CONNECTION_READ_TOOLS.get(app, [])
        if tools:
            tool_list = ", ".join(f"`{tool}`" for tool in tools)
            lines.append(
                f"- Use `composio__{app}__execute` with allowed tool(s): {tool_list}."
            )
        else:
            lines.append(
                f"- Use `composio__{app}__execute` for the {app} connection. "
                "Use only tools exposed by the runtime; do not invent tool names."
            )
    if not lines:
        return ""
    return "\n\n## Runtime tools\n" + "\n".join(lines) + "\n"


def _ensure_agent_runtime_tool_instructions(
    skill_md: str,
    manifest: Dict[str, Any],
    prompt: str,
) -> str:
    instructions = _agent_skill_tool_instructions(manifest, prompt)
    if not instructions:
        return skill_md
    # Treat this block as generated contract text. Rebuild it from worker.yml so
    # stale or partial model-written tool instructions do not survive repair.
    stripped = re.sub(
        r"\n*## Runtime tools\n.*?(?=\n## |\Z)",
        "",
        str(skill_md or "").rstrip(),
        flags=re.DOTALL,
    )
    return stripped.rstrip() + instructions


def _agent_skill_finish_instruction(manifest: Dict[str, Any]) -> str:
    output_names = _declared_output_names(manifest)
    if not output_names:
        return ""
    example_args = ", ".join(
        f'"{name}": "{_agent_finish_example_value(manifest, name)}"'
        for name in output_names
    )
    names = ", ".join(f"`{name}`" for name in output_names)
    return (
        "\n\n## Finish\n"
        f"When the work is complete, call `finish_with_outputs({{{example_args}}})`. "
        f"Use exactly the declared output name(s): {names}.\n"
    )


def _agent_finish_example_value(manifest: Dict[str, Any], name: str) -> str:
    output = _declared_output_spec(manifest, name)
    output_type = str((output or {}).get("type") or (output or {}).get("media_type") or "").lower()
    if output_type in {"markdown", "text/markdown"} or any(
        token in name.lower() for token in ("summary", "report", "brief", "digest")
    ):
        return f"final markdown content for {name}"
    return f"final value for {name}"


def _agent_skill_has_finish_instruction(skill_md: str) -> bool:
    return "finish_with_outputs" in str(skill_md or "").lower()


def _repair_agent_scalar_output_skill_text(skill_md: str, manifest: Dict[str, Any]) -> str:
    repaired = _repair_scalar_output_path_text(str(skill_md or ""), manifest)
    if any(_is_scalar_output(manifest, name) for name in _declared_output_names(manifest)):
        repaired = re.sub(
            r"\s*Ensure the directory `?out`? exists\.?",
            "",
            repaired,
            flags=re.IGNORECASE,
        )
        repaired = re.sub(
            r"\bConclude your execution once the file is (written|saved)\.?",
            "Conclude your execution after calling `finish_with_outputs`.",
            repaired,
            flags=re.IGNORECASE,
        )
    return repaired


def _repair_scalar_output_path_text(text: str, manifest: Dict[str, Any]) -> str:
    repaired = str(text or "")
    for name in _declared_output_names(manifest):
        output = _declared_output_spec(manifest, name) or {}
        if not _is_scalar_output(manifest, name):
            continue
        safe_name = re.escape(name)
        repaired = re.sub(
            rf"`?out/{safe_name}\.(md|txt)`?",
            f"the `{name}` output",
            repaired,
            flags=re.IGNORECASE,
        )
    return repaired


def _is_scalar_output(manifest: Dict[str, Any], name: str) -> bool:
    output = _declared_output_spec(manifest, name) or {}
    kind = str(output.get("kind") or "").lower()
    output_type = str(output.get("type") or "").lower()
    if kind and kind != "scalar":
        return False
    return output_type in {"markdown", "text", "textarea", "string"}


def _repair_manifest_scalar_output_text_fields(value: Any, manifest: Dict[str, Any]) -> Any:
    if isinstance(value, str):
        return _repair_scalar_output_path_text(value, manifest)
    if isinstance(value, list):
        return [_repair_manifest_scalar_output_text_fields(item, manifest) for item in value]
    if isinstance(value, dict):
        return {
            key: _repair_manifest_scalar_output_text_fields(item, manifest)
            for key, item in value.items()
        }
    return value


def _repair_agent_invalid_tool_references(skill_md: str, manifest: Dict[str, Any]) -> str:
    repaired = str(skill_md or "")
    connections = manifest.get("connections")
    if not isinstance(connections, list):
        return repaired
    for item in connections:
        app = _connection_app_from_item(item)
        if not app:
            continue
        allowed_tools = _connection_allowed_tools(item)
        app_re = re.escape(app)
        repaired = re.sub(
            rf"\bcomposio__{app_re}\b(?!__execute)",
            f"composio__{app}__execute",
            repaired,
        )
        repaired = re.sub(
            rf"\bcomposio__{app_re}__(?!execute\b)[A-Za-z_][A-Za-z0-9_]*\b",
            f"composio__{app}__execute",
            repaired,
        )
        for tool in allowed_tools:
            repaired = re.sub(
                rf"\b{re.escape(tool)}\b",
                tool,
                repaired,
                flags=re.IGNORECASE,
            )
        for bad_slug in _invalid_allowed_tool_slug_references(
            repaired,
            allowed_tools,
            ignored_names=_declared_input_names(manifest) + _declared_output_names(manifest),
        ):
            replacement = _closest_allowed_tool_slug(bad_slug, allowed_tools)
            if replacement:
                repaired = re.sub(rf"\b{re.escape(bad_slug)}\b", replacement, repaired)
    return repaired


def _closest_allowed_tool_slug(slug: str, allowed_tools: List[str]) -> str:
    allowed = [tool for tool in allowed_tools if tool]
    if not allowed:
        return ""
    slug_raw = _tool_slug_raw_tokens(slug)
    slug_tokens = _tool_slug_tokens(slug)
    best = allowed[0]
    best_score = -1
    for candidate in allowed:
        candidate_raw = _tool_slug_raw_tokens(candidate)
        score = (3 * len(slug_raw & candidate_raw)) + len(slug_tokens & _tool_slug_tokens(candidate))
        if score > best_score:
            best = candidate
            best_score = score
    return best


def _tool_slug_raw_tokens(slug: str) -> set[str]:
    return {part for part in re.split(r"[^A-Z0-9]+", str(slug).upper()) if part}


def _tool_slug_tokens(slug: str) -> set[str]:
    raw = _tool_slug_raw_tokens(slug)
    out = set(raw)
    if "MESSAGE" in raw or "MESSAGES" in raw or "EMAIL" in raw or "EMAILS" in raw:
        out.update({"MESSAGE", "MESSAGES", "EMAIL", "EMAILS"})
    if "GET" in raw or "FETCH" in raw:
        out.update({"GET", "FETCH"})
    if "LIST" in raw or "SEARCH" in raw:
        out.update({"LIST", "SEARCH"})
    return out


def _scalar_output_path_references(skill_md: str, manifest: Dict[str, Any]) -> List[str]:
    refs: List[str] = []
    text = str(skill_md or "")
    for name in _declared_output_names(manifest):
        if not _is_scalar_output(manifest, name):
            continue
        if re.search(rf"\bout/{re.escape(name)}\.(md|txt)\b", text, re.IGNORECASE):
            refs.append(f"out/{name}.md")
    return refs


def _invented_app_tool_references(skill_md: str, app: str) -> List[str]:
    text = str(skill_md or "")
    app_re = re.escape(app)
    refs: List[str] = []
    seen: set[str] = set()
    patterns = [
        rf"\b{app_re}\.[A-Za-z_][A-Za-z0-9_]*\b",
        rf"\bcomposio__{app_re}__(?!execute\b)[A-Za-z_][A-Za-z0-9_]*\b",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            ref = match.group(0)
            if ref not in seen:
                seen.add(ref)
                refs.append(ref)
    return refs


def _invalid_allowed_tool_slug_references(
    skill_md: str,
    allowed_tools: List[str],
    *,
    ignored_names: List[str] | None = None,
) -> List[str]:
    allowed = {str(tool).strip() for tool in allowed_tools if str(tool).strip()}
    prefixes = {tool.split("_", 1)[0] for tool in allowed if "_" in tool}
    if not prefixes:
        return []
    allowed_upper = {tool.upper() for tool in allowed}
    prefixes_upper = {prefix.upper() for prefix in prefixes}
    ignored_upper = {str(name).strip().upper() for name in ignored_names or [] if str(name).strip()}
    refs: List[str] = []
    seen: set[str] = set()
    for match in re.finditer(r"\b[A-Za-z][A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b", str(skill_md or "")):
        ref = match.group(0)
        if ref.upper() in ignored_upper:
            continue
        if ref.upper() in allowed_upper:
            continue
        if ref.split("_", 1)[0].upper() not in prefixes_upper:
            continue
        if ref not in seen:
            seen.add(ref)
            refs.append(ref)
    return refs


def _connection_allowed_tools(item: Any) -> List[str]:
    if isinstance(item, dict) and isinstance(item.get("allowed_tools"), list):
        return [str(tool) for tool in item.get("allowed_tools") if str(tool).strip()]
    return []


def _declared_output_spec(manifest: Dict[str, Any], name: str) -> Dict[str, Any] | None:
    exec_block = _exec_block(manifest)
    outputs = exec_block.get("outputs")
    if not isinstance(outputs, list):
        return None
    for item in outputs:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def _repair_agent_markdown_outputs(manifest: Dict[str, Any]) -> None:
    if not _entry(manifest).lower().endswith(".md"):
        return
    exec_block = _exec_block(manifest)
    outputs = exec_block.get("outputs")
    if not isinstance(outputs, list):
        return
    for item in outputs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").lower()
        media_type = str(item.get("media_type") or "").lower()
        output_type = str(item.get("type") or "").lower()
        if not any(token in name for token in ("summary", "report", "brief", "digest")):
            continue
        if item.get("kind") == "file" or media_type == "text/markdown" or output_type in {"file", "markdown"}:
            item["kind"] = "scalar"
            item["type"] = "markdown"
            item.pop("media_type", None)
            item.pop("path", None)


def _repair_generated_bundle(parsed: Dict[str, Any], prompt: str) -> Dict[str, Any]:
    worker_yml = parsed.get("worker_yml")
    if not isinstance(worker_yml, str) or not worker_yml.strip():
        return parsed
    manifest = _load_manifest(worker_yml)
    if not isinstance(manifest, dict):
        return parsed
    repaired_manifest = _repair_generated_worker_manifest(
        manifest,
        prompt=prompt,
        suggested_id=str(parsed.get("suggested_id") or ""),
    )
    out = dict(parsed)
    run_code = out.get("run_code")
    if isinstance(run_code, str):
        had_output_names = bool(_declared_output_names(repaired_manifest))
        inferred_names = _infer_script_output_names(run_code)
        _repair_script_outputs_from_run_code(repaired_manifest, run_code)
        if _entry(repaired_manifest).lower().endswith(".py") and not had_output_names and not inferred_names:
            out["run_code"] = _ensure_script_default_summary_output(run_code)
    try:
        import yaml as pyyaml

        out["worker_yml"] = pyyaml.safe_dump(
            repaired_manifest,
            sort_keys=False,
            default_flow_style=False,
        )
    except Exception:
        pass

    if _entry(repaired_manifest).lower().endswith(".md"):
        skill_md = out.get("skill_md")
        if isinstance(skill_md, str):
            skill_md = _repair_agent_scalar_output_skill_text(skill_md, repaired_manifest)
            skill_md = _repair_agent_invalid_tool_references(skill_md, repaired_manifest)
            skill_md = _ensure_agent_runtime_tool_instructions(skill_md, repaired_manifest, prompt)
            out["skill_md"] = skill_md
            finish_instruction = _agent_skill_finish_instruction(repaired_manifest)
            if finish_instruction and not _agent_skill_has_finish_instruction(skill_md):
                out["skill_md"] = skill_md.rstrip() + finish_instruction
    return out


def _bundle_verifier_payload(parsed: Dict[str, Any], prompt: str) -> Dict[str, Any]:
    return {
        "prompt": prompt,
        "worker_yml": parsed.get("worker_yml"),
        "skill_md": parsed.get("skill_md"),
        "run_code": parsed.get("run_code"),
        "sample_input_json": parsed.get("sample_input_json"),
    }


def _deterministic_verifier_issues(parsed: Dict[str, Any], prompt: str) -> List[str]:
    issues: List[str] = []
    worker_yml = parsed.get("worker_yml")
    manifest = _load_manifest(worker_yml) if isinstance(worker_yml, str) else None
    if not isinstance(manifest, dict):
        return ["worker_yml is not parseable YAML"]
    manifest = _repair_generated_worker_manifest(
        manifest,
        prompt=prompt,
        suggested_id=str(parsed.get("suggested_id") or ""),
    )

    inferred = _infer_connections_from_prompt(prompt)
    connections = manifest.get("connections")
    connection_apps = {
        app for app in (_connection_app_from_item(item) for item in connections or []) if app
    } if isinstance(connections, list) else set()
    for app in inferred:
        if app not in connection_apps:
            issues.append(f"prompt requires {app}, but worker.yml does not declare that connection")

    entry = _entry(manifest).lower()
    if entry.endswith(".md"):
        skill_md = str(parsed.get("skill_md") or "")
        lower_skill = skill_md.lower()
        if not _agent_skill_has_finish_instruction(skill_md):
            issues.append("SKILL.md does not instruct the agent to call finish_with_outputs")
        scalar_path_refs = _scalar_output_path_references(skill_md, manifest)
        if scalar_path_refs:
            issues.append(
                "SKILL.md tells the agent to write a file path for scalar output(s): "
                + ", ".join(scalar_path_refs)
            )
        if any(_is_scalar_output(manifest, name) for name in _declared_output_names(manifest)):
            if re.search(r"\bdirectory `?out`? exists\b", skill_md, re.IGNORECASE):
                issues.append("SKILL.md tells the agent to manage the out directory for scalar outputs")
            if re.search(r"\bfile is (written|saved)\b", skill_md, re.IGNORECASE):
                issues.append("SKILL.md tells the agent to finish after writing a file for scalar outputs")
        for app in inferred:
            if f"composio__{app}__execute" not in lower_skill:
                issues.append(f"SKILL.md does not tell the agent to call composio__{app}__execute")
            known_tools = _PROMPT_CONNECTION_READ_TOOLS.get(app, [])
            if known_tools and not any(tool in skill_md for tool in known_tools):
                issues.append(f"SKILL.md does not name any known {app} runtime tool")
            invented_refs = _invented_app_tool_references(skill_md, app)
            if invented_refs:
                issues.append(
                    f"SKILL.md references invented {app} tool names: {', '.join(invented_refs)}. "
                    f"Use composio__{app}__execute with allowed tool slugs instead."
                )
            connection_item = next(
                (
                    item
                    for item in connections or []
                    if _connection_app_from_item(item) == app
                ),
                None,
            )
            invalid_slugs = _invalid_allowed_tool_slug_references(
                skill_md,
                _connection_allowed_tools(connection_item),
                ignored_names=_declared_input_names(manifest) + _declared_output_names(manifest),
            )
            if invalid_slugs:
                issues.append(
                    f"SKILL.md references {app} tool slug(s) not declared in allowed_tools: "
                    + ", ".join(invalid_slugs)
                )
    elif entry.endswith(".py"):
        run_code = str(parsed.get("run_code") or "")
        for app in inferred:
            if app in _PROMPT_CONNECTION_READ_TOOLS and not any(
                tool in run_code for tool in _PROMPT_CONNECTION_READ_TOOLS[app]
            ):
                issues.append(f"run_code does not call any known {app} tool")

    if any(t == "schedule" for t in _trigger_types(manifest)):
        exec_block = _exec_block(manifest)
        missing_defaults: List[str] = []
        raw_inputs = exec_block.get("inputs")
        if isinstance(raw_inputs, list):
            for item in raw_inputs:
                if isinstance(item, dict) and item.get("required") is True and "default" not in item:
                    missing_defaults.append(str(item.get("name") or "<unnamed>"))
        if missing_defaults:
            issues.append("scheduled worker has required inputs without defaults: " + ", ".join(missing_defaults))

    if not _declared_output_names(manifest):
        issues.append("worker.yml declares no outputs")
    return issues


def _verify_bundle_with_model(parsed: Dict[str, Any], prompt: str, log: Any) -> List[str]:
    """Independent LLM reviewer for semantic worker quality.

    Deterministic validation catches hard contract bugs; this reviewer catches
    under-specified or nonsensical workers before create-mode persists them. It
    returns issue strings only. Any provider failure is logged and treated as an
    empty reviewer result so worker-author remains available during provider
    incidents; deterministic issues still gate the bundle.
    """
    verifier_prompt = (
        "You are verifying a Floom worker bundle generated by another model. "
        "Return ONLY JSON: {\"ok\": boolean, \"issues\": string[]}.\n"
        "Check that the worker does exactly the user prompt, declares every "
        "required integration, names real runtime tool calls in SKILL.md or "
        "run.py, has schedule defaults, has useful operator-facing outputs, "
        "and contains no placeholders or invented capabilities.\n\n"
        + json.dumps(_bundle_verifier_payload(parsed, prompt), ensure_ascii=True)[:12000]
    )
    try:
        resp = _codegen_chat(
            messages=[
                {"role": "system", "content": "You are a strict reviewer. Output JSON only."},
                {"role": "user", "content": verifier_prompt},
            ],
            temperature=0.0,
            max_output_tokens=1200,
            response_format={"type": "json_object"},
        )
        raw = (resp.choices[0].message.content or "").strip()
        result = _extract_json_object(raw)
        raw_issues = result.get("issues")
        if result.get("ok") is True:
            return []
        if isinstance(raw_issues, list):
            return [str(issue).strip() for issue in raw_issues if str(issue).strip()]
        return ["verifier returned ok=false without structured issues"]
    except Exception as exc:  # noqa: BLE001 - verifier must not hard-fail generation
        log(f"worker-author verifier skipped after provider error: {exc}", level="warning")
        return []


def _repair_generated_worker_manifest(
    manifest: Dict[str, Any],
    *,
    prompt: str = "",
    suggested_id: str = "",
) -> Dict[str, Any]:
    """Normalize tiny schema drift in generated WorkerContract YAML."""
    repaired = dict(manifest)
    schema_version = repaired.get("schema_version")
    if schema_version is not None and not isinstance(schema_version, str):
        repaired["schema_version"] = str(schema_version)
    name = repaired.get("name")
    if not isinstance(name, str) or not name.strip():
        repaired["name"] = (suggested_id or _suggested_id_from_prompt(prompt)).strip()
    else:
        repaired["name"] = name.strip()
    if not isinstance(repaired.get("title"), str) or not str(repaired.get("title") or "").strip():
        repaired["title"] = _title_from_worker_id(str(repaired.get("name") or ""))
    if not isinstance(repaired.get("description"), str) or not str(repaired.get("description") or "").strip():
        repaired["description"] = _description_from_prompt(prompt, str(repaired.get("title") or "Generated Worker"))
    if repaired.get("schema_version") == "0.3":
        version = repaired.get("version")
        if not isinstance(version, str) or not version.strip():
            repaired["version"] = "0.1.0"
        elif not version:
            repaired["version"] = "0.1.0"
    trigger = repaired.get("trigger")
    if isinstance(trigger, list):
        trigger_items = [item for item in trigger if isinstance(item, dict)]
        if len(trigger_items) == 1 and "triggers" not in repaired:
            repaired["trigger"] = trigger_items[0]
    if "version" in repaired and repaired["version"] is not None and not isinstance(repaired["version"], str):
        repaired["version"] = str(repaired["version"])
    exec_block = repaired.get("exec")
    if isinstance(exec_block, dict):
        repaired_exec = dict(exec_block)
        for key in ("inputs", "outputs"):
            if key in repaired_exec:
                repaired_exec[key] = _normalize_named_schema_list(repaired_exec[key])
        repaired["exec"] = repaired_exec
    _repair_credential_inputs_to_secrets(repaired, prompt)
    _repair_prompt_declared_connections(repaired, prompt)
    _repair_missing_operator_output(repaired)
    _repair_agent_markdown_outputs(repaired)
    _repair_agent_integration_limits(repaired)
    repaired = _repair_manifest_scalar_output_text_fields(repaired, repaired)
    return repaired


def _repair_agent_integration_limits(manifest: Dict[str, Any]) -> None:
    if not _entry(manifest).lower().endswith(".md"):
        return
    connections = manifest.get("connections")
    has_connections = isinstance(connections, list) and any(
        _connection_app_from_item(item) for item in connections
    )
    if not has_connections:
        return
    limits = manifest.get("limits")
    if not isinstance(limits, dict):
        limits = {}
    desired = {
        "max_tool_iterations": 60,
        "max_output_tokens": 100000,
        "max_total_tokens": 1000000,
        "timeout_seconds": 300,
    }
    for key, value in desired.items():
        current = limits.get(key)
        try:
            current_int = int(current)
        except (TypeError, ValueError):
            current_int = 0
        limits[key] = max(current_int, value)
    manifest["limits"] = limits


def _normalize_named_schema_list(value: Any) -> Any:
    """Convert Gemini-style named schema maps to WorkerContract lists."""
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return value
    normalized: List[Dict[str, Any]] = []
    for name, spec in value.items():
        item: Dict[str, Any] = {"name": str(name)}
        if isinstance(spec, dict):
            item.update(spec)
            item["name"] = str(item.get("name") or name)
        elif spec is not None:
            item["type"] = str(spec)
        normalized.append(item)
    return normalized


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


def _declared_input_names(manifest: Dict[str, Any]) -> List[str]:
    exec_block = _exec_block(manifest)
    raw_inputs = exec_block.get("inputs")
    if not isinstance(raw_inputs, list):
        raw_inputs = manifest.get("inputs")
    if not isinstance(raw_inputs, list):
        return []
    names: List[str] = []
    for item in raw_inputs:
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

    yaml_error = _validate_worker_yml(
        worker_yml,
        prompt=prompt,
        suggested_id=str(parsed.get("suggested_id") or ""),
    )
    if yaml_error:
        return yaml_error

    manifest = _repair_generated_worker_manifest(
        _load_manifest(worker_yml) or {},
        prompt=prompt,
        suggested_id=str(parsed.get("suggested_id") or ""),
    )
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
        for app in _infer_connections_from_prompt(prompt):
            tools = _PROMPT_CONNECTION_READ_TOOLS.get(app, [])
            lower_skill = skill_md.lower()
            if f"composio__{app}__execute" not in lower_skill:
                return f"skill_md must instruct the agent to call composio__{app}__execute"
            if tools and not any(tool in skill_md for tool in tools):
                return f"skill_md must name at least one known {app} runtime tool"

    return None


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_HEADER = """You are the Worker Author — a meta-worker that generates Floom worker bundles from natural-language descriptions.

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
- Script mode MUST declare exec.outputs matching the exact keys written in
  result.json outputs. If run.py writes `_write_result("success",
  outputs={"checklist": checklist})`, worker.yml MUST declare an output named
  `checklist`. Never return script-mode YAML with no outputs.
- A separate verifier will reject bundles that merely look plausible. If the
  prompt names an integration, worker.yml must declare it in top-level
  connections, and SKILL.md/run.py must explicitly describe the runtime tool
  call path, for example `composio__<app>__execute` plus concrete allowed tool
  slugs when known. Do not create workers that cannot actually reach the
  integration they claim to use.
- Agent-mode workers that use integrations/tool calls MUST include top-level
  limits with max_tool_iterations: 60, max_output_tokens: 100000,
  max_total_tokens: 1000000, and timeout_seconds: 300. This is required for
  Gmail/email/CRM/Slack/GitHub/Calendar and other Composio-backed tools because
  tool responses can be large and multi-step.

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
- trigger MUST be a single YAML mapping, never a list. Use `trigger:\n  type: "schedule"` not `trigger:\n- type: "schedule"`.
- if you include "use_cases", it MUST contain EXACTLY 3 to 5 short items; otherwise omit the field entirely
- if you include "tags", it MUST contain 8 or fewer flat (no "/") non-empty strings; otherwise omit it
- inputs are business/runtime parameters only. NEVER declare API keys, tokens,
  passwords, private keys, client secrets, OAuth credentials, or connection
  credentials as inputs. Put credential names in exec.secrets instead (for
  example LINEAR_API_KEY), and put OAuth-style app access in top-level
  connections (for example connections: ["linear"]).
- KISS and YAGNI: the smallest bundle that does exactly what was described

Output media_type rule for worker.yml (CRITICAL — wrong media_type makes a correct worker look broken):
- Every generated worker MUST declare at least one operator-facing output that
  reads well in the Output tab. For Gmail/email/CRM/digest/report workers, this
  is usually a markdown/text field such as `summary`, `digest`, `report`, or
  `notification` containing the actual result the operator asked for.
- Raw files, JSON bundles, CSV exports, attachments, and logs are secondary
  artifacts. Never make the only visible output a raw bundle path, a log path, or
  a JSON file unless the user explicitly asked for file conversion/export.
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

    user_parts = [f"Design a Floom worker for this task:\n\n{prompt}"]
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
        try:
            parsed = _extract_json_object(raw)
        except json.JSONDecodeError as exc:
            last_error = f"LLM returned non-JSON: {exc}"
            log(f"worker-author: attempt {attempt} JSON parse error: {exc}", level="warning")
            continue
        parsed = _repair_generated_bundle(parsed, prompt)

        worker_yml = parsed.get("worker_yml", "")
        if not worker_yml:
            last_error = "worker_yml is empty"
            log(f"worker-author: attempt {attempt} empty worker_yml", level="warning")
            continue

        verifier_issues = _deterministic_verifier_issues(parsed, prompt)
        if not verifier_issues:
            verifier_issues.extend(_verify_bundle_with_model(parsed, prompt, log))
        if verifier_issues:
            # De-dupe while preserving order so the next creator attempt gets a
            # concise, actionable punch list.
            seen_issues: set[str] = set()
            unique_issues = []
            for issue in verifier_issues:
                if issue not in seen_issues:
                    unique_issues.append(issue)
                    seen_issues.add(issue)
            last_error = "Verifier rejected bundle: " + "; ".join(unique_issues[:8])
            log(f"worker-author: attempt {attempt} verifier failed: {last_error}", level="warning")
            continue

        validation_error = _validate_generated_bundle(parsed, prompt)
        if validation_error:
            last_error = validation_error
            log(f"worker-author: attempt {attempt} validation failed: {validation_error}", level="warning")
            continue

        import yaml as pyyaml

        repaired_manifest = _repair_generated_worker_manifest(
            _load_manifest(worker_yml) or {},
            prompt=prompt,
            suggested_id=str(parsed.get("suggested_id") or ""),
        )
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


def _bundle_summary(bundle: Dict[str, Any], mode: str) -> str:
    worker_yml = str(bundle.get("worker_yml") or "")
    suggested_id = str(bundle.get("suggested_id") or "").strip() or "new-worker"
    error = str(bundle.get("error") or "").strip()
    title = suggested_id.replace("-", " ").strip().title() or "New Worker"
    description = ""
    for line in worker_yml.splitlines():
        stripped = line.strip()
        if stripped.startswith("title:"):
            title = stripped.split(":", 1)[1].strip().strip("\"'") or title
        elif stripped.startswith("description:") and not description:
            description = stripped.split(":", 1)[1].strip().strip("\"'")

    lines = [
        f"## {title}",
        "",
        f"Worker id: `{suggested_id}`",
    ]
    if description:
        lines.extend(["", description])
    lines.extend(
        [
            "",
            "Generated a runnable worker bundle. Review the bundle file below, then open the worker from Workers to edit or run it.",
        ]
    )
    if mode == "create":
        lines.append("The platform will register this worker automatically when the run completes.")
    if error:
        lines.extend(["", f"Generation warning: {error}"])
    return "\n".join(lines)


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

    mode = str(inputs.get("mode") or "draft").strip().lower()
    result = {
        "status": "success",
        "outputs": {
            "summary": _bundle_summary(bundle, mode),
            "bundle": "out/bundle.json",
        },
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
