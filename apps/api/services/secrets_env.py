"""User-secret env-file IO + platform-secret specs.

The legacy ``.env``-file read/write helpers (atomic, file-locked upserts the
Slack channel and settings flows still use), the platform/infra secret spec
tables that gate the operator-facing secrets API, and the DB-backed
"which secret names exist for this user" resolver. Extracted verbatim from
main.py (only ``_env_file_path`` changed: this file lives one directory deeper,
so the module-relative ``.env`` default resolves via ``parents[1]``).

``db`` is imported lazily inside functions (purged + re-imported by fixtures).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, NotRequired, Optional, TypedDict

try:
    import fcntl as _fcntl_mod
    _LOCK_EX = _fcntl_mod.LOCK_EX
    _LOCK_UN = _fcntl_mod.LOCK_UN
except ImportError:
    # Windows: no fcntl — fall back to a no-op lock for single-process dev
    # (mirrors the shim main.py ships for its other lock sites).
    class _fcntl_mod:  # type: ignore[no-redef]
        LOCK_EX = 1; LOCK_SH = 0; LOCK_UN = 8; LOCK_NB = 4
        @staticmethod
        def flock(fd, op): pass
    _LOCK_EX = 1
    _LOCK_UN = 8

if TYPE_CHECKING:
    from db import Repositories


def _env_file_path() -> Path:
    override = (
        os.environ.get("WORKEROS_API_ENV_FILE")
        or os.environ.get("FLOOM_API_ENV_FILE")
    )
    if override:
        return Path(override)
    # apps/api/.env — this module lives in apps/api/services/, one level deeper
    # than main.py where this helper originated.
    return Path(__file__).resolve().parents[1] / ".env"


_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"


def _secret_value_has_control_chars(value: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _read_env_lines() -> list[str]:
    """Read .env lines; return [] if file does not exist."""
    env_path = _env_file_path()
    if not env_path.exists():
        return []
    with open(env_path, "r") as f:
        return f.readlines()


def _write_env_lines(lines: list[str]) -> None:
    """Atomically write .env lines with file lock."""
    env_path = _env_file_path()
    env_path.parent.mkdir(parents=True, exist_ok=True)
    with open(env_path, "a+") as lock_fd:
        _fcntl_mod.flock(lock_fd, _LOCK_EX)
        try:
            with open(env_path, "w") as f:
                f.writelines(lines)
        finally:
            _fcntl_mod.flock(lock_fd, _LOCK_UN)


def _upsert_env_var(name: str, value: str) -> None:
    """Set or replace NAME=value in the .env file, then reload into os.environ."""
    # Validate name is a legal env var identifier
    if len(name) < 1 or len(name) > 64:
        raise ValueError("Secret name must be 1-64 characters")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        raise ValueError(f"Invalid secret name: {name!r}")
    if len(value) < 1 or len(value) > 32 * 1024:
        raise ValueError("Secret value must be 1-32768 characters")
    # Reject control characters. Newline/CR corrupt the env file by injecting
    # extra lines; other controls make later rendering/logging unsafe.
    if _secret_value_has_control_chars(value):
        raise ValueError(
            "Secret value must not contain newline or control characters"
        )

    lines = _read_env_lines()
    new_line = f"{name}={value}\n"
    replaced = False
    new_lines: list[str] = []
    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith(f"{name}=") or stripped == name:
            new_lines.append(new_line)
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        # Ensure trailing newline before appending
        if new_lines and not new_lines[-1].endswith("\n"):
            new_lines[-1] += "\n"
        new_lines.append(new_line)
    _write_env_lines(new_lines)
    # Reload in-process so workers immediately see the new value
    os.environ[name] = value


def _delete_env_var(name: str) -> bool:
    """Remove NAME from .env and os.environ. Returns True if it was present."""
    lines = _read_env_lines()
    new_lines = [
        line for line in lines
        if not (line.rstrip("\n").startswith(f"{name}=") or line.rstrip("\n") == name)
    ]
    removed = len(new_lines) < len(lines)
    if removed:
        _write_env_lines(new_lines)
    os.environ.pop(name, None)
    return removed


# ---------------------------------------------------------------------------
# Platform secrets — infra vars that belong in Settings, NOT the secrets UI
# ---------------------------------------------------------------------------

class PlatformSecretSpec(TypedDict):
    name: str
    required: bool
    default: Optional[str]
    description: Optional[str]
    fallback: NotRequired[str]


PLATFORM_SECRET_SPECS: list[PlatformSecretSpec] = [
    {
        "name": "PLATFORM_OPENAI_API_KEY",
        "required": True,
        "default": None,
        "fallback": "OPENAI_API_KEY",
        "description": "Platform OpenAI key for Emily and prompt-to-worker drafting/codegen. Falls back to OPENAI_API_KEY for back-compat. Workers bring their OWN OPENAI_API_KEY via Settings -> Secrets (a normal user secret, not a platform secret).",
    },
    {
        "name": "E2B_API_KEY",
        "required": True,
        "default": None,
        "description": "E2B sandbox API key",
    },
    {
        "name": "COMPOSIO_API_KEY",
        "required": True,
        "default": None,
        "description": "Composio API key for the connections backend",
    },
    {
        "name": "COMPOSIO_WEBHOOK_SIGNING_KEY",
        "required": True,
        "default": None,
        "description": "HMAC key for verifying Composio webhook deliveries",
    },
    {
        "name": "FLOOM_SECRET",
        "required": True,
        "default": None,
        "description": "Shared secret for x-floom-secret auth",
    },
    {
        "name": "WORKERS_FRONTEND_URL",
        "required": True,
        "default": None,
        "description": "Base URL for OAuth callbacks (e.g. https://workers.floom.dev)",
    },
]

# Infrastructure/filesystem config vars shown in a separate section on /settings.
# Not secrets: no values, just paths and tuning params.
INFRA_PATH_SPECS: list[PlatformSecretSpec] = [
    {
        "name": "FLOOM_DB",
        "required": False,
        "default": "../../data/floom.db",
        "description": "SQLite DB path",
    },
    {
        "name": "FLOOM_WORKERS_DIR",
        "required": False,
        "default": "../../workers",
        "description": "Workers directory",
    },
    {
        "name": "FLOOM_ARTIFACTS_DIR",
        "required": False,
        "default": "../../data/artifacts",
        "description": "Artifacts directory",
    },
    {
        "name": "FLOOM_CONTEXTS_DIR",
        "required": False,
        "default": "../../contexts",
        "description": "Contexts directory",
    },
    {
        "name": "FLOOM_RUN_TIMEOUT",
        "required": False,
        "default": "300",
        "description": "Default run timeout in seconds",
    },
]

# Set of platform-managed names for fast membership checks. Used to keep
# system/infra vars out of the operator-facing /secrets list and to refuse
# upsert/delete/test on them.
#
# P1-8 (audit 2026-05-29): this previously covered only PLATFORM_SECRET_SPECS,
# so the INFRA_PATH_SPECS vars (FLOOM_DB, FLOOM_WORKERS_DIR, FLOOM_ARTIFACTS_DIR,
# FLOOM_CONTEXTS_DIR, FLOOM_RUN_TIMEOUT) leaked into the user Secrets list with a
# Delete action — deleting FLOOM_DB from the UI could break the running system.
# Both spec lists are platform-managed and must be excluded from the user API.
PLATFORM_SECRETS: frozenset[str] = frozenset(
    s["name"] for s in (PLATFORM_SECRET_SPECS + INFRA_PATH_SPECS)
)


def _available_secret_names_for_user(user_id: str, repos: "Repositories") -> set[str]:
    # Owner/user-managed secrets from the DB. OPENAI_API_KEY is a normal user
    # secret added via Settings -> Secrets, so it shows up here once added.
    # Platform-infra keys (PLATFORM_OPENAI_API_KEY etc.) are deliberately NOT
    # included: they power Emily/codegen and must never gate or feed an untrusted
    # worker sandbox. Keeping this DB-only makes worker-secret behaviour identical
    # in OSS and cloud — each owner brings their own worker key. See ARCHITECTURE.md.
    return set(repos.secrets.list_names(user_id=user_id))


def _platform_openai_api_key() -> Optional[str]:
    """The platform's OWN OpenAI key — powers Emily, prompt-to-worker drafting,
    and codegen. Env-managed and reserved. PLATFORM_OPENAI_API_KEY is canonical;
    OPENAI_API_KEY is the back-compat fallback so existing single-key deploys keep
    working. This is NOT a worker key: workers bring their own OPENAI_API_KEY via
    the secrets DB, and the platform key must never reach a worker sandbox."""
    return os.environ.get("PLATFORM_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY") or None
