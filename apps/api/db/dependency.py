from __future__ import annotations

from .factory import Repositories, get_repositories


def get_repos() -> Repositories:
    return get_repositories()
