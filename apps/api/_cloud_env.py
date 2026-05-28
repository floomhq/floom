from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

_CLOUD_ENV_PATH = Path("/root/.config/floom-secrets/supabase-management.env")


@lru_cache(maxsize=1)
def load_cloud_env_file() -> None:
    if _CLOUD_ENV_PATH.is_file():
        load_dotenv(_CLOUD_ENV_PATH, override=False)
