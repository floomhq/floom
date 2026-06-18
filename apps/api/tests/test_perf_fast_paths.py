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


def test_runs_list_uses_sql_visibility_keyset_and_cheap_has_more(monkeypatch):
    from starlette.responses import Response
    from routers import runs

    captured: dict[str, object] = {}

    class Request:
        headers = {}
        query_params = {"limit": "2", "before_created_at": "2026-06-18T00:00:00+00:00", "before_id": "run-3"}

    class RunsRepo:
        def list_operator_visible(self, **kwargs):
            captured.update(kwargs)
            return [
                {
                    "id": "run-2",
                    "worker_id": "worker-a",
                    "worker_name": "Worker A",
                    "status": "completed",
                    "trigger_source": "manual",
                    "input_json": "{}",
                    "created_at": "2026-06-17T00:00:00+00:00",
                    "started_at": None,
                    "completed_at": None,
                    "duration_ms": None,
                    "error": None,
                    "error_code": None,
                },
                {
                    "id": "run-1",
                    "worker_id": "worker-a",
                    "worker_name": "Worker A",
                    "status": "completed",
                    "trigger_source": "manual",
                    "input_json": "{}",
                    "created_at": "2026-06-16T00:00:00+00:00",
                    "started_at": None,
                    "completed_at": None,
                    "duration_ms": None,
                    "error": None,
                    "error_code": None,
                },
            ], 3

        def list(self, **_kwargs):
            raise AssertionError("legacy list path was used")

    response = Response()
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)
    monkeypatch.setattr(runs.hot_cache, "get", lambda _key: None)
    monkeypatch.setattr(runs.hot_cache, "set", lambda _key, _value: None)

    result = runs.list_runs(
        request=Request(),
        response=response,
        limit=2,
        before_created_at="2026-06-18T00:00:00+00:00",
        before_id="run-3",
        auth=SimpleNamespace(user_id="user-a", role="admin"),
        repos=SimpleNamespace(runs=RunsRepo()),
    )

    assert [row.id for row in result] == ["run-2", "run-1"]
    assert captured["before_created_at"] == "2026-06-18T00:00:00+00:00"
    assert captured["before_id"] == "run-3"
    assert response.headers["X-Total-Count"] == "3"
    assert response.headers["X-Has-More"] == "true"
    assert response.headers["X-Next-Before-Created-At"] == "2026-06-16T00:00:00+00:00"
    assert response.headers["X-Next-Before-Id"] == "run-1"


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


def test_list_secrets_uses_listed_worker_configs_for_used_by(monkeypatch):
    import sys
    from routers import secrets

    class SecretsRepo:
        def list(self, *, user_id):
            assert user_id == "user-a"
            return [
                {"name": "API_KEY", "status": "set", "value": "redacted"},
                {"name": "OTHER_KEY", "status": "set", "value": "redacted"},
            ]

    repos = SimpleNamespace(secrets=SecretsRepo())
    auth = SimpleNamespace(user_id="user-a", is_admin=True, role="admin")
    workers = [
        {"id": "worker-a", "name": "Worker A", "config": {"secrets": ["API_KEY", "OTHER_KEY"]}},
        {"id": "worker-b", "name": "Worker B", "config": {"exec": {"secrets": ["API_KEY"]}}},
    ]

    class BombRunService:
        def __getattr__(self, name):
            raise AssertionError(f"run_service.{name} was accessed")

    monkeypatch.setitem(sys.modules, "run_service", BombRunService())
    monkeypatch.setattr(secrets, "_list_visible_workers", lambda **_kwargs: workers)
    monkeypatch.setattr(secrets, "_available_secret_names_for_user", lambda *_args, **_kwargs: set())

    result = secrets.list_secrets(auth=auth, repos=repos)
    by_name = {item.name: item for item in result}

    assert by_name["API_KEY"].used_by == ["Worker A", "Worker B"]
    assert by_name["OTHER_KEY"].used_by == ["Worker A"]
