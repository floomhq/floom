"""E2B cloud sandbox driver for Floom - uses e2b SDK 2.x.

Worker protocol: run.py in an E2B worker reads inputs from inputs.json and
MUST write result.json with:
  {"status": "success"|"error", "outputs": {...}, "error": null|"..."}
"""

import json
import logging
import os
import io
import re
import shlex
import shutil
import tarfile
import threading
import time
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

from .base import SandboxDriver
from .cancellation import run_cancel_requested
from .e2b_upload import upload_tree_tarball
from .memory_context import ensure_memory_context_pack
from models import WorkerConfig, WorkerResult, assert_safe_outbound_url
import contexts as _contexts_module
from contexts import (
    CONTEXTS_DIR,
    context_mount_matches_inputs,
    context_tree_summary,
    context_scope_for_user,
    load_context_metadata,
    normalize_context_mount,
    use_context_scope,
)
from runner_utils import ARTIFACTS_DIR
from runtime_limits import (
    DEFAULT_RUN_TIMEOUT_SECONDS,
    E2B_MAX_SANDBOX_LIFETIME_SECONDS,
    MAX_RUN_TIMEOUT_SECONDS,
    MIN_INSTALL_TIMEOUT_SECONDS,
    SANDBOX_LIFETIME_BUFFER_SECONDS,
)
from worker_registry import WORKERS_DIR

logger = logging.getLogger("floom.runner_sandbox.e2b")

MAX_E2B_SANDBOX_LIFETIME_SECONDS = E2B_MAX_SANDBOX_LIFETIME_SECONDS
# Hard cap on the raw result.json the worker writes. Read + json.loads +
# persist into the run `output_json` DB column all happen on this blob, so an
# unbounded multi-MB output bloats the DB row and the run-detail response.
# Reject above this with a clear error instead of silently ingesting it.
MAX_RESULT_JSON_BYTES = 5 * 1024 * 1024  # 5 MiB
# #1041 - bound writeback-tar extraction so a sandboxed worker cannot OOM the
# API host with an arbitrarily large context file. Each member is read fully
# into memory (extracted.read()), so cap both per-member and total bytes.
MAX_CONTEXT_TAR_MEMBER_BYTES = 100 * 1024 * 1024  # 100 MiB per member
MAX_CONTEXT_TAR_TOTAL_BYTES = 250 * 1024 * 1024  # 250 MiB total per extraction
E2B_COMMAND_REQUEST_TIMEOUT_BUFFER_SECONDS = 60
E2B_INSTALL_COMMAND_MIN_REQUEST_TIMEOUT_SECONDS = 300
MAX_WORKER_ERROR_OUTPUT_CHARS = 1000
_OOM_EXIT_CODES = {137, -9}
_OOM_MARKERS = (
    "code 137",
    "exit 137",
    "exit code 137",
    "exited with code 137",
    "memoryerror",
    "out of memory",
    "oom-kill",
    "oom killed",
    "memory cgroup out of memory",
    "killed process",
)
_active_sandboxes: dict[str, Any] = {}
_active_sandboxes_lock = threading.Lock()


@dataclass
class _WarmSandboxEntry:
    key: str
    sandbox: Any
    workdir: str
    mounted_contexts: set[str]
    writeable_contexts: set[str] = field(default_factory=set)
    created_at: float = field(default_factory=time.monotonic)
    last_used_at: float = field(default_factory=time.monotonic)
    uses: int = 0


_warm_pool: dict[str, list[_WarmSandboxEntry]] = {}
_warm_pool_lock = threading.Lock()


def _warm_pool_enabled() -> bool:
    return _env_truthy("WORKEROS_E2B_WARM_POOL_ENABLED")


def _warm_pool_size_per_key() -> int:
    try:
        return max(0, int(os.environ.get("WORKEROS_E2B_WARM_POOL_SIZE_PER_KEY", "1")))
    except ValueError:
        return 1


def _warm_pool_max_age_seconds() -> int:
    try:
        return max(60, int(os.environ.get("WORKEROS_E2B_WARM_POOL_MAX_AGE_SECONDS", "900")))
    except ValueError:
        return 900


def _sandbox_alive(sandbox: Any, workdir: str) -> bool:
    try:
        return bool(sandbox.files.exists(workdir, request_timeout=10))
    except Exception:
        return False


def _kill_sandbox_quietly(sandbox: Any) -> None:
    try:
        sandbox.kill()
    except Exception:
        logger.debug("E2B sandbox kill suppressed", exc_info=True)


def _warm_pool_lease(key: str, *, log_fn: Callable[[str, str], None]) -> _WarmSandboxEntry | None:
    if not _warm_pool_enabled() or not key:
        return None
    now = time.monotonic()
    max_age = _warm_pool_max_age_seconds()
    while True:
        with _warm_pool_lock:
            entries = _warm_pool.get(key) or []
            entry = entries.pop() if entries else None
            if entries:
                _warm_pool[key] = entries
            else:
                _warm_pool.pop(key, None)
        if entry is None:
            return None
        if now - entry.created_at > max_age:
            _kill_sandbox_quietly(entry.sandbox)
            continue
        if not _sandbox_alive(entry.sandbox, entry.workdir):
            _kill_sandbox_quietly(entry.sandbox)
            continue
        entry.uses += 1
        entry.last_used_at = now
        log_fn(f"[e2b] Reusing warm sandbox for key {key[:12]}", "info")
        return entry


def _warm_pool_return(entry: _WarmSandboxEntry, *, log_fn: Callable[[str, str], None]) -> bool:
    if not _warm_pool_enabled() or _warm_pool_size_per_key() <= 0:
        _kill_sandbox_quietly(entry.sandbox)
        return False
    if not _sandbox_alive(entry.sandbox, entry.workdir):
        _kill_sandbox_quietly(entry.sandbox)
        return False
    entry.last_used_at = time.monotonic()
    with _warm_pool_lock:
        entries = _warm_pool.setdefault(entry.key, [])
        entries.append(entry)
        max_size = _warm_pool_size_per_key()
        overflow: list[_WarmSandboxEntry] = []
        while len(entries) > max_size:
            overflow.append(entries.pop(0))
    for stale in overflow:
        _kill_sandbox_quietly(stale.sandbox)
    log_fn(f"[e2b] Returned sandbox to warm pool for key {entry.key[:12]}", "debug")
    return True


def clear_warm_pool() -> int:
    """Kill and remove all warm sandboxes. Used by tests and shutdown hooks."""
    with _warm_pool_lock:
        entries = [entry for bucket in _warm_pool.values() for entry in bucket]
        _warm_pool.clear()
    for entry in entries:
        _kill_sandbox_quietly(entry.sandbox)
    return len(entries)


def warm_pool_size() -> int:
    with _warm_pool_lock:
        return sum(len(bucket) for bucket in _warm_pool.values())


def _safe_git_context_url(source: str) -> str:
    repo_url = source.removeprefix("git+").strip()
    if urlsplit(repo_url).scheme.lower() != "https":
        raise ValueError("Git context URL must use https://")
    return assert_safe_outbound_url(repo_url, label="Git context URL")


_DEFAULT_E2B_DENY_OUT = (
    # NOTE: "0.0.0.0/8" intentionally omitted - E2B's network-policy API rejects it
    # ("400: invalid denied CIDR 0.0.0.0/8"), which kills sandbox creation for any
    # egress worker (e.g. worker-author). It's the non-routable "this network"
    # reserved range (RFC 1122), not a real SSRF target, so the loss is negligible;
    # the actual private/link-local/metadata ranges below still block SSRF.
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
    "localhost",
    "metadata.google.internal",
)


class E2BKeyExhaustedError(RuntimeError):
    """Raised when every configured E2B key is quota/rate-limit exhausted."""


_WORKER_AUTHOR_ID = "worker-author"


class _E2BPerfTimer:
    """Small stopwatch for sandbox startup attribution logs."""

    def __init__(self) -> None:
        self._start = time.monotonic()
        self._last = self._start
        self._marks: list[tuple[str, float, float]] = []

    def mark(self, label: str) -> None:
        now = time.monotonic()
        self._marks.append((label, (now - self._last) * 1000.0, (now - self._start) * 1000.0))
        self._last = now

    def log(self, log_fn: Callable[[str, str], None], label: str, *, level: str = "debug") -> None:
        if os.environ.get("WORKEROS_RUN_PERF_LOGS", "1").strip().lower() in {"0", "false", "no", "off"}:
            return
        if not self._marks:
            return
        total_ms = (time.monotonic() - self._start) * 1000.0
        segments = ", ".join(
            f"{name}={delta_ms:.1f}ms/{total_ms_at_mark:.1f}ms"
            for name, delta_ms, total_ms_at_mark in self._marks
        )
        log_fn(f"[perf] {label} total={total_ms:.1f}ms segments: {segments}", level)
_WORKER_AUTHOR_PROVIDER_ENV_VARS = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION_NAME",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "PLATFORM_OPENAI_API_KEY",
    "OPENAI_API_KEY",
    # worker-author smoke-tests the worker it generates in a NESTED E2B sandbox,
    # which reads the E2B key from *this* sandbox's env. Without it the nested run
    # fails with "Invalid API key format". Normal workers never self-test, so they
    # never needed E2B creds inside the sandbox - only worker-author does.
    "E2B_API_KEY",
    "E2B_API_KEY_FALLBACK",
    "E2B_API_KEYS",
)

# #977: internal vars the WORKER process must never see. The worker-author
# meta-worker legitimately needs the codegen model; everything else here is
# infrastructure detail (E2B sandbox/template ids, events address) that lets
# an attacker who can run a worker probe or target our infra. Callback vars
# (WORKEROS_API_URL, WORKEROS_RUN_TOKEN, FLOOM_RUN_ID/TRACE_ID) are by design
# and intentionally NOT scrubbed.
_E2B_INTERNAL_ENV_VARS = (
    "E2B_TEMPLATE_ID",
    "E2B_SANDBOX_ID",
    "E2B_EVENTS_ADDRESS",
)


def _scrub_internal_env_command(command: str, worker_id: str | None) -> str:
    """Wrap the worker command so internal infra env vars are unset for it.

    Uses `env -u` so the worker's `os.environ` never carries the E2B sandbox/
    template ids or the codegen model (except for the worker-author worker,
    which needs the model). Idempotent and shell-safe: the original command is
    passed through `sh -c` unchanged.
    """
    to_unset = list(_E2B_INTERNAL_ENV_VARS)
    if worker_id != _WORKER_AUTHOR_ID:
        to_unset.append("WORKEROS_CODEGEN_MODEL")
    unset_flags = " ".join(f"-u {name}" for name in to_unset)
    return f"env {unset_flags} sh -c {shlex.quote(command)}"


def _worker_author_platform_env() -> dict[str, str]:
    """Platform LLM env allowed only for the first-party worker-author."""
    env: dict[str, str] = {}
    try:
        from codegen_model import codegen_model

        model = codegen_model()
    except Exception:
        model = (os.environ.get("WORKEROS_CODEGEN_MODEL") or os.environ.get("WORKEROS_CHAT_MODEL") or "").strip()
    if model:
        env["WORKEROS_CODEGEN_MODEL"] = model
    for name in _WORKER_AUTHOR_PROVIDER_ENV_VARS:
        value = (os.environ.get(name) or "").strip()
        if value:
            env[name] = value
    return env


def _llm_gateway_env() -> dict[str, str]:
    """#1448: route a worker's LLM calls through the managed LiteLLM gateway.

    When WORKEROS_LLM_GATEWAY_URL is set, point the OpenAI-compatible base URL
    (which the OpenAI SDK and litellm both honour) at the gateway and supply the
    shared virtual key. The gateway pools provider quota, applies shared backoff,
    and does multi-region round-robin, so concurrent judge-heavy runs no longer
    each hammer the raw provider and 429 the shared quota (#1448).

    Unset (the default) -> returns {} -> workers call providers directly with
    their own keys (today's behaviour). This is the kill-switch: clearing the env
    var instantly reverts to direct calls.
    """
    url = (os.environ.get("WORKEROS_LLM_GATEWAY_URL") or "").strip().rstrip("/")
    if not url:
        return {}
    env = {
        "OPENAI_BASE_URL": url,   # openai-python >= 1.x
        "OPENAI_API_BASE": url,   # litellm + older openai
    }
    key = (os.environ.get("WORKEROS_LLM_GATEWAY_KEY") or "").strip()
    if key:
        # The gateway holds the real provider keys; the worker presents only this
        # shared virtual key, so per-worker raw keys no longer set the rate ceiling.
        env["OPENAI_API_KEY"] = key
    return env


def _csv_env(name: str) -> list[str]:
    return [part.strip() for part in (os.environ.get(name) or "").split(",") if part.strip()]


def _host_from_url(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
    except Exception:
        return None
    return parsed.hostname or None


def _platform_egress_hosts(api_url: str | None = None) -> list[str]:
    hosts = [
        _host_from_url(api_url),
        _host_from_url(os.environ.get("WORKEROS_E2B_API_URL")),
        _host_from_url(os.environ.get("WORKEROS_API_URL")),
        _host_from_url(os.environ.get("WORKEROS_API_BASE")),
        _host_from_url(os.environ.get("COMPOSIO_API_BASE") or "https://backend.composio.dev"),
        # #1448: the managed LLM gateway must be reachable from the sandbox when
        # configured, or routed worker LLM calls would be blocked by egress policy.
        _host_from_url(os.environ.get("WORKEROS_LLM_GATEWAY_URL")),
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "*.bedrock-runtime.amazonaws.com",
        *_csv_env("WORKEROS_E2B_ALLOW_OUT"),
    ]
    deduped: list[str] = []
    for host in hosts:
        if host and host not in deduped:
            deduped.append(host)
    return deduped


def _worker_network_caps(config: WorkerConfig | None) -> tuple[bool, list[str], list[str]]:
    network = getattr(getattr(config, "capabilities", None), "network", None)
    egress = bool(getattr(network, "egress", False))
    allow_out = list(getattr(network, "allow_out", []) or [])
    deny_out = list(getattr(network, "deny_out", []) or [])
    return egress, allow_out, deny_out


def _is_e2b_ip_cidr(value: str) -> bool:
    """True if E2B will accept ``value`` in deny_out - an IPv4/IPv6 CIDR or bare IP.

    E2B's deny_out validator rejects domains, the non-routable "0.0.0.0/8" range,
    "::/0", and the "ALL_TRAFFIC" sentinel (all -> "400: invalid denied CIDR ...").
    """
    import ipaddress

    try:
        ipaddress.ip_network(value, strict=False)
        return True
    except ValueError:
        return False


def _e2b_network_policy(config: WorkerConfig | None, *, api_url: str | None = None) -> dict[str, Any]:
    """Build the E2B sandbox network policy. Two modes, both verified live against
    the e2b SDK + the E2B API:

    OPEN (default - single-tenant / OSS self-host, where you run your own workers):
        allow all public egress, block only the private/internal CIDR ranges (SSRF).
        ``{allow_public_traffic: True, deny_out: [private CIDRs]}``. Public platform
        endpoints (OpenAI / Anthropic / Bedrock / Composio / API host) are reachable
        because they're public - no allow_out needed.

    STRICT ALLOWLIST (``WORKEROS_E2B_RESTRICT_EGRESS=1`` - multi-tenant cloud running
    UNTRUSTED user workers): deny ALL egress, then allow only the platform egress
    hosts + the worker's own declared allows. E2B expresses "deny everything else"
    as the CIDR ``0.0.0.0/0`` (its error message says "ALL_TRAFFIC", but only
    ``0.0.0.0/0`` is actually accepted; ``::/0`` is rejected, so this allowlist is
    IPv4-only - IPv6 egress is not constrained).

    Earlier code sent DOMAIN entries in allow_out *without* a deny-all, which E2B
    rejects ("must include ALL_TRAFFIC ...") - that broke every egress worker
    (e.g. worker-author). Both shapes below are what the API actually accepts.
    """
    _egress, declared_allow, declared_deny = _worker_network_caps(config)
    strict = (os.environ.get("WORKEROS_E2B_RESTRICT_EGRESS") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    if strict:
        # Allowlist: deny all IPv4, permit only the platform hosts + declared allows
        # (allow entries take precedence over the deny-all and may be domains/CIDRs).
        allow_out = list(dict.fromkeys([*_platform_egress_hosts(api_url), *declared_allow]))
        extra_deny = [d for d in dict.fromkeys(declared_deny) if _is_e2b_ip_cidr(d)]
        return {"allow_out": allow_out, "deny_out": ["0.0.0.0/0", *extra_deny]}

    # Open: block private ranges, allow the rest. Only IP/CIDR allow-overrides are
    # safe here - a domain allow entry would force allowlist mode (use strict for
    # that), and public hosts are reachable anyway.
    deny_candidates = dict.fromkeys(
        [*_DEFAULT_E2B_DENY_OUT, *_csv_env("WORKEROS_E2B_DENY_OUT"), *declared_deny]
    )
    deny_out = [d for d in deny_candidates if _is_e2b_ip_cidr(d)]
    allow_out = [a for a in dict.fromkeys(declared_allow) if _is_e2b_ip_cidr(a)]
    policy: dict[str, Any] = {"allow_public_traffic": True, "deny_out": deny_out}
    if allow_out:
        policy["allow_out"] = allow_out
    return policy


def _split_env_values(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def _env_truthy(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in {"1", "true", "yes", "on"}


def _env_falsey(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in {"0", "false", "no", "off"}


def _bundle_baked_enabled() -> bool:
    return not _env_falsey("WORKEROS_E2B_BUNDLE_BAKED_ENABLED")


def _worker_bundle_baked(config: WorkerConfig | None) -> bool:
    runtime = getattr(config, "runtime", None)
    return bool(getattr(runtime, "bundle_baked", False)) and _bundle_baked_enabled()


_DEFAULT_E2B_PYTHON_BAKED_PACKAGES = {
    "boto3",
    "google-auth",
    "httpx",
    "litellm",
    "numpy",
    "openai",
    "python-dotenv",
    "requests",
}

_DEFAULT_TEMPLATE_CPU_COUNT = 2
_DEFAULT_PYTHON_TEMPLATE_MEMORY_MB = 2048
_DEFAULT_NODE_TEMPLATE_MEMORY_MB = 2048


def _python_baked_package_names() -> set[str]:
    configured = _split_env_values(os.environ.get("WORKEROS_E2B_PYTHON_BAKED_PACKAGES"))
    if not configured:
        return set(_DEFAULT_E2B_PYTHON_BAKED_PACKAGES)
    return {name.strip().lower().replace("_", "-") for name in configured if name.strip()}


def _requirement_name(line: str) -> str | None:
    text = line.strip()
    if not text or text.startswith("#"):
        return None
    if text.startswith(("-", "git+", "http://", "https://", ".")):
        return ""
    match = re.match(r"^([A-Za-z0-9_.-]+)", text)
    if not match:
        return ""
    return match.group(1).lower().replace("_", "-")


def _requirements_covered_by_baked_template(requirements_path: Path) -> tuple[bool, list[str]]:
    baked = _python_baked_package_names()
    missing: list[str] = []
    for raw_line in requirements_path.read_text(encoding="utf-8").splitlines():
        name = _requirement_name(raw_line)
        if name is None:
            continue
        if not name or name not in baked:
            missing.append(raw_line.strip())
    return not missing, missing


def _runtime_kind(config: WorkerConfig | None) -> str:
    runtime_type = (getattr(getattr(config, "runtime", None), "type", "") or "").strip().lower()
    if runtime_type.startswith("node") or runtime_type in {"javascript", "typescript", "js", "ts"}:
        return "node"
    return "python"


def _worker_resources(config: WorkerConfig | None) -> tuple[int | None, int | None]:
    resources = getattr(config, "resources", None)
    memory_mb = getattr(resources, "memory_mb", None)
    cpu_count = getattr(resources, "cpu_count", None)
    try:
        memory_value = int(memory_mb) if memory_mb is not None else None
    except (TypeError, ValueError):
        memory_value = None
    try:
        cpu_value = int(cpu_count) if cpu_count is not None else None
    except (TypeError, ValueError):
        cpu_value = None
    return memory_value, cpu_value


def _resource_template_env_keys(kind: str, memory_mb: int | None, cpu_count: int | None) -> list[str]:
    if not memory_mb and not cpu_count:
        return []
    normalized_kind = "NODE" if kind == "node" else "PYTHON"
    keys: list[str] = []
    if memory_mb and cpu_count:
        keys.append(f"WORKEROS_E2B_{normalized_kind}_TEMPLATE_MEMORY_{memory_mb}_CPU_{cpu_count}")
        keys.append(f"WORKEROS_E2B_{normalized_kind}_TEMPLATE_CPU_{cpu_count}_MEMORY_{memory_mb}")
    if memory_mb:
        keys.append(f"WORKEROS_E2B_{normalized_kind}_TEMPLATE_MEMORY_{memory_mb}")
    if cpu_count:
        keys.append(f"WORKEROS_E2B_{normalized_kind}_TEMPLATE_CPU_{cpu_count}")
    return keys


def _default_template_resources(kind: str) -> tuple[int, int]:
    memory_default = (
        _DEFAULT_NODE_TEMPLATE_MEMORY_MB
        if kind == "node"
        else _DEFAULT_PYTHON_TEMPLATE_MEMORY_MB
    )
    kind_prefix = "WORKEROS_E2B_NODE" if kind == "node" else "WORKEROS_E2B_PYTHON"
    try:
        memory_mb = int(
            os.environ.get(f"{kind_prefix}_TEMPLATE_MEMORY_MB")
            or os.environ.get("WORKEROS_E2B_TEMPLATE_MEMORY_MB")
            or str(memory_default)
        )
    except ValueError:
        memory_mb = memory_default
    try:
        cpu_count = int(
            os.environ.get(f"{kind_prefix}_TEMPLATE_CPU_COUNT")
            or os.environ.get("WORKEROS_E2B_TEMPLATE_CPU_COUNT")
            or str(_DEFAULT_TEMPLATE_CPU_COUNT)
        )
    except ValueError:
        cpu_count = _DEFAULT_TEMPLATE_CPU_COUNT
    return memory_mb, cpu_count


class TemplateProfileError(RuntimeError):
    """A worker requested a template profile that the operator has not configured."""


def _template_profile(config: WorkerConfig | None) -> str | None:
    profile = getattr(config, "template_profile", None)
    if not profile:
        return None
    text = str(profile).strip()
    return text or None


def _profile_template_env_key(profile: str) -> str:
    # #1764: map a logical profile (e.g. "workeros-dev") to its operator env key
    # (WORKEROS_E2B_TEMPLATE_PROFILE_WORKEROS_DEV). The profile name is
    # author-supplied; sanitize to a safe env-key suffix.
    slug = re.sub(r"[^A-Za-z0-9]+", "_", profile).strip("_").upper()
    return f"WORKEROS_E2B_TEMPLATE_PROFILE_{slug}"


def _resolve_template_profile(profile: str) -> str | None:
    """Resolve an operator-approved profile to a template id.

    Returns the configured template id, or ``None`` when the profile is
    unconfigured and the fallback policy permits falling through to the existing
    runtime-kind/resource-bucket resolution. Raises ``TemplateProfileError`` under
    the default (strict) policy so unknown profiles fail clearly instead of
    silently running on the wrong toolchain.
    """
    env_key = _profile_template_env_key(profile)
    value = (os.environ.get(env_key) or "").strip()
    if value:
        return value
    policy = (os.environ.get("WORKEROS_E2B_TEMPLATE_PROFILE_FALLBACK") or "strict").strip().lower()
    if policy == "default":
        return None
    raise TemplateProfileError(
        f"Worker requested E2B template profile {profile!r}, but the operator has not "
        f"configured it (set {env_key} to a template id, or set "
        "WORKEROS_E2B_TEMPLATE_PROFILE_FALLBACK=default to fall back to the default template)."
    )


def _e2b_template_for_config(config: WorkerConfig | None) -> str | None:
    profile = _template_profile(config)
    if profile:
        resolved = _resolve_template_profile(profile)
        if resolved:
            return resolved
        # policy=default: profile unconfigured, fall through to legacy resolution.
    kind = _runtime_kind(config)
    memory_mb, cpu_count = _worker_resources(config)
    for resource_env in _resource_template_env_keys(kind, memory_mb, cpu_count):
        value = os.environ.get(resource_env)
        if value:
            return value.strip() or None
    if kind == "node":
        value = os.environ.get("WORKEROS_E2B_NODE_TEMPLATE_ID")
    else:
        value = os.environ.get("WORKEROS_E2B_PYTHON_TEMPLATE_ID")
    return (value or os.environ.get("WORKEROS_E2B_DEFAULT_TEMPLATE_ID") or "").strip() or None


def _worker_template_cache_key(worker_dir: Path, config: WorkerConfig | None) -> str:
    memory_mb, cpu_count = _worker_resources(config)
    payload = {
        "v": 1,
        "runtime": _runtime_kind(config),
        "command": getattr(getattr(config, "runtime", None), "command", None) or "python run.py",
        "bundle": _hash_tree(worker_dir),
        "resources": {
            "memory_mb": memory_mb,
            "cpu_count": cpu_count,
        },
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _template_cache_mapping() -> dict[str, str]:
    raw = os.environ.get("WORKEROS_E2B_TEMPLATE_CACHE_JSON", "").strip()
    if not raw:
        path = os.environ.get("WORKEROS_E2B_TEMPLATE_CACHE_FILE", "").strip()
        if path:
            try:
                raw = Path(path).read_text(encoding="utf-8").strip()
            except Exception:
                logger.warning("Failed to read WORKEROS_E2B_TEMPLATE_CACHE_FILE=%s", path, exc_info=True)
                raw = ""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Ignoring invalid WORKEROS_E2B_TEMPLATE_CACHE_JSON")
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(key): str(value).strip()
        for key, value in data.items()
        if str(key).strip() and str(value).strip()
    }


def _e2b_template_for_run(
    worker_dir: Path,
    config: WorkerConfig | None,
    *,
    log_fn: Callable[[str, str], None],
) -> tuple[str | None, bool]:
    cache_key = _worker_template_cache_key(worker_dir, config)
    bundle_baked = _worker_bundle_baked(config)
    if bundle_baked:
        cached_template = _template_cache_mapping().get(cache_key)
        if cached_template:
            log_fn(f"[e2b] Using baked worker template for bundle key {cache_key[:12]}", "info")
            return cached_template, True
        log_fn(
            f"[e2b] Worker requests a baked bundle template, but no cache entry exists for {cache_key[:12]}; "
            "falling back to per-run bundle upload",
            "warning",
        )

    template = _e2b_template_for_config(config)
    profile = _template_profile(config)
    if profile:
        # #1764: surface that a custom profile drove selection without leaking the
        # raw template id (an internal infra identifier, see #1700).
        if (os.environ.get(_profile_template_env_key(profile)) or "").strip():
            log_fn(f"[e2b] Using operator-approved template profile {profile!r}", "info")
        else:
            log_fn(
                f"[e2b] Template profile {profile!r} is not configured; falling back to the "
                "default template per WORKEROS_E2B_TEMPLATE_PROFILE_FALLBACK=default policy",
                "warning",
            )
    kind = _runtime_kind(config)
    memory_mb, cpu_count = _worker_resources(config)
    resource_envs = _resource_template_env_keys(kind, memory_mb, cpu_count)
    if resource_envs and not any(os.environ.get(key) for key in resource_envs):
        log_fn(
            "[e2b] Worker requests sandbox resources "
            f"memory={memory_mb or 'default'}MB cpu={cpu_count or 'default'}, but none of "
            f"{', '.join(resource_envs)} is configured; using the default E2B template. "
            "E2B fixes memory/cpu on the template, not Sandbox.create().",
            "warning",
        )
    return template, False


def _sandbox_resource_log_line(config: WorkerConfig | None, sandbox_template: str | None) -> str:
    kind = _runtime_kind(config)
    requested_memory_mb, requested_cpu_count = _worker_resources(config)
    default_memory_mb, default_cpu_count = _default_template_resources(kind)
    memory_label = f"{requested_memory_mb}MB requested" if requested_memory_mb else f"{default_memory_mb}MB template default"
    cpu_label = f"{requested_cpu_count} requested" if requested_cpu_count else f"{default_cpu_count} template default"
    # #1700: never emit the raw E2B template id (e.g. gzm0071hrus9jwkse7w6) into
    # run logs; it is an internal infra identifier. Report whether a custom
    # template was used without exposing the id.
    template_label = "custom template" if sandbox_template else "E2B SDK default template"
    return (
        "[e2b] Sandbox resources: "
        f"memory={memory_label}, cpu={cpu_label}, template={template_label}. "
        "Resource limits are template-fixed; Sandbox.create() has no memory/cpu arguments."
    )


def _configured_e2b_api_keys() -> list[str]:
    """Return E2B keys in use order without logging or exposing values."""
    raw_keys: list[str] = []
    raw_keys.extend(_split_env_values(os.environ.get("E2B_API_KEYS")))
    raw_keys.extend(_split_env_values(os.environ.get("E2B_API_KEY")))
    raw_keys.extend(_split_env_values(os.environ.get("E2B_API_KEY_FALLBACK")))

    keys: list[str] = []
    seen: set[str] = set()
    for key in raw_keys:
        if key in seen:
            continue
        seen.add(key)
        keys.append(key)
    return keys


def _status_code_from_exception(exc: Exception) -> int | None:
    for attr in ("status_code", "status", "http_status", "http_status_code"):
        value = getattr(exc, attr, None)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass

    response = getattr(exc, "response", None)
    if response is not None:
        value = getattr(response, "status_code", None) or getattr(response, "status", None)
        try:
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass
    return None


def _is_e2b_quota_or_rate_limit_error(exc: Exception) -> bool:
    """True when another configured E2B key may succeed (quota, rate limit, billing block)."""
    status_code = _status_code_from_exception(exc)
    if status_code in {402, 429}:
        return True

    parts = [
        exc.__class__.__name__,
        str(getattr(exc, "code", "")),
        str(getattr(exc, "type", "")),
        str(exc),
    ]
    text = " ".join(parts).lower()
    markers = (
        "rate limit",
        "ratelimit",
        "too many requests",
        "quota",
        "exhausted",
        "insufficient credits",
        "payment required",
        "missing payment method",
        "team is blocked",
        "usage limit",
        "limit exceeded",
        "billing limit",
    )
    if any(marker in text for marker in markers):
        return True
    if status_code == 403:
        message = str(exc).lower()
        return any(token in message for token in ("billing", "payment", "blocked", "quota"))
    return False


def _exception_text(exc: Exception) -> str:
    parts = [
        exc.__class__.__name__,
        str(getattr(exc, "code", "")),
        str(getattr(exc, "type", "")),
        str(exc),
    ]
    stdout = getattr(exc, "stdout", None)
    stderr = getattr(exc, "stderr", None)
    if stdout:
        parts.append(str(stdout))
    if stderr:
        parts.append(str(stderr))
    return " ".join(part for part in parts if part).strip()


def _coerce_output_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, bytearray):
        return bytes(value).decode("utf-8", errors="replace")
    return str(value)


def _exception_exit_code(exc: Exception) -> int | None:
    for attr in ("exit_code", "returncode", "code"):
        value = getattr(exc, attr, None)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def _worker_output_snippet(stdout: Any = None, stderr: Any = None) -> str:
    parts: list[str] = []
    stderr_text = _coerce_output_text(stderr).strip()
    stdout_text = _coerce_output_text(stdout).strip()
    if stderr_text:
        parts.append(f"stderr:\n{stderr_text}")
    if stdout_text:
        parts.append(f"stdout:\n{stdout_text}")
    text = "\n\n".join(parts).strip()
    if len(text) > MAX_WORKER_ERROR_OUTPUT_CHARS:
        return text[:MAX_WORKER_ERROR_OUTPUT_CHARS].rstrip() + "..."
    return text


def _append_worker_output_to_error(error: str, stdout: Any = None, stderr: Any = None) -> str:
    snippet = _worker_output_snippet(stdout=stdout, stderr=stderr)
    if not snippet:
        return error
    return f"{error}\n\nWorker output:\n{snippet}"


def _looks_like_timeout_exception(exc: Exception) -> bool:
    text = _exception_text(exc).lower()
    return any(
        marker in text
        for marker in (
            "timeout",
            "timed out",
            "deadline exceeded",
            "context deadline",
            "took too long",
        )
    )


def _timeout_elapsed_near_cap(elapsed_seconds: float, timeout_seconds: int) -> bool:
    try:
        cap = float(timeout_seconds)
    except (TypeError, ValueError):
        cap = 300.0
    if cap <= 0:
        return False
    return elapsed_seconds >= max(1.0, cap * 0.9)


# Low-level transport/library exceptions surface their __repr__ as the message,
# e.g. h2 emits "<ConnectionTerminated error_code:1, last_stream_id:343, ...>"
# (h2/events.py). That repr is internal noise to an operator and must never be
# stored in the user-visible run.error (#1700). Collapse any such angle-bracket
# library repr to its class name; the full exception is still captured in the
# server logs via logger.exception().
_LIBRARY_REPR_RE = re.compile(r"<([A-Za-z_][A-Za-z0-9_]*)\b[^>]*>")


def _sanitize_sandbox_exception_detail(detail: str) -> str:
    """Strip raw library exception reprs from a sandbox error detail string.

    Keeps a human-meaningful summary (the exception type name) instead of the
    full ``<ConnectionTerminated error_code:1, last_stream_id:343, ...>`` repr.
    """
    cleaned = _LIBRARY_REPR_RE.sub(lambda m: m.group(1), detail or "")
    return cleaned.strip()


def _sandbox_exception_result(
    exc: Exception,
    *,
    elapsed_seconds: float,
    timeout_seconds: int,
) -> WorkerResult:
    raw_detail = str(exc).strip() or exc.__class__.__name__
    detail = _sanitize_sandbox_exception_detail(raw_detail) or exc.__class__.__name__
    if _looks_like_timeout_exception(exc) and _timeout_elapsed_near_cap(elapsed_seconds, timeout_seconds):
        return WorkerResult(
            status="error",
            error=f"Worker exceeded its {timeout_seconds}s timeout and was stopped.",
            error_code="timeout",
            retryable=True,
        )
    return WorkerResult(
        status="error",
        error=f"E2B sandbox failed before the worker timeout was reached: {detail}",
        error_code="e2b_sandbox_error",
        retryable=True,
    )


def _worker_result_failure_fields(result_data: dict[str, Any]) -> tuple[Any, Any]:
    result_status = result_data.get("status", "success")
    if result_status not in ("error", "failed"):
        return result_data.get("error"), result_data.get("error_code")
    result_error = str(result_data.get("error") or "").strip()
    result_error_code = str(result_data.get("error_code") or "").strip()
    if not result_error:
        result_error = "Worker reported failure without an error message."
    if not result_error_code:
        result_error_code = "worker_reported_error"
    return result_error, result_error_code


def _create_sandbox_with_key_fallback(
    sandbox_cls: Any,
    *,
    api_keys: list[str],
    timeout: int,
    envs: dict[str, str],
    template: str | None = None,
    network: dict[str, Any] | None = None,
    log_fn: Callable[[str, str], None],
) -> Any:
    last_quota_error: Exception | None = None
    total = len(api_keys)

    for index, api_key in enumerate(api_keys, start=1):
        try:
            create_kwargs: dict[str, Any] = {
                "api_key": api_key,
                "timeout": timeout,
                "envs": envs,
                "network": network,
            }
            if template:
                create_kwargs["template"] = template
            return sandbox_cls.create(**create_kwargs)
        except Exception as exc:
            if not _is_e2b_quota_or_rate_limit_error(exc):
                raise
            last_quota_error = exc
            if index < total:
                log_fn(
                    f"[e2b] E2B key {index}/{total} hit a quota/billing/rate limit; "
                    "retrying with the next configured key",
                    "warning",
                )
                continue
            raise E2BKeyExhaustedError(
                "All configured E2B API keys are rate-limited or quota-exhausted "
                f"({total} key(s) tried)."
            ) from last_quota_error

    raise E2BKeyExhaustedError("No E2B API keys are configured.")


def _read_result_json(
    sandbox: Any,
    result_path: str,
    log_fn: Callable,
    *,
    worker_stdout: Any = None,
    worker_stderr: Any = None,
) -> "tuple[Optional[Dict[str, Any]], Optional[WorkerResult]]":
    """Read and parse the worker's result.json from the sandbox.

    Returns ``(result_data, None)`` on success, or ``(None, WorkerResult)`` with
    a distinct, actionable error when the read/parse fails. Each failure mode is
    a separate branch (audit P1) instead of one generic "didn't produce a
    result" message:

      * missing file        -> ``missing_result``
      * oversized           -> ``output_too_large`` (size cap before parse+persist)
      * invalid/undecodable -> ``invalid_result_json``
      * non-object top-level-> ``invalid_result_json``
      * non-dict ``outputs``-> ``invalid_outputs_shape`` (was silently coerced to {})

    Operator detail (full sandbox path) is logged; user-facing messages never
    leak the sandbox internal path.
    """
    # 1. Read. A read failure means the worker exited 0 but never wrote the file.
    try:
        result_raw = sandbox.files.read(result_path)
    except Exception as exc:
        log_fn(f"[e2b] No result.json at {result_path}: {exc}", "error")
        return None, WorkerResult(
            status="error",
            error=_append_worker_output_to_error(
                (
                    "Worker did not write a result. Check run.py wrote "
                    "result.json before exiting (the file is missing)."
                ),
                stdout=worker_stdout,
                stderr=worker_stderr,
            ),
            error_code="missing_result",
        )

    # 2. Size cap BEFORE json.loads + persist, to protect the DB row and the
    #    run-detail response from multi-MB outputs.
    raw_bytes = (
        result_raw
        if isinstance(result_raw, (bytes, bytearray))
        else str(result_raw).encode("utf-8", errors="ignore")
    )
    if len(raw_bytes) > MAX_RESULT_JSON_BYTES:
        log_fn(
            f"[e2b] result.json at {result_path} is {len(raw_bytes)} bytes "
            f"(> {MAX_RESULT_JSON_BYTES} cap)",
            "error",
        )
        return None, WorkerResult(
            status="error",
            error=(
                f"Worker output is too large ({len(raw_bytes) // 1024} KiB). "
                f"result.json must be under "
                f"{MAX_RESULT_JSON_BYTES // (1024 * 1024)} MiB. Write large data "
                "to an artifact file instead."
            ),
            error_code="output_too_large",
        )

    # 3. Parse. A failure here means a file WAS written but is not valid JSON
    #    (or wrong encoding) - distinct from "no file written".
    try:
        result_data = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        log_fn(f"[e2b] result.json at {result_path} is not valid JSON: {exc}", "error")
        return None, WorkerResult(
            status="error",
            error=_append_worker_output_to_error(
                (
                    "Worker wrote a result.json that is not valid JSON: "
                    f"{exc}. Ensure run.py serializes a JSON object."
                ),
                stdout=worker_stdout,
                stderr=worker_stderr,
            ),
            error_code="invalid_result_json",
        )

    # 4. Top-level must be an object.
    if not isinstance(result_data, dict):
        log_fn(
            f"[e2b] result.json at {result_path} top-level is "
            f"{type(result_data).__name__}, expected object",
            "error",
        )
        return None, WorkerResult(
            status="error",
            error=_append_worker_output_to_error(
                (
                    "Worker result.json must be a JSON object, got "
                    f"{type(result_data).__name__}. Wrap your data in an "
                    '"outputs" object.'
                ),
                stdout=worker_stdout,
                stderr=worker_stderr,
            ),
            error_code="invalid_result_json",
        )

    # 5. `outputs` must be a dict. A worker returning a list/string/number was
    #    previously coerced to {} and silently completed green (audit P1).
    outputs = result_data.get("outputs", {})
    if not isinstance(outputs, dict):
        log_fn(
            f"[e2b] result.json 'outputs' is {type(outputs).__name__}, "
            "expected object",
            "error",
        )
        return None, WorkerResult(
            status="error",
            error=(
                "Worker 'outputs' must be a JSON object, got "
                f"{type(outputs).__name__}. Return outputs as a mapping, e.g. "
                '{"outputs": {"name": value}}.'
            ),
            error_code="invalid_outputs_shape",
        )

    return result_data, None

def _register_sandbox(run_id: str, sandbox: Any) -> None:
    with _active_sandboxes_lock:
        _active_sandboxes[run_id] = sandbox


def _unregister_sandbox(run_id: str, sandbox: Any) -> None:
    with _active_sandboxes_lock:
        if _active_sandboxes.get(run_id) is sandbox:
            _active_sandboxes.pop(run_id, None)


def active_sandbox_count() -> int:
    with _active_sandboxes_lock:
        return len(_active_sandboxes)


def cancel_sandbox(run_id: str, *, reason: str | None = None) -> bool:
    with _active_sandboxes_lock:
        sandbox = _active_sandboxes.get(run_id)
    if sandbox is None:
        return False
    try:
        sandbox.kill()
        logger.warning("Killed active E2B sandbox for run %s: %s", run_id, reason or "cancel requested")
        return True
    except Exception as exc:
        logger.warning("Failed to kill active E2B sandbox for run %s: %s", run_id, exc)
        return False
    finally:
        _unregister_sandbox(run_id, sandbox)


def _looks_like_sandbox_oom(exit_code: int | None, stdout: str | None, stderr: str | None) -> bool:
    try:
        normalized_exit_code = int(exit_code) if exit_code is not None else None
    except (TypeError, ValueError):
        normalized_exit_code = None
    if normalized_exit_code in _OOM_EXIT_CODES:
        return True
    text = f"{stdout or ''}\n{stderr or ''}".lower()
    return any(marker in text for marker in _OOM_MARKERS)


def _sandbox_memory_diagnostics(sandbox: Any, workdir: str) -> str:
    command = (
        "python - <<'PY'\n"
        "from pathlib import Path\n"
        "paths = [\n"
        "    '/sys/fs/cgroup/memory.events',\n"
        "    '/sys/fs/cgroup/memory.current',\n"
        "    '/sys/fs/cgroup/memory.max',\n"
        "    '/sys/fs/cgroup/memory/memory.oom_control',\n"
        "    '/sys/fs/cgroup/memory/memory.failcnt',\n"
        "    '/sys/fs/cgroup/memory/memory.limit_in_bytes',\n"
        "]\n"
        "for raw in paths:\n"
        "    path = Path(raw)\n"
        "    if path.exists():\n"
        "        try:\n"
        "            print(f'{raw}: {path.read_text(errors=\"replace\").strip()}')\n"
        "        except Exception as exc:\n"
        "            print(f'{raw}: <read failed: {exc}>')\n"
        "PY"
    )
    try:
        result = sandbox.commands.run(
            command,
            cwd=workdir,
            timeout=5,
            request_timeout=10,
        )
    except Exception as exc:
        return f"memory diagnostics unavailable: {exc}"
    output = _worker_output_snippet(
        stdout=getattr(result, "stdout", None),
        stderr=getattr(result, "stderr", None),
    )
    return output or "memory diagnostics unavailable: no cgroup memory files returned data"


def _append_memory_diagnostics(error: str, diagnostics: str | None) -> str:
    detail = (diagnostics or "").strip()
    if not detail:
        return error
    if len(detail) > MAX_WORKER_ERROR_OUTPUT_CHARS:
        detail = detail[:MAX_WORKER_ERROR_OUTPUT_CHARS].rstrip() + "..."
    return f"{error}\n\nSandbox memory diagnostics:\n{detail}"


def _diagnostics_show_oom(diagnostics: str | None) -> bool:
    text = (diagnostics or "").lower()
    if "under_oom 1" in text:
        return True
    for marker in ("oom_kill", "oom", "memory.failcnt"):
        if marker not in text:
            continue
        for token in re.findall(rf"{re.escape(marker)}\s*:?\s*(\d+)", text):
            try:
                if int(token) > 0:
                    return True
            except ValueError:
                continue
    return False


def _emit_command_output(raw: str, level: str, prefix: str, log_fn: Callable[[str, str], None]) -> None:
    for line in str(raw or "").splitlines():
        line = line.strip()
        if line:
            log_fn(f"{prefix}{line}", level)


def _format_env_line(key: str, value: str) -> str:
    """Format a single KEY=value line for .env.local.

    Values containing double-quotes, backslashes, newlines, carriage-returns, or
    null bytes are wrapped in double quotes with those characters escaped.
    Plain values that need no escaping are written unquoted (safer for most
    shell parsers and python-dotenv alike).
    """
    needs_quoting = any(c in value for c in ('"', '\\', '\n', '\r', '\0'))
    if needs_quoting:
        escaped = (
            value
            .replace('\\', '\\\\')
            .replace('"', '\\"')
            .replace('\n', '\\n')
            .replace('\r', '\\r')
            .replace('\0', '\\0')
        )
        return f'{key}="{escaped}"'
    return f'{key}={value}'


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def _install_timeout_for_run(timeout_seconds: int) -> int:
    """Give large real-engine bundles enough time to install dependencies."""
    return max(MIN_INSTALL_TIMEOUT_SECONDS, min(int(timeout_seconds), MAX_RUN_TIMEOUT_SECONDS))


def _e2b_command_request_timeout(timeout_seconds: int | float) -> float:
    """HTTP request timeout for E2B commands; separate from execution timeout."""
    return float(timeout_seconds) + E2B_COMMAND_REQUEST_TIMEOUT_BUFFER_SECONDS


def _e2b_install_request_timeout(install_timeout: int) -> float:
    return max(
        E2B_INSTALL_COMMAND_MIN_REQUEST_TIMEOUT_SECONDS,
        _e2b_command_request_timeout(install_timeout),
    )


def _sandbox_lifetime_timeout(timeout_seconds: int, install_timeout: int) -> int:
    """Sandbox lifetime must cover dependency install plus worker execution."""
    requested_timeout = max(
        int(timeout_seconds) + int(install_timeout) + SANDBOX_LIFETIME_BUFFER_SECONDS,
        MIN_INSTALL_TIMEOUT_SECONDS,
    )
    return min(requested_timeout, MAX_E2B_SANDBOX_LIFETIME_SECONDS)


def _effective_run_timeout(timeout_seconds: int) -> int:
    """Enforce the runtime ceiling for direct driver callers as a final guard."""
    return max(1, min(int(timeout_seconds), MAX_RUN_TIMEOUT_SECONDS))


def _refresh_sandbox_lifetime(
    sandbox: Any,
    *,
    timeout: int,
    log_fn: Callable[[str, str], None],
) -> None:
    set_timeout = getattr(sandbox, "set_timeout", None)
    if not callable(set_timeout):
        logger.debug("E2B sandbox object does not expose set_timeout(); skipping lifetime refresh")
        return
    try:
        set_timeout(timeout)
        log_fn(f"[e2b] Refreshed sandbox lifetime to {timeout}s before worker command", "debug")
    except Exception as exc:
        log_fn(
            "[e2b] Failed to refresh sandbox lifetime to "
            f"{timeout}s before worker command: {exc}. "
            "E2B may enforce a lower maximum for this account or plan.",
            "error",
        )
        raise


def _sandbox_api_url() -> str:
    """API base URL used by code running inside E2B sandboxes."""
    for name in (
        "WORKEROS_SANDBOX_API_URL",
        "WORKEROS_E2B_API_URL",
        "WORKEROS_INTERNAL_API_URL",
        "WORKEROS_API_URL",
        "WORKEROS_API_BASE",
        "WORKERS_API_URL",
    ):
        value = (os.environ.get(name) or "").strip()
        if value:
            return value.rstrip("/")
    return "http://localhost:8000"


def _normalize_sandbox_relative_path(raw_path: str) -> str:
    path = PurePosixPath(str(raw_path).strip())
    if not str(path) or str(path) == ".":
        raise ValueError("artifact path is required")
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"invalid artifact path: {raw_path!r}")
    return path.as_posix()


def _artifact_type_for_output(output: Any) -> str:
    if output and output.media_type:
        return output.media_type
    if output and output.type == "markdown":
        return "text/markdown"
    if output and output.type == "csv":
        return "text/csv"
    if output and output.type == "json":
        return "application/json"
    return "application/octet-stream"


def _default_output_path(output: Any) -> str:
    extension_by_type = {
        "markdown": "md",
        "csv": "csv",
        "json": "json",
        "text": "txt",
        "file": "bin",
    }
    extension = extension_by_type.get(getattr(output, "type", ""), "bin")
    return f"out/{output.name}.{extension}"


def _artifact_specs_from_result(result_artifacts: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    specs: list[Dict[str, Any]] = []
    for artifact in result_artifacts:
        if not isinstance(artifact, dict):
            continue
        raw_path = artifact.get("relative_path") or artifact.get("path")
        if not raw_path:
            continue
        specs.append({
            "name": artifact.get("name") or raw_path,
            "path": raw_path,
            "type": artifact.get("type") or "application/octet-stream",
        })
    return specs


def _artifact_specs_from_declared_outputs(config: Optional[WorkerConfig]) -> list[Dict[str, Any]]:
    if not config:
        return []
    specs: list[Dict[str, Any]] = []
    for output in config.outputs:
        if output.kind and output.kind != "file":
            continue
        raw_path = output.path or _default_output_path(output)
        specs.append({
            "output_name": output.name,
            "name": raw_path,
            "path": raw_path,
            "type": _artifact_type_for_output(output),
            "required": bool(output.required),
        })
    return specs


def _merge_artifacts(
    result_artifacts: list[Dict[str, Any]],
    collected_artifacts: list[Dict[str, Any]],
) -> list[Dict[str, Any]]:
    merged: list[Dict[str, Any]] = []
    replaced: set[str] = {
        str(artifact.get("relative_path") or artifact.get("name") or artifact.get("path"))
        for artifact in collected_artifacts
    }
    for artifact in result_artifacts:
        key = str(artifact.get("relative_path") or artifact.get("name") or artifact.get("path"))
        if key and key in replaced:
            continue
        merged.append(artifact)
    merged.extend(collected_artifacts)
    return merged


def _safe_context_tar_member(member_name: str) -> PurePosixPath:
    path = PurePosixPath(member_name)
    if str(path) in {"", "."}:
        raise ValueError("empty tar path")
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"invalid context tar path: {member_name!r}")
    return path


def _extract_context_tar(raw_tar: bytes, target_dir: Path) -> None:
    """Merge the sandbox's writeback snapshot onto the live context dir.

    #1020: this used to extract to a tmp dir, ``rmtree(target_dir)``, then swap
    the whole tree in. But the sandbox snapshot is frozen at run START, so any
    file written to the LIVE store DURING the run - e.g. feedback captured by
    Emily while a `distill` worker was running - was erased on completion.
    Feedback was silently lost, breaking the whole loop.

    We now OVERLAY instead of replace: every file in the tar is written over its
    counterpart in ``target_dir`` (atomically, per file), and files already in
    ``target_dir`` that are NOT in the tar are left untouched. The worker still
    fully controls the files it writes; it just can no longer clobber a sibling
    it never saw. Deletions made inside the sandbox intentionally do NOT
    propagate - correct for the accumulate-style stores this path serves
    (feedback, memory). Path-traversal members are skipped as before.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    target_root = target_dir.resolve()
    extracted_total = 0
    with tarfile.open(fileobj=io.BytesIO(raw_tar), mode="r:*") as archive:
        for member in archive.getmembers():
            try:
                rel = _safe_context_tar_member(member.name)
            except ValueError:
                continue
            if member.isdir():
                (target_dir / rel.as_posix()).mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                continue
            # #1041 - enforce size caps from tar metadata BEFORE reading the
            # member into memory; skip (don't raise) so the rest of the
            # writeback still lands, matching the path-traversal skip above.
            if member.size > MAX_CONTEXT_TAR_MEMBER_BYTES:
                logger.warning(
                    "[context-tar] skipping oversized member %r: %d bytes > %d cap",
                    member.name,
                    member.size,
                    MAX_CONTEXT_TAR_MEMBER_BYTES,
                )
                continue
            if extracted_total + member.size > MAX_CONTEXT_TAR_TOTAL_BYTES:
                logger.warning(
                    "[context-tar] total extraction cap %d reached; skipping "
                    "remaining members starting at %r",
                    MAX_CONTEXT_TAR_TOTAL_BYTES,
                    member.name,
                )
                break
            extracted_total += member.size
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            destination = (target_dir / rel.as_posix()).resolve()
            try:
                destination.relative_to(target_root)
            except ValueError:
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Atomic per-file replace: a concurrent reader never sees a
            # half-written file, and a mid-merge failure leaves the files
            # written so far (and every untouched sibling) intact.
            tmp_file = destination.parent / (
                f".{destination.name}.tmp.{os.getpid()}.{threading.get_ident()}"
            )
            try:
                tmp_file.write_bytes(extracted.read())
                os.replace(tmp_file, destination)
            finally:
                if tmp_file.exists():
                    tmp_file.unlink()


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    # Keep E2B parity with run_service and agent_driver: bundle_path drift and
    # bare relative hosted paths must resolve through the single shared guard.
    from runner_utils import _resolve_worker_bundle_dir

    return _resolve_worker_bundle_dir(WORKERS_DIR, worker_id, config, _safe_path)


def _hash_tree(root: Path) -> str:
    digest = hashlib.sha256()
    if not root.is_dir():
        return ""
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if (
            (rel.parts and rel.parts[0] == "inputs")
            or "__pycache__" in rel.parts
            or rel.suffix == ".pyc"
            or (rel.parts and rel.parts[0] in {".pytest_cache", ".ruff_cache"})
        ):
            continue
        digest.update(rel.as_posix().encode("utf-8"))
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


def _effective_context_inputs(config: WorkerConfig | None, inputs: Dict[str, Any] | None) -> Dict[str, Any]:
    effective = dict(inputs or {})
    if not config:
        return effective
    for inp in getattr(config, "inputs", []) or []:
        name = getattr(inp, "name", None)
        default = getattr(inp, "default", None)
        if name and default is not None and name not in effective:
            effective[name] = default
    return effective


def _selected_contexts_for_inputs(
    config: WorkerConfig | None,
    inputs: Dict[str, Any],
) -> tuple[list[dict[str, Any]], str | None]:
    if not config or not config.contexts:
        return [], None
    selected: list[dict[str, Any]] = []
    effective_inputs = _effective_context_inputs(config, inputs)
    for raw_context in config.contexts:
        try:
            context = normalize_context_mount(raw_context)
            if context_mount_matches_inputs(context, effective_inputs):
                writeable_when = context.get("writeable_when")
                if context.get("writeable") and writeable_when:
                    context = dict(context)
                    context["writeable"] = context_mount_matches_inputs(
                        {"name": context["name"], "when": writeable_when},
                        effective_inputs,
                    )
                selected.append(context)
        except ValueError as exc:
            return [], f"Invalid context declaration: {exc}"
    return selected, None


def _warm_pool_sensitive_run_material(
    config: WorkerConfig | None,
    inputs: Dict[str, Any] | None,
    secrets: Dict[str, str] | None = None,
) -> str | None:
    if config and getattr(config, "connections", None):
        return "connections"
    return None


def _bundle_fingerprint_for_warm_key(worker_dir: Path, config: WorkerConfig | None) -> str:
    trusted = getattr(getattr(config, "runtime", None), "bundle_sha256", None)
    if isinstance(trusted, str) and trusted.strip():
        return f"sha256:{trusted.strip()}"
    return f"tree:{_hash_tree(worker_dir)}"


def _warm_pool_context_key_entries(
    selected_contexts: list[dict[str, Any]],
    *,
    user_id: str | None,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    with use_context_scope(context_scope_for_user(user_id)):
        metadata = load_context_metadata()
        for context in selected_contexts:
            source = context.get("source", "local")
            entry: dict[str, Any] = {
                "name": context["name"],
                "source": source,
            }
            if source == "local":
                local_dir = _contexts_module.context_dir(context["name"])
                pack_meta = metadata.get(str(context["name"])) if isinstance(metadata, dict) else None
                summary = pack_meta.get("summary") if isinstance(pack_meta, dict) else None
                sha256 = summary.get("sha256") if isinstance(summary, dict) else None
                if isinstance(sha256, str) and sha256.strip():
                    entry["fingerprint"] = f"sha256:{sha256.strip()}"
                    entry["size"] = int(summary.get("total_size_bytes") or 0)
                    entry["updated_at"] = summary.get("updated_at")
                else:
                    summary = context_tree_summary(local_dir) if local_dir.exists() else {
                        "sha256": hashlib.sha256().hexdigest(),
                        "total_size_bytes": 0,
                        "updated_at": None,
                    }
                    entry["fingerprint"] = f"tree:{summary['sha256']}"
                    entry["size"] = int(summary.get("total_size_bytes") or 0)
                    entry["updated_at"] = summary.get("updated_at")
            entries.append(entry)
    return entries


def _warm_pool_key(
    *,
    worker_id: str,
    user_id: str | None,
    worker_dir: Path,
    config: WorkerConfig | None,
    inputs: Dict[str, Any],
    sandbox_template: str | None,
    secrets: Dict[str, str] | None = None,
) -> tuple[str | None, str | None]:
    if not _warm_pool_enabled():
        return None, None
    if _warm_pool_sensitive_run_material(config, inputs, secrets):
        return None, None
    selected_contexts, context_error = _selected_contexts_for_inputs(config, inputs)
    if context_error:
        return None, context_error
    # Keep v1 conservative: mutable or git-backed context mounts are not pooled.
    # They still run through the cold path, which preserves existing semantics.
    for context in selected_contexts:
        if context.get("writeable"):
            return None, None
        if str(context.get("source") or "").startswith("git+"):
            return None, None
    command = "python run.py"
    if config and config.runtime and config.runtime.command:
        command = config.runtime.command
    key_payload = {
        "v": 1,
        "worker_id": worker_id,
        "user_id": user_id or "",
        "template": sandbox_template or "",
        "runtime": _runtime_kind(config),
        "command": command,
        "bundle": _bundle_fingerprint_for_warm_key(worker_dir, config),
        "contexts": _warm_pool_context_key_entries(selected_contexts, user_id=user_id),
    }
    raw = json.dumps(key_payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest(), None


def _cleanup_run_state(sandbox: Any, workdir: str, *, log_fn: Callable[[str, str], None]) -> bool:
    result = sandbox.commands.run(
        "rm -rf -- "
        "inputs inputs.json .env.local secrets.json connections.json result.json "
        "artifacts artifact outputs output tmp .tmp .workeros_run && "
        "(find . -type d -name __pycache__ -prune -exec rm -rf -- {} + 2>/dev/null || true) && "
        "(find . -type f \\( -name '*.pyc' -o -name '*.pyo' \\) -delete 2>/dev/null || true) && "
        "(find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true)",
        cwd=workdir,
        timeout=30,
        request_timeout=45,
    )
    if getattr(result, "exit_code", 1) != 0:
        detail = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "")[:300]
        log_fn(f"[e2b] Warm sandbox cleanup failed: {detail}", "warning")
        return False
    return True


class E2BSandboxDriver(SandboxDriver):
    """Runs worker code in an E2B cloud sandbox (e2b SDK 2.x).

    The worker's run.py MUST:
    1. Read inputs from inputs.json
    2. Optionally read secrets from secrets.json (declared secrets dict)
    3. Optionally read connections.json (Composio app slug -> connection_id)
    4. Write result.json with {"status": ..., "outputs": {...}, "error": ...}
    """

    def run(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int = DEFAULT_RUN_TIMEOUT_SECONDS,
        config: Optional[WorkerConfig] = None,
        connection_ids: Optional[Dict[str, str]] = None,
        user_id: str | None = None,
    ) -> WorkerResult:
        started_monotonic = time.monotonic()
        effective_timeout_seconds = _effective_run_timeout(timeout_seconds)
        if effective_timeout_seconds < int(timeout_seconds):
            log_fn(
                "[e2b] Capping worker command timeout at "
                f"{effective_timeout_seconds}s (WORKEROS_MAX_RUN_TIMEOUT)",
                "warning",
            )
        try:
            return self._run_in_sandbox(
                worker_id, run_id, inputs, secrets, log_fn, trace_id,
                effective_timeout_seconds, config, connection_ids or {}, user_id,
            )
        except E2BKeyExhaustedError as exc:
            logger.warning(
                "E2B sandbox quota exhausted for worker %s run %s: %s",
                worker_id,
                run_id,
                exc,
            )
            log_fn(f"E2B sandbox quota exhausted: {exc}", "error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="e2b_quota_exhausted",
                retryable=True,
            )
        except Exception as exc:
            # #607: if the sandbox was killed because the user clicked cancel,
            # surface "cancelled" instead of "error" so the UI shows the right
            # terminal state. cancel_requested is the canonical flag; read it
            # through the active repository before logging so hosted Supabase
            # runs are classified correctly.
            if run_cancel_requested(run_id):
                logger.info("E2B sandbox terminated by user cancel for run %s", run_id)
                log_fn("[e2b] Sandbox terminated - run cancelled by user", "info")
                return WorkerResult(
                    status="cancelled",
                    error="Cancelled by user",
                    error_code="user_cancel",
                )

            exc_stdout = getattr(exc, "stdout", None)
            exc_stderr = getattr(exc, "stderr", None)
            exc_exit_code = getattr(exc, "exit_code", None)
            if _looks_like_sandbox_oom(exc_exit_code, exc_stdout, f"{exc_stderr or ''}\n{exc}"):
                logger.exception(
                    "E2B sandbox OOM for worker %s run %s: %s", worker_id, run_id, exc
                )
                log_fn(f"E2B sandbox OOM: {exc}", "error")
                return WorkerResult(
                    status="error",
                    error=str(exc),
                    error_code="sandbox_oom",
                    retryable=False,
                )
            logger.exception(
                "E2B sandbox failed for worker %s run %s: %s", worker_id, run_id, exc
            )
            elapsed_seconds = time.monotonic() - started_monotonic
            result = _sandbox_exception_result(
                exc,
                elapsed_seconds=elapsed_seconds,
                timeout_seconds=effective_timeout_seconds,
            )
            # #1700: prefix with [e2b] so the operator Logs tab filters this
            # infra line, and log the SANITIZED result.error (never the raw h2
            # ConnectionTerminated repr). The full exception is already captured
            # above via logger.exception() for server-side debugging.
            log_fn(f"[e2b] Sandbox error after {elapsed_seconds:.3f}s: {result.error}", "error")
            return result

    def _run_in_sandbox(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int,
        config: Optional[WorkerConfig],
        connection_ids: Dict[str, str],
        user_id: str | None,
    ) -> WorkerResult:
        perf = _E2BPerfTimer()
        from e2b import Sandbox  # e2b 2.x
        perf.mark("import_e2b")

        api_keys = _configured_e2b_api_keys()
        perf.mark("api_keys")
        if not api_keys:
            return WorkerResult(
                status="error",
                error="E2B_API_KEY is not configured",
                error_code="missing_e2b_key",
            )

        try:
            worker_dir = _worker_dir_for_run(worker_id, config)
            perf.mark("worker_dir")
        except ValueError as exc:
            return WorkerResult(
                status="error", error=str(exc), error_code="invalid_worker"
            )

        if not worker_dir.is_dir():
            try:
                from services.worker_materialization import rematerialize_worker_from_db

                if rematerialize_worker_from_db(worker_id, target_dir=worker_dir):
                    log_fn("[e2b] Re-materialized worker files from DB", "info")
            except Exception as exc:
                logger.warning(
                    "Worker re-materialization failed for %s at %s: %s",
                    worker_id,
                    worker_dir,
                    exc,
                )
            perf.mark("rematerialize_check")

        if not worker_dir.is_dir():
            return WorkerResult(
                status="error",
                error=f"Worker directory not found: {worker_dir}",
                error_code="worker_not_found",
            )

        effective_timeout_seconds = _effective_run_timeout(timeout_seconds)
        perf.mark("effective_timeout")
        if effective_timeout_seconds < int(timeout_seconds):
            log_fn(
                "[e2b] Capping worker command timeout at "
                f"{effective_timeout_seconds}s (WORKEROS_MAX_RUN_TIMEOUT)",
                "warning",
            )

        log_fn(f"[e2b] Preparing sandbox for run {run_id}", "info")
        perf.mark("preparing_log")
        install_timeout = _install_timeout_for_run(effective_timeout_seconds)
        sandbox_timeout = _sandbox_lifetime_timeout(effective_timeout_seconds, install_timeout)
        requested_sandbox_timeout = max(
            effective_timeout_seconds + install_timeout + SANDBOX_LIFETIME_BUFFER_SECONDS,
            MIN_INSTALL_TIMEOUT_SECONDS,
        )
        perf.mark("sandbox_timeout")
        if sandbox_timeout < requested_sandbox_timeout:
            log_fn(
                "[e2b] Capping sandbox lifetime at "
                f"{sandbox_timeout}s, the configured E2B maximum; worker command "
                f"timeout remains {effective_timeout_seconds}s and the lifetime "
                "will be refreshed before execution",
                "warning",
            )

        # e2b 2.x: use Sandbox.create()
        from run_token import make_run_token  # noqa: PLC0415
        _sandbox_api_url_val = _sandbox_api_url()
        perf.mark("sandbox_api_url")
        # If the worker declares calls:, issue a wrt_ token so call_worker()
        # inside run.py can spawn child runs. The simple make_run_token is kept
        # for backwards-compat (composio-execute and run-status callbacks) but
        # is NOT sufficient for worker-to-worker calling.
        _worker_call_token: str | None = None
        if config and config.calls and user_id:
            from run_token import issue_worker_call_token, parse_call_depth  # noqa: PLC0415
            # #994: token carries this run's depth so the chain's cap accumulates.
            _self_depth = 0
            try:
                from db import get_repositories  # noqa: PLC0415
                _row = get_repositories().runs.get_any(run_id=run_id)
                _self_depth = parse_call_depth((_row or {}).get("trigger_source"))
            except Exception:
                _self_depth = 0
            _worker_call_token = issue_worker_call_token(
                user_id=user_id,
                parent_run_id=run_id,
                callable_workers=list(config.calls),
                depth=_self_depth,
            )
            perf.mark("worker_call_token")
        else:
            perf.mark("worker_call_token_skip")
        _sandbox_envs = {
            "FLOOM_RUN_ID": run_id,
            "FLOOM_TRACE_ID": trace_id,
            "WORKEROS_API_URL": _sandbox_api_url_val,
            # Scoped capability token - valid only for /runs/{run_id}/composio-execute/*
            # Never inject the full FLOOM_SECRET into sandboxes (it grants full API access).
            "WORKEROS_RUN_TOKEN": _worker_call_token if _worker_call_token else make_run_token(run_id),
            **({"WORKEROS_CALL_DEPTH": str(_self_depth)} if _worker_call_token else {}),  # #994
        }
        # #1137: worker-author is first-party code that generates the bundle
        # inside E2B, so it needs the platform LLM provider env. Regular workers
        # still receive only declared user secrets plus callback vars.
        _worker_author_env = _worker_author_platform_env() if worker_id == _WORKER_AUTHOR_ID else {}
        _sandbox_envs.update(_worker_author_env)
        perf.mark("sandbox_env")
        sandbox_template, bundle_baked_template = _e2b_template_for_run(worker_dir, config, log_fn=log_fn)
        perf.mark("template")
        python_template_deps_baked = _env_truthy("WORKEROS_E2B_PYTHON_DEPS_BAKED")
        node_template_deps_baked = _env_truthy("WORKEROS_E2B_NODE_DEPS_BAKED")
        if sandbox_template:
            log_fn(
                f"[e2b] Using configured {_runtime_kind(config)} template for sandbox startup",
                "info",
            )
        log_fn(_sandbox_resource_log_line(config, sandbox_template), "info")
        perf.mark("resource_log")
        warm_key, warm_key_error = _warm_pool_key(
            worker_id=worker_id,
            user_id=user_id,
            worker_dir=worker_dir,
            config=config,
            inputs=inputs,
            secrets=secrets,
            sandbox_template=sandbox_template,
        )
        perf.mark("warm_key")
        if warm_key_error:
            return WorkerResult(
                status="error",
                error=warm_key_error,
                error_code="context_mount_failed",
                retryable=True,
            )
        warm_entry = _warm_pool_lease(warm_key or "", log_fn=log_fn) if warm_key else None
        perf.mark("warm_lease")
        sandbox_prepared = warm_entry is not None
        if warm_entry is not None:
            sandbox = warm_entry.sandbox
        else:
            log_fn(f"[e2b] Spawning sandbox for run {run_id}", "info")
            perf.mark("spawn_log")
            sandbox = _create_sandbox_with_key_fallback(
                Sandbox,
                api_keys=api_keys,
                timeout=sandbox_timeout,
                envs=_sandbox_envs,
                template=sandbox_template,
                network=_e2b_network_policy(config, api_url=_sandbox_api_url_val),
                log_fn=log_fn,
            )
            perf.mark("sandbox_create")
        _register_sandbox(run_id, sandbox)
        perf.mark("register_sandbox")
        keep_warm = False

        try:
            workdir = "/home/user/worker"
            if sandbox_prepared:
                if not _cleanup_run_state(sandbox, workdir, log_fn=log_fn):
                    return WorkerResult(
                        status="error",
                        error="Warm sandbox cleanup failed before execution; retry the run.",
                        error_code="warm_sandbox_cleanup_failed",
                        retryable=True,
                    )
                made_dirs = {workdir}
                mounted_contexts = set(warm_entry.mounted_contexts if warm_entry else set())
                writeable_contexts = set(warm_entry.writeable_contexts if warm_entry else set())
                perf.mark("warm_cleanup")
            else:
                sandbox.files.make_dir(workdir)
                perf.mark("make_workdir")

            if not sandbox_prepared and not bundle_baked_template:
                # Upload bundle files (read-only worker code; never contains inputs/).
                made_dirs = {workdir}
                upload_tree_tarball(
                    sandbox,
                    worker_dir,
                    workdir,
                    skip=lambda _path, rel: (
                        (rel.parts and rel.parts[0] == "inputs")
                        or "__pycache__" in rel.parts
                        or rel.suffix == ".pyc"
                        or (rel.parts and rel.parts[0] in {".pytest_cache", ".ruff_cache"})
                    ),
                    log_fn=log_fn,
                    label="worker bundle",
                )
                perf.mark("bundle_upload")
            if not sandbox_prepared:
                if bundle_baked_template:
                    made_dirs = {workdir}
                    log_fn("[e2b] Skipping worker bundle upload; baked template already contains it", "info")
                    perf.mark("bundle_baked_skip")

                # Write workeros.py into the workdir so workers with calls: can do
                # `from workeros import call_worker`. Only uploaded when the worker
                # declares calls; keeps the sandbox clean for workers that do not need it.
                if _worker_call_token:
                    from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT  # noqa: PLC0415
                    sandbox.files.write(f"{workdir}/workeros.py", WORKEROS_PY_CONTENT.encode())
                    log_fn("[e2b] Uploaded workeros.py (worker-to-worker calling enabled)", "info")
                    perf.mark("workeros_helper_upload")
                else:
                    perf.mark("workeros_helper_skip")

                mounted_contexts: set[str] = set()
                writeable_contexts: set[str] = set()
                context_error = self._upload_contexts_to_sandbox(
                    sandbox=sandbox,
                    workdir=workdir,
                    config=config,
                    inputs=inputs,
                    made_dirs=made_dirs,
                    log_fn=log_fn,
                    user_id=user_id,
                    mounted_contexts=mounted_contexts,
                    writeable_contexts=writeable_contexts,
                )
                perf.mark("contexts_upload")
                if context_error:
                    return WorkerResult(
                        status="error",
                        error=context_error,
                        error_code="context_mount_failed",
                        retryable=True,
                    )

            # Upload per-run file inputs from their isolated staging paths.
            # Inputs dict values for file inputs are absolute local paths.
            e2b_inputs_dir = f"{workdir}/inputs"
            e2b_inputs_made = False
            e2b_inputs: dict[str, str] = {}
            for key, value in inputs.items():
                if not isinstance(value, str):
                    continue
                local_path = Path(value)
                if local_path.is_absolute() and local_path.is_file():
                    if not e2b_inputs_made:
                        sandbox.files.make_dir(e2b_inputs_dir)
                        made_dirs.add(e2b_inputs_dir)
                        e2b_inputs_made = True
                    remote_name = local_path.name
                    remote_path = f"{e2b_inputs_dir}/{remote_name}"
                    sandbox.files.write(remote_path, local_path.read_bytes())
                    log_fn(f"[e2b] Uploaded input file {remote_name}", "debug")
                    # Remap to the relative path the worker expects inside the sandbox.
                    e2b_inputs[key] = f"inputs/{remote_name}"
            perf.mark("input_files_upload")
            # Build sandbox-local inputs dict with remapped file paths.
            sandbox_inputs = {k: e2b_inputs.get(k, v) for k, v in inputs.items()}

            # Write inputs.json with sandbox-local (relative) file paths.
            sandbox.files.write(
                f"{workdir}/inputs.json",
                json.dumps(sandbox_inputs, indent=2),
            )
            perf.mark("inputs_json")

            # Write .env.local - industry-standard convention; workers load via
            # python-dotenv's load_dotenv(".env.local") + os.environ.
            env_local_lines = [_format_env_line(k, v) for k, v in secrets.items()]
            sandbox.files.write(
                f"{workdir}/.env.local",
                "\n".join(env_local_lines) + ("\n" if env_local_lines else ""),
            )
            perf.mark("env_local")

            # Write secrets.json - kept for ONE release as backward-compat with
            # user-uploaded workers still using json.load(open("secrets.json")).
            # Will be removed in PR S11.
            sandbox.files.write(
                f"{workdir}/secrets.json",
                json.dumps(secrets, indent=2),
            )
            perf.mark("secrets_json")

            # Write connections.json: Composio app slug -> connection_id mapping.
            # Workers that declare connections: [...] in worker.yml read this to
            # find the authenticated connection ID for each app.
            sandbox.files.write(
                f"{workdir}/connections.json",
                json.dumps(connection_ids, indent=2),
            )
            perf.mark("connections_json")

            # Install dependencies if present.
            #
            # Python: requirements.txt -> `pip install -r`.
            # Node:   package.json     -> `npm install --omit=dev --no-audit --no-fund`
            #         (uses package-lock.json when present for reproducibility).
            #
            # We hit this Node gap shipping a Node worker that needed
            # google-auth-library: E2B can run any language; we just had no
            # install hook for non-Python bundles.
            req_path = worker_dir / "requirements.txt"
            if not sandbox_prepared and req_path.exists() and req_path.read_text().strip():
                requirements_covered = False
                if python_template_deps_baked:
                    requirements_covered, missing_requirements = _requirements_covered_by_baked_template(req_path)
                    if not requirements_covered:
                        log_fn(
                            "[e2b] Python template deps-baked is enabled, but requirements.txt "
                            "contains packages not in the baked package list; running pip install "
                            f"for this worker ({', '.join(missing_requirements[:5])})",
                            "warning",
                        )
                if python_template_deps_baked and requirements_covered:
                    log_fn(
                        "[e2b] Skipping requirements.txt install; configured template marks Python deps as baked",
                        "info",
                    )
                else:
                    log_fn("[e2b] Installing requirements.txt...", "info")
                    install_result = sandbox.commands.run(
                        f"pip install -q -r {workdir}/requirements.txt",
                        timeout=install_timeout,
                        request_timeout=_e2b_install_request_timeout(install_timeout),
                    )
                    if install_result.exit_code != 0:
                        err = (
                            f"pip install failed (exit {install_result.exit_code}): "
                            f"{(install_result.stderr or '')[:500]}"
                        )
                        log_fn(f"[e2b] {err}", "error")
                        return WorkerResult(
                            status="error",
                            error=err,
                            error_code="install_failed",
                        )
                    log_fn("[e2b] Requirements installed", "info")
                perf.mark("python_deps")
            else:
                perf.mark("python_deps_skip")

            pkg_path = worker_dir / "package.json"
            if not sandbox_prepared and pkg_path.exists() and pkg_path.read_text().strip():
                if node_template_deps_baked:
                    log_fn(
                        "[e2b] Skipping npm install; configured template marks Node deps as baked",
                        "info",
                    )
                else:
                    log_fn("[e2b] Installing package.json (npm)...", "info")
                    npm_install_result = sandbox.commands.run(
                        f"cd {workdir} && npm install --omit=dev --no-audit --no-fund --loglevel=error",
                        timeout=install_timeout,
                        request_timeout=_e2b_install_request_timeout(install_timeout),
                    )
                    if npm_install_result.exit_code != 0:
                        err = (
                            f"npm install failed (exit {npm_install_result.exit_code}): "
                            f"{(npm_install_result.stderr or npm_install_result.stdout or '')[:500]}"
                        )
                        log_fn(f"[e2b] {err}", "error")
                        return WorkerResult(
                            status="error",
                            error=err,
                            error_code="install_failed",
                        )
                    log_fn("[e2b] npm install complete", "info")
                perf.mark("node_deps")
            else:
                perf.mark("node_deps_skip")

            # Bedrock via litellm needs boto3, which the sandbox image doesn't ship.
            # Only the platform-privileged worker-author runs an LLM call *inside*
            # the sandbox (normal agent workers proxy LLM through the host, and the
            # host venv already has boto3). Install it just for that case + Bedrock,
            # so `litellm.APIConnectionError: No module named 'boto3'` can't bite.
            _author_model = _worker_author_env.get("WORKEROS_CODEGEN_MODEL", "")
            if not sandbox_prepared and "bedrock" in _author_model.lower():
                if python_template_deps_baked:
                    log_fn(
                        "[e2b] Skipping boto3 install; configured template marks Python deps as baked",
                        "info",
                    )
                else:
                    log_fn("[e2b] Installing boto3 (Bedrock runtime dep)...", "info")
                    _boto_res = sandbox.commands.run(
                        "pip install -q boto3",
                        timeout=install_timeout,
                    )
                    if _boto_res.exit_code != 0:
                        err = (
                            f"boto3 install failed (exit {_boto_res.exit_code}): "
                            f"{(_boto_res.stderr or '')[:300]}"
                        )
                        log_fn(f"[e2b] {err}", "error")
                        return WorkerResult(
                            status="error", error=err, error_code="install_failed"
                        )
                    log_fn("[e2b] boto3 installed", "info")
                perf.mark("boto3")
            else:
                perf.mark("boto3_skip")

            _refresh_sandbox_lifetime(
                sandbox,
                timeout=sandbox_timeout,
                log_fn=log_fn,
            )
            perf.mark("refresh_lifetime")

            # Run the worker - commands.run() is sync, returns CommandResult directly
            command = "python run.py"
            if config and config.runtime and config.runtime.command:
                command = config.runtime.command
            # #977: strip E2B sandbox/template ids (and the codegen model for
            # non-author workers) from the worker process environment.
            command = _scrub_internal_env_command(command, worker_id)
            log_fn(f"[e2b] Executing worker command: {command}", "info")
            perf.mark("execute_log")
            streamed_stdout: list[str] = []
            streamed_stderr: list[str] = []

            def on_stdout(chunk: str) -> None:
                streamed_stdout.append(chunk)
                _emit_command_output(chunk, "info", "[e2b] ", log_fn)

            def on_stderr(chunk: str) -> None:
                streamed_stderr.append(chunk)
                _emit_command_output(chunk, "warning", "[e2b] stderr: ", log_fn)

            _cmd_envs: dict[str, str] = {
                **_worker_author_env,
                **secrets,
                # #1448: the gateway env is applied AFTER worker secrets so it
                # overrides a worker's direct OPENAI_API_KEY/base, centralising
                # LLM traffic on the managed gateway's pooled quota. No-op ({})
                # when WORKEROS_LLM_GATEWAY_URL is unset (workers call directly).
                **_llm_gateway_env(),
                "FLOOM_RUN_ID": run_id,
                "FLOOM_TRACE_ID": trace_id,
                "WORKEROS_API_URL": _sandbox_envs["WORKEROS_API_URL"],
                "WORKEROS_RUN_TOKEN": _sandbox_envs["WORKEROS_RUN_TOKEN"],
            }
            if _worker_call_token:
                _cmd_envs["WORKEROS_RUN_TOKEN"] = _worker_call_token
                _cmd_envs["WORKEROS_CALL_DEPTH"] = str(_self_depth)  # #994
            perf.mark("command_env")
            perf.log(log_fn, "e2b.before_worker_command")
            try:
                proc = sandbox.commands.run(
                    command,
                    cwd=workdir,
                    envs=_cmd_envs,
                    on_stdout=on_stdout,
                    on_stderr=on_stderr,
                    timeout=float(effective_timeout_seconds),
                    request_timeout=_e2b_command_request_timeout(effective_timeout_seconds),
                )
            except Exception as exc:
                exc_stdout = _coerce_output_text(getattr(exc, "stdout", None))
                exc_stderr = _coerce_output_text(getattr(exc, "stderr", None))
                if exc_stdout and not streamed_stdout:
                    _emit_command_output(exc_stdout, "info", "[e2b] ", log_fn)
                if exc_stderr and not streamed_stderr:
                    _emit_command_output(exc_stderr, "warning", "[e2b] stderr: ", log_fn)
                exc_exit_code = _exception_exit_code(exc)
                if exc_exit_code is None:
                    diagnostics = _sandbox_memory_diagnostics(sandbox, workdir)
                    log_fn(
                        "[e2b] Sandbox command transport failed before an exit code; "
                        f"memory diagnostics: {diagnostics}",
                        "warning",
                    )
                    raise
                if _looks_like_sandbox_oom(exc_exit_code, exc_stdout, exc_stderr):
                    diagnostics = _sandbox_memory_diagnostics(sandbox, workdir)
                    err = _append_worker_output_to_error(
                        "Sandbox ran out of memory",
                        stdout=exc_stdout,
                        stderr=exc_stderr,
                    )
                    err = _append_memory_diagnostics(err, diagnostics)
                    log_fn(f"[e2b] {err}", "error")
                    return WorkerResult(
                        status="error",
                        error=err,
                        error_code="sandbox_oom",
                        retryable=False,
                    )
                err = _append_worker_output_to_error(
                    f"Worker exited with code {exc_exit_code}",
                    stdout=exc_stdout,
                    stderr=exc_stderr,
                )
                log_fn(f"[e2b] Worker exited with code {exc_exit_code}", "error")
                return WorkerResult(
                    status="error",
                    error=err,
                    error_code="execution_error",
                    retryable=False,
                )

            # E2B streams stdout/stderr through callbacks while the process is
            # running. Keep the fallback for SDKs or test doubles that only
            # return aggregate stdout/stderr after process exit.
            proc_stdout = _coerce_output_text(getattr(proc, "stdout", None))
            proc_stderr = _coerce_output_text(getattr(proc, "stderr", None))
            if proc_stdout and not streamed_stdout:
                _emit_command_output(proc_stdout, "info", "[e2b] ", log_fn)
            if proc_stderr and not streamed_stderr:
                _emit_command_output(proc_stderr, "warning", "[e2b] stderr: ", log_fn)

            if proc.exit_code != 0:
                if _looks_like_sandbox_oom(proc.exit_code, proc_stdout, proc_stderr):
                    diagnostics = _sandbox_memory_diagnostics(sandbox, workdir)
                    err = _append_worker_output_to_error(
                        "Sandbox ran out of memory",
                        stdout=proc_stdout,
                        stderr=proc_stderr,
                    )
                    err = _append_memory_diagnostics(err, diagnostics)
                    log_fn(f"[e2b] {err}", "error")
                    return WorkerResult(
                        status="error",
                        error=err,
                        error_code="sandbox_oom",
                        retryable=False,
                    )
                err = _append_worker_output_to_error(
                    f"Worker exited with code {proc.exit_code}",
                    stdout=proc_stdout,
                    stderr=proc_stderr,
                )
                log_fn(f"[e2b] Worker exited with code {proc.exit_code}", "error")
                return WorkerResult(
                    status="error",
                    error=err,
                    error_code="execution_error",
                    retryable=False,
                )

            # Read + parse result.json. Distinct, actionable errors for each
            # failure mode (missing file / oversized / invalid JSON / not-a-dict
            # / non-dict outputs) - see _read_result_json (audit P1).
            result_path = f"{workdir}/result.json"
            result_data, parse_error = _read_result_json(
                sandbox,
                result_path,
                log_fn,
                worker_stdout="".join(streamed_stdout) or proc_stdout,
                worker_stderr="".join(streamed_stderr) or proc_stderr,
            )
            if parse_error is not None:
                if getattr(parse_error, "error_code", None) == "missing_result":
                    diagnostics = _sandbox_memory_diagnostics(sandbox, workdir)
                    if _diagnostics_show_oom(diagnostics):
                        err = _append_worker_output_to_error(
                            "Sandbox ran out of memory before writing result.json",
                            stdout="".join(streamed_stdout) or proc_stdout,
                            stderr="".join(streamed_stderr) or proc_stderr,
                        )
                        err = _append_memory_diagnostics(err, diagnostics)
                        log_fn(f"[e2b] {err}", "error")
                        return WorkerResult(
                            status="error",
                            error=err,
                            error_code="sandbox_oom",
                            retryable=False,
                        )
                    parse_error.error = _append_memory_diagnostics(parse_error.error or "", diagnostics)
                return parse_error

            outputs = result_data.get("outputs", {})
            result_status = result_data.get("status", "success")
            result_error, result_error_code = _worker_result_failure_fields(result_data)
            result_artifacts = result_data.get("artifacts", [])
            if not isinstance(result_artifacts, list):
                result_artifacts = []
            collected_artifacts = self._collect_sandbox_artifacts(
                sandbox=sandbox,
                workdir=workdir,
                run_id=run_id,
                result_artifacts=result_artifacts,
                config=config,
                outputs=outputs,
                log_fn=log_fn,
            )
            artifacts = _merge_artifacts(result_artifacts, collected_artifacts)
            if result_status not in ("error", "failed"):
                self._persist_writeable_contexts(
                    sandbox=sandbox,
                    workdir=workdir,
                    run_id=run_id,
                    config=config,
                    log_fn=log_fn,
                    user_id=user_id,
                    mounted_contexts=mounted_contexts,
                    writeable_contexts=writeable_contexts,
                )
                keep_warm = bool(warm_key) and _cleanup_run_state(sandbox, workdir, log_fn=log_fn)

            log_fn("[e2b] Run completed successfully", "info")
            decision_required = result_data.get("decision_required")
            if not isinstance(decision_required, dict):
                decision_required = None
            return WorkerResult(
                status=result_status,
                outputs=outputs,
                artifacts=artifacts,
                error=result_error,
                error_code=result_error_code,
                decision_required=decision_required,
            )

        finally:
            _unregister_sandbox(run_id, sandbox)
            pooled = False
            if keep_warm and warm_key:
                entry = warm_entry or _WarmSandboxEntry(
                    key=warm_key,
                    sandbox=sandbox,
                    workdir=workdir,
                    mounted_contexts=set(mounted_contexts),
                    writeable_contexts=set(writeable_contexts),
                )
                pooled = _warm_pool_return(entry, log_fn=log_fn)
            if not pooled:
                try:
                    # e2b 2.x: kill() may raise if the sandbox already exited.
                    # We attempt gracefully; any exception is a warning, not a failure.
                    sandbox.kill()
                    log_fn("[e2b] Sandbox killed", "debug")
                except Exception as close_exc:
                    # Sandbox may have self-terminated (timeout, OOM) — not an error.
                    logger.debug("E2B sandbox already gone (kill suppressed): %s", close_exc)

    def _upload_contexts_to_sandbox(
        self,
        *,
        sandbox: Any,
        workdir: str,
        config: Optional[WorkerConfig],
        inputs: Dict[str, Any] | None = None,
        made_dirs: set[str],
        log_fn: Callable[[str, str], None],
        user_id: str | None = None,
        mounted_contexts: set[str] | None = None,
        writeable_contexts: set[str] | None = None,
    ) -> str | None:
        if not config or not config.contexts:
            return None
        inputs = inputs or {}
        selected_contexts, context_error = _selected_contexts_for_inputs(config, inputs)
        if context_error:
            return context_error

        contexts_root = f"{workdir}/context"
        made_context_root = False

        with use_context_scope(context_scope_for_user(user_id)):
            ensure_memory_context_pack(config=config, user_id=user_id, log_fn=log_fn)
            selected_names = {context["name"] for context in selected_contexts}
            for raw_context in config.contexts:
                try:
                    context = normalize_context_mount(raw_context)
                except ValueError as exc:
                    return f"Invalid context declaration: {exc}"
                name = context["name"]
                if name not in selected_names:
                    log_fn(f"[e2b] Skipping context {name!r}: run inputs did not match mount condition", "debug")
            for context in selected_contexts:
                name = context["name"]

                if not made_context_root:
                    sandbox.files.make_dir(contexts_root)
                    made_dirs.add(contexts_root)
                    made_context_root = True

                source = context["source"]
                sandbox_target = f"{contexts_root}/{name}"
                sandbox.files.make_dir(sandbox_target)
                made_dirs.add(sandbox_target)
                if mounted_contexts is not None:
                    mounted_contexts.add(name)
                if writeable_contexts is not None and context.get("writeable"):
                    writeable_contexts.add(name)

                if source.startswith("git+"):
                    try:
                        repo_url = _safe_git_context_url(source)
                    except ValueError as exc:
                        return f"Invalid git context {name!r}: {exc}"
                    log_fn(f"[e2b] Cloning git context {name!r}", "info")
                    result = sandbox.commands.run(
                        "git clone --depth 1 "
                        f"{shlex.quote(repo_url)} {shlex.quote(sandbox_target)}",
                        timeout=180,
                    )
                    if result.exit_code != 0:
                        return (
                            f"git context {name!r} clone failed "
                            f"(exit {result.exit_code}): {(result.stderr or result.stdout or '')[:500]}"
                        )
                    continue

                local_dir = _contexts_module.context_dir(name)
                if not local_dir.is_dir():
                    log_fn(f"[e2b] context {name!r} not found locally", "warning")
                    continue

                try:
                    upload_tree_tarball(
                        sandbox,
                        local_dir,
                        sandbox_target,
                        skip=lambda _path, rel: "__pycache__" in rel.parts,
                        log_fn=log_fn,
                        label=f"context {name}",
                    )
                except RuntimeError as exc:
                    return str(exc)
        return None

    def _persist_writeable_contexts(
        self,
        *,
        sandbox: Any,
        workdir: str,
        run_id: str,
        config: Optional[WorkerConfig],
        log_fn: Callable[[str, str], None],
        user_id: str | None = None,
        mounted_contexts: set[str] | None = None,
        writeable_contexts: set[str] | None = None,
    ) -> None:
        if not config or not config.contexts:
            return

        with use_context_scope(context_scope_for_user(user_id)):
            for raw_context in config.contexts:
                try:
                    context = normalize_context_mount(raw_context)
                except ValueError as exc:
                    log_fn(f"[e2b] Skipping invalid writeable context: {exc}", "warning")
                    continue
                if not context["writeable"]:
                    continue
                if context["source"] != "local":
                    log_fn(
                        f"[e2b] Skipping writeback for git context {context['name']!r}",
                        "warning",
                    )
                    continue

                name = context["name"]
                if mounted_contexts is not None and name not in mounted_contexts:
                    log_fn(
                        f"[e2b] Skipping writeback for context {name!r}: it was not mounted for this run",
                        "debug",
                    )
                    continue
                if writeable_contexts is not None and name not in writeable_contexts:
                    log_fn(
                        f"[e2b] Skipping writeback for context {name!r}: it was read-only for this run",
                        "debug",
                    )
                    continue
                sandbox_source = f"{workdir}/context/{name}"
                try:
                    if not sandbox.files.exists(sandbox_source, request_timeout=30):
                        log_fn(f"[e2b] Writeable context {name!r} missing in sandbox", "warning")
                        continue
                except Exception as exc:
                    log_fn(f"[e2b] Failed to inspect writeable context {name!r}: {exc}", "warning")
                    continue

                tar_path = f"/tmp/{run_id}-{name}.tar"
                result = sandbox.commands.run(
                    f"cd {shlex.quote(sandbox_source)} && tar -cf {shlex.quote(tar_path)} .",
                    timeout=120,
                )
                if result.exit_code != 0:
                    log_fn(
                        f"[e2b] Failed to archive writeable context {name!r}: "
                        f"{(result.stderr or result.stdout or '')[:300]}",
                        "warning",
                    )
                    continue
                try:
                    raw_tar = sandbox.files.read(tar_path, format="bytes", request_timeout=120)
                    _extract_context_tar(bytes(raw_tar), _contexts_module.context_dir(name))
                    log_fn(f"[e2b] Persisted writeable context {name!r}", "info")
                except Exception as exc:
                    log_fn(f"[e2b] Failed to persist writeable context {name!r}: {exc}", "warning")

    def _collect_sandbox_artifacts(
        self,
        *,
        sandbox: Any,
        workdir: str,
        run_id: str,
        result_artifacts: list[Dict[str, Any]],
        config: Optional[WorkerConfig],
        outputs: Dict[str, Any],
        log_fn: Callable[[str, str], None],
    ) -> list[Dict[str, Any]]:
        specs = _artifact_specs_from_result(result_artifacts)
        specs.extend(_artifact_specs_from_declared_outputs(config))

        artifact_dir = _safe_path(ARTIFACTS_DIR, run_id)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        collected: list[Dict[str, Any]] = []
        seen: set[str] = set()

        for spec in specs:
            try:
                relative_path = _normalize_sandbox_relative_path(str(spec["path"]))
            except (KeyError, ValueError) as exc:
                log_fn(f"[e2b] Skipping invalid artifact path: {exc}", "warning")
                continue
            if relative_path in seen:
                continue
            seen.add(relative_path)

            remote_path = f"{workdir}/{relative_path}"
            try:
                if not sandbox.files.exists(remote_path, request_timeout=30):
                    if spec.get("required"):
                        log_fn(f"[e2b] Required output artifact missing: {relative_path}", "warning")
                    continue
                raw_content = sandbox.files.read(
                    remote_path,
                    format="bytes",
                    request_timeout=120,
                )
            except Exception as exc:
                log_fn(f"[e2b] Failed to download artifact {relative_path}: {exc}", "warning")
                continue

            local_path = _safe_path(artifact_dir, *PurePosixPath(relative_path).parts)
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(bytes(raw_content))
            artifact = {
                "name": spec.get("name") or relative_path,
                "type": spec.get("type") or "application/octet-stream",
                "path": str(local_path),
                "relative_path": relative_path,
                "size_bytes": local_path.stat().st_size,
            }
            output_name = spec.get("output_name")
            if output_name and output_name not in outputs:
                outputs[str(output_name)] = relative_path
            collected.append(artifact)
            log_fn(
                f"[e2b] Downloaded artifact {relative_path} ({artifact['size_bytes']} bytes)",
                "debug",
            )

        return collected
