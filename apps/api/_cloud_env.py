from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

_CLOUD_ENV_PATH = Path("/root/.config/floom-secrets/supabase-management.env")

# Candidate local env files checked in order (first found wins).
# Covers Windows dev machines where the Linux path above doesn't exist.
_LOCAL_ENV_CANDIDATES = [
    Path(__file__).resolve().parents[3] / ".env",  # repo root .env
    Path(__file__).resolve().parents[2] / ".env",  # apps/.env
    Path(__file__).resolve().parent / ".env",       # apps/api/.env
]


@lru_cache(maxsize=1)
def load_cloud_env_file() -> None:
    # Check each candidate, tolerating OSError. Notably, the container runs as a
    # non-root user (uid 10001), so stat-ing _CLOUD_ENV_PATH under /root/ raises
    # PermissionError (EACCES) — and Path.is_file() RE-RAISES permission errors
    # (it only swallows not-found). This runs at import time, so an unhandled
    # error crashes startup. On Railway all secrets come from real env vars, so a
    # missing/unreadable env file is fine — skip it and continue.
    for candidate in (_CLOUD_ENV_PATH, *_LOCAL_ENV_CANDIDATES):
        try:
            if candidate.is_file():
                load_dotenv(candidate, override=False)
                return
        except OSError:
            continue
