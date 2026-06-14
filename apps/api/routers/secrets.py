"""User-managed secret routes.

``POST/DELETE /secrets/{name}`` (write-only upsert / delete with the platform-
secret guard), ``POST /secrets/{name}/test`` and ``GET /secrets`` (the composed
status list: DB secrets + worker-declared names, platform vars excluded).
Extracted verbatim from main.py into an APIRouter.

The platform-secret specs and env helpers live in ``services.secrets_env``, the
GitHub-connected encrypted-vault sync in ``services.git_service``, and the
worker listing in ``services.worker_access`` — all real module-level imports
(never purged by fixtures; they resolve db/auth/worker_registry lazily
themselves). ``run_service`` IS purged, so ``get_worker_config_for_run`` is
imported lazily inside the handler. Secrets test fixtures purge ``routers.*``
alongside ``main``.
"""

from __future__ import annotations

import logging
import re
from typing import Annotated, Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi import Path as PathParam
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from core.utils import row_to_dict
from db import Repositories, get_repos
from models import SecretItem, SecretStatus
from services.git_service import _git_cfg_get, _sync_secrets_to_enc
from services.secrets_env import (
    PLATFORM_SECRETS,
    _available_secret_names_for_user,
    _secret_value_has_control_chars,
)
from services.worker_access import _list_visible_workers

logger = logging.getLogger("floom.api")


def _require_secret_mutation_allowed(auth: AuthContext, existing: Optional[Dict[str, Any]], name: str) -> None:
    """#952: members may create secrets and manage their own, but must not
    overwrite or delete a secret someone else created.

    Per-user secret repositories (OSS SQLite) never surface another user's rows,
    so this is a no-op there. Workspace-scoped repositories (cloud) return the
    workspace row with its creator's user_id — where, before this guard, any
    member could replace or delete the admin's API keys.
    """
    if existing is None or auth.is_admin:
        return
    creator = str(existing.get("user_id") or "")
    if creator and creator != auth.user_id:
        raise HTTPException(
            status_code=403,
            detail=f"only an admin or the creator can modify secret {name!r}",
        )


secrets_router = APIRouter()


class SecretUpsertRequest(BaseModel):
    value: str = Field(min_length=1, max_length=32 * 1024)


class SecretTestResult(BaseModel):
    status: str  # "valid" | "invalid"
    reason: Optional[str] = None


SecretName = Annotated[str, PathParam(min_length=1, max_length=64, pattern=r"^[A-Z][A-Z0-9_]*$")]

# #1068 — secret names that would shadow the runner's own environment when
# surfaced into the run env. The HTTP route enforces the name pattern via
# PathParam, but MCP secrets.set calls upsert_secret() directly (bypassing that),
# so the name is re-validated and these names are blocked in the handler.
_SENSITIVE_ENV_SECRET_NAMES: frozenset[str] = frozenset(
    {
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "IFS",
        "PWD",
        "TMPDIR",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "LD_DEBUG",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "NODE_OPTIONS",
        "NODE_PATH",
        "BASH_ENV",
        "ENV",
        "PERL5LIB",
        "RUBYLIB",
        "GIT_SSH_COMMAND",
    }
)


@secrets_router.post("/secrets/{name}", response_model=SecretTestResult)
def upsert_secret(
    name: SecretName,
    payload: SecretUpsertRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SecretTestResult:
    """Create or update a secret. Value is write-only — never returned.

    Platform infrastructure secrets are managed outside the user-secrets API.
    """
    # #1068 — MCP secrets.set calls this handler directly, bypassing the
    # PathParam name validation. Re-validate so an empty/malformed key returns a
    # clean 422 (was an unhandled 500) and env-shadowing names are rejected.
    if not name or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", name):
        raise HTTPException(
            status_code=422,
            detail="Secret name must match [A-Z][A-Z0-9_]* and be 1-64 characters.",
        )
    if name in _SENSITIVE_ENV_SECRET_NAMES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{name!r} is a reserved environment variable name and cannot be "
                "used as a secret (it would shadow the runner's own environment)."
            ),
        )
    if name in PLATFORM_SECRETS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{name!r} is a platform infrastructure secret managed via "
                "the server's environment file. It cannot be set via the "
                "secrets API. See ARCHITECTURE.md."
            ),
        )
    if _secret_value_has_control_chars(payload.value):
        raise HTTPException(
            status_code=400,
            detail="Secret value must not contain newline or control characters",
        )
    _require_secret_mutation_allowed(auth, repos.secrets.get(user_id=auth.user_id, name=name), name)
    repos.secrets.set(
        user_id=auth.user_id,
        name=name,
        value=payload.value,
        status=SecretStatus.SET.value,
    )
    # #952: secret mutations are audit-logged with the actor (never the value).
    logger.info("Secret %s upserted by user=%s role=%s", name, auth.user_id, auth.role)
    # Re-encrypt .secrets.enc if workspace is connected to GitHub
    _cfg = _git_cfg_get(auth.user_id)
    if _cfg and _cfg.get("github_pat") and _cfg.get("repo_full_name"):
        _sync_secrets_to_enc(auth.user_id, repos, _cfg["github_pat"], _cfg["repo_full_name"])
    return SecretTestResult(status="valid", reason=f"Secret {name!r} saved.")


@secrets_router.delete("/secrets/{name}", response_model=SecretTestResult)
def delete_secret(
    name: SecretName,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SecretTestResult:
    """Delete a secret from .env and env.

    SECURITY: refuses to delete a platform infrastructure secret for the
    same reason as upsert_secret.
    """
    if name in PLATFORM_SECRETS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{name!r} is a platform infrastructure secret. It cannot "
                "be deleted via the secrets API."
            ),
        )
    existing = repos.secrets.get(user_id=auth.user_id, name=name)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"Secret {name!r} not found in .env")
    _require_secret_mutation_allowed(auth, existing, name)
    repos.secrets.delete(user_id=auth.user_id, name=name)
    # #952: secret mutations are audit-logged with the actor (never the value).
    logger.info("Secret %s deleted by user=%s role=%s", name, auth.user_id, auth.role)
    # Re-encrypt .secrets.enc if workspace is connected to GitHub
    _cfg = _git_cfg_get(auth.user_id)
    if _cfg and _cfg.get("github_pat") and _cfg.get("repo_full_name"):
        _sync_secrets_to_enc(auth.user_id, repos, _cfg["github_pat"], _cfg["repo_full_name"])
    return SecretTestResult(status="valid", reason=f"Secret {name!r} removed.")


@secrets_router.post("/secrets/{name}/test", response_model=SecretTestResult)
def test_secret(
    name: SecretName,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> SecretTestResult:
    """Test a user-managed secret without exposing provider details or values."""
    if name in PLATFORM_SECRETS:
        raise HTTPException(status_code=404, detail="Secret not found")
    db_row = repos.secrets.get(user_id=auth.user_id, name=name)
    if db_row is not None:
        value = repos.secrets.read_value(user_id=auth.user_id, name=name)
        if not value:
            raise HTTPException(status_code=404, detail="Secret not found")
        return SecretTestResult(status="valid", reason="Secret is configured.")
    # Secret not in DB — check if it is available via environment (e.g. set as a
    # platform env var that the list endpoint also surfaces as SET).
    available = _available_secret_names_for_user(auth.user_id, repos)
    if name in available:
        return SecretTestResult(status="valid", reason="Secret is configured.")
    raise HTTPException(status_code=404, detail="Secret not found")


@secrets_router.get("/secrets", response_model=List[SecretItem])
def list_secrets(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[SecretItem]:
    from run_service import get_worker_config_for_run

    db_secrets = {
        row["name"]: row_to_dict(row)
        for row in repos.secrets.list(user_id=auth.user_id)
    }

    workers = _list_visible_workers(user_id=auth.user_id, repos=repos, use_cache=True)
    platform_available = _available_secret_names_for_user(auth.user_id, repos) - set(db_secrets)

    # Build worker configs once — avoids N×M get_worker_config_for_run() calls
    # (one per worker per secret) that would otherwise hit the DB on every secret.
    worker_configs: dict[str, Any] = {}
    worker_secret_names: set[str] = set()
    for w in workers:
        config = get_worker_config_for_run(w["id"])
        worker_configs[w["id"]] = config
        if config:
            worker_secret_names.update(config.secrets)

    # Filter out platform-managed secrets — they appear in Settings, not here
    all_secret_names = (worker_secret_names | set(db_secrets)) - PLATFORM_SECRETS

    result: List[SecretItem] = []
    for name in sorted(all_secret_names):
        db_row = db_secrets.get(name, {})
        value = db_row.get("value")
        status_value = str(db_row.get("status") or "").lower()
        if status_value in SecretStatus._value2member_map_:
            status = SecretStatus(status_value)
        elif name in platform_available:
            status = SecretStatus.SET
        else:
            status = SecretStatus.SET if value else SecretStatus.MISSING
        used_by = [
            w["name"]
            for w in workers
            if worker_configs.get(w["id"]) and name in worker_configs[w["id"]].secrets
        ]
        result.append(
            SecretItem(
                name=name,
                status=status,
                last_used_at=db_row.get("last_used_at"),
                last_checked_at=db_row.get("last_checked_at"),
                last_check_status=db_row.get("last_check_status"),
                used_by=used_by,
            )
        )
    return result
