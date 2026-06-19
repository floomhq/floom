"""Secret resolution for worker runs: runtime env-file loading, DB-backed
secret-name discovery, and the per-worker secret bundle (with the platform-
secret denylist).

Extracted verbatim from run_service.py. run_service re-imports these names for
backward compatibility. The worker-config / owner / repo helpers are lazy-
imported from run_service to avoid a module-load circular import.
"""
from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Dict

from db.factory import Repositories
from dotenv import load_dotenv

logger = logging.getLogger("floom.run_service")


def _load_runtime_env_files() -> None:
    # Load the SAME secret-store files the write path (`SqliteSecretRepository
    # .set`) persists values into, so run-time secret resolution is consistent
    # across ALL run paths (manual, scheduled, webhook, composio): a secret set
    # under the worker's owner is found at run time regardless of how the run
    # was triggered.
    #
    # N4-1 root cause: the secret-store path was source-tree-relative
    # (`apps/api/.env` next to the db source file). Two processes serving the
    # same shared DB but running from different deploy directories
    # (/opt/workeros vs /opt/workeros-live vs a /tmp worktree) resolved it to
    # DIFFERENT files. The DB row (absolute WORKEROS_DB path) is shared, so a
    # secret read back as "set" while its value was orphaned in another tree's
    # .env — every scheduled run failed "missing_secret". The store path is now
    # DB-anchored (stable across deploys) and we read across legacy locations
    # so pre-fix values still resolve.
    from run_service import API_ENV_PATH
    from db import secret_store_read_paths

    for secret_store in secret_store_read_paths():
        if secret_store.is_file():
            load_dotenv(secret_store, override=False)
    try:
        if API_ENV_PATH.is_file():
            load_dotenv(API_ENV_PATH, override=False)
    except (PermissionError, OSError):
        pass


def _env_keys_from_file(path: Path) -> set[str]:
    keys: set[str] = set()
    if not path.is_file():
        return keys
    for line in path.read_text(encoding='utf-8').splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            keys.add(key)
    return keys


def _secret_names_from_db(
    user_id: str,
    repos: Repositories | None = None,
) -> set[str]:
    from run_service import _repos
    try:
        return _repos(repos).secrets.list_names(user_id=user_id)
    except Exception:
        return set()


_PLATFORM_SECRET_NAMES: frozenset[str] = frozenset({
    # Platform infrastructure credentials — never legitimate worker inputs.
    "FLOOM_SECRET",
    "COMPOSIO_API_KEY",
    "COMPOSIO_WEBHOOK_SIGNING_KEY",
    "E2B_API_KEY",
    "FLOOM_DEPLOY_SECRET",
    # The platform's OWN OpenAI key — Emily/codegen only, never a worker input.
    # Workers bring their own OPENAI_API_KEY via the secrets DB (which IS allowed
    # into the sandbox), so OPENAI_API_KEY stays off this denylist; the platform
    # key lives under a separate reserved name that must never reach a sandbox.
    "PLATFORM_OPENAI_API_KEY",
    # Platform infra paths / tuning vars — same.
    "WORKERS_FRONTEND_URL",
    "FLOOM_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_CONTEXTS_DIR",
    "FLOOM_RUN_TIMEOUT",
    # NOTE: OPENAI_API_KEY is INTENTIONALLY NOT in this list. Workers
    # legitimately need it to call OpenAI from inside the sandbox (research_brief,
    # csv_enricher, resume_helper etc. all declare secrets: [OPENAI_API_KEY]).
    # Workeros v0 is single-user, so the platform owner == the worker author,
    # and sharing the OpenAI key is acceptable. When the platform goes
    # multi-tenant (skills-neo v0.y), this needs to change: each tenant must
    # bring their own OPENAI_API_KEY via the secrets DB, and the platform's
    # own key must move to a separate name like PLATFORM_OPENAI_API_KEY.
    # See ARCHITECTURE.md.
})


def get_secrets_for_worker(
    worker_id: str,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> Dict[str, str]:
    """Resolve the secrets dict that ships to the worker sandbox.

    SECURITY: The sandbox secrets.json must contain ONLY:
      (a) secrets declared in the worker's worker.yml `exec.secrets` field
      (b) user-managed secrets stored in the platform's `secrets` DB table
    It must NEVER contain platform infrastructure credentials (FLOOM_SECRET,
    E2B_API_KEY, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY, OPENAI_API_KEY,
    etc.) because the sandbox runs untrusted worker code and any leak there
    is equivalent to publishing the secret.

    Pre-fix this function unioned every key in `/etc/workeros/api.env`
    into the result, including all platform secrets above. Audit 2026-05-26
    flagged it as P0. The `_PLATFORM_SECRET_NAMES` denylist now blocks them
    regardless of whether they appear in the worker manifest or the DB.

    SECRET-SCOPING GUARD (Members STEP 1, Codex top risk): secrets ALWAYS resolve
    to the WORKER'S OWNER, never to whoever happens to be running it. When a member
    runs a ``workspace``-visibility worker shared by another owner, the caller
    passes the RUNNER's id as ``user_id``; using that to resolve secrets would (a)
    leak the runner's OWN private secrets into someone else's worker, and (b) fail
    the run because the owner's declared secrets live under the owner's id, not the
    runner's. So we resolve the owner from the worker row and ignore a passed
    ``user_id`` that does NOT match it. The passed ``user_id`` is only used as a
    fallback when the worker has no DB owner (filesystem-only stock workers, where
    owner == caller by construction). On the OSS single-owner engine owner == the
    local user, so behaviour is unchanged.
    """
    from run_service import _repos, _worker_owner_id, _get_worker_config_for_run
    from run_service import _cache_ttl_seconds, _secret_cache_by_key, _secret_cache_lock
    repos_obj = _repos(repos)
    true_owner_id = _worker_owner_id(worker_id, repos_obj)
    # Resolve strictly against the worker's real owner. Only fall back to the
    # passed user_id when the worker has no owner row at all (stock/FS workers).
    owner_id = true_owner_id or user_id
    if not owner_id:
        return {}
    if true_owner_id and user_id and user_id != true_owner_id:
        logger.info(
            "Secret scoping: worker %s run by %s resolves secrets to owner %s "
            "(runner's own secrets are NOT used).",
            worker_id,
            user_id,
            true_owner_id,
        )
    ttl = _cache_ttl_seconds("WORKEROS_RUN_SECRET_CACHE_TTL_SECONDS", 10.0)
    cache_key = (worker_id, owner_id)
    if ttl > 0:
        now = time.monotonic()
        with _secret_cache_lock:
            cached = _secret_cache_by_key.get(cache_key)
            if cached is not None and cached[0] > now:
                return dict(cached[1])
    _load_runtime_env_files()
    config = _get_worker_config_for_run(worker_id, repos_obj)
    names = set(config.secrets if config else [])
    names.update(_secret_names_from_db(owner_id, repos_obj))
    # DO NOT union env-file keys here. They include platform infra secrets.
    allowed_names = [name for name in names if name not in _PLATFORM_SECRET_NAMES]
    resolved = repos_obj.secrets.resolve(user_id=owner_id, names=allowed_names)
    if ttl > 0:
        with _secret_cache_lock:
            _secret_cache_by_key[cache_key] = (time.monotonic() + ttl, dict(resolved))
    return resolved


