from __future__ import annotations

from types import SimpleNamespace


def test_cloud_runs_omitted_limit_uses_safe_default(monkeypatch):
    from starlette.responses import Response
    from routers import runs

    captured: dict[str, int] = {}

    class Request:
        headers = {}
        query_params = {}

    def fake_list_visible_runs(**kwargs):
        captured["limit"] = kwargs["limit"]
        return [], 0

    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setattr(runs.hot_cache, "get", lambda _key: None)
    monkeypatch.setattr(runs.hot_cache, "set", lambda _key, _value: None)
    monkeypatch.setattr(runs, "_list_visible_runs", fake_list_visible_runs)

    result = runs.list_runs(
        request=Request(),
        response=Response(),
        auth=SimpleNamespace(user_id="user-a", role="admin"),
        repos=SimpleNamespace(),
    )

    assert result == []
    assert captured["limit"] == 20


def test_cloud_runs_explicit_limit_is_respected(monkeypatch):
    from starlette.responses import Response
    from routers import runs

    captured: dict[str, int] = {}

    class Request:
        headers = {}
        query_params = {"limit": "50"}

    def fake_list_visible_runs(**kwargs):
        captured["limit"] = kwargs["limit"]
        return [], 0

    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setattr(runs.hot_cache, "get", lambda _key: None)
    monkeypatch.setattr(runs.hot_cache, "set", lambda _key, _value: None)
    monkeypatch.setattr(runs, "_list_visible_runs", fake_list_visible_runs)

    result = runs.list_runs(
        request=Request(),
        response=Response(),
        limit=50,
        auth=SimpleNamespace(user_id="user-a", role="admin"),
        repos=SimpleNamespace(),
    )

    assert result == []
    assert captured["limit"] == 50


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
