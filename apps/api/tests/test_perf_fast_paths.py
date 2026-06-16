from __future__ import annotations

from types import SimpleNamespace


def test_list_visible_runs_fast_mode_stops_after_page(monkeypatch):
    from services import run_access

    calls: list[int] = []

    class Runs:
        def list(self, **kwargs):
            calls.append(kwargs["offset"])
            rows = [
                {"id": f"run-{kwargs['offset'] + idx}", "worker_id": "worker-a", "trigger_source": "manual"}
                for idx in range(kwargs["limit"])
            ]
            return rows, kwargs["offset"] + len(rows) + 1000

    repos = SimpleNamespace(runs=Runs())
    monkeypatch.setattr(run_access, "_run_visible_to_api", lambda row, *, user_id, repos: True)
    monkeypatch.setattr(run_access, "_is_operator_run", lambda row: True)

    rows, total = run_access._list_visible_runs(
        user_id="user-a",
        repos=repos,
        limit=10,
        offset=0,
        exact_total=False,
    )

    assert len(rows) == 10
    assert total == 11
    assert calls == [0]


def test_list_connections_empty_rows_skips_last_used(monkeypatch):
    from routers import connections

    class Connections:
        def list(self, *, user_id):
            return []

    repos = SimpleNamespace(connections=Connections())
    auth = SimpleNamespace(user_id="user-a")
    monkeypatch.setattr(
        connections,
        "_connections_last_used",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("should not be called")),
    )

    assert connections.list_connections(auth=auth, repos=repos) == []
