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
    if _CLOUD_ENV_PATH.is_file():
        load_dotenv(_CLOUD_ENV_PATH, override=False)
        return
    for candidate in _LOCAL_ENV_CANDIDATES:
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            return
