from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier


def test_create_first_admin_allows_exactly_one_winner(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "auth-setup-race.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "auth-setup-race.db"))

    from db import get_repositories, init_db

    init_db()
    users = get_repositories().users
    barrier = Barrier(2)

    def create(idx: int):
        barrier.wait(timeout=5)
        return users.create_first_admin(
            user_id=f"admin-{idx}",
            username=f"admin-{idx}",
            display_name=None,
            password_hash="hash",
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(create, [1, 2]))

    assert sum(row is not None for row in results) == 1
    assert users.count() == 1
