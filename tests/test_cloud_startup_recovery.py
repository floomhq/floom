from __future__ import annotations

import asyncio
import sys
import types


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeRunsTable:
    def __init__(self, rows):
        self._rows = rows
        self._selected = None
        self._status = None

    def select(self, columns):
        self._selected = columns
        return self

    def eq(self, column, value):
        if column == "status":
            self._status = value
        return self

    def execute(self):
        assert self._selected == "user_id"
        assert self._status == "running"
        return _FakeResponse(self._rows)


class _FakeClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, name):
        assert name == "runs"
        return _FakeRunsTable(self._rows)


def test_recover_cloud_runs_on_startup_fans_out_per_owner(monkeypatch):
    import apps.api.config as config
    import apps.api.startup as startup

    calls: list[str] = []

    class FakeRunService:
        def fail_interrupted_runs_on_startup(self, *, user_id):
            calls.append(user_id)
            return 2 if user_id == "owner-a" else 1

    monkeypatch.setattr(
        config,
        "get_supabase_service_client",
        lambda: _FakeClient(
            [
                {"user_id": "owner-b"},
                {"user_id": "owner-a"},
                {"user_id": "owner-a"},
                {"user_id": ""},
                None,
            ]
        ),
    )
    monkeypatch.setattr(startup, "import_engine_module", lambda _name: FakeRunService())

    assert startup.recover_cloud_runs_on_startup() == 3
    assert calls == ["owner-a", "owner-b"]


def test_cloud_lifespan_runs_startup_recovery(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    # The advisory-lock path (start_cloud_scheduler, faked via psycopg below) is
    # only taken when a DB host is configured; without this the lifespan falls
    # back to the no-DB branch (_ie("scheduler").start_scheduler()), which this
    # test doesn't patch, so the expected "scheduler" event never fires.
    monkeypatch.setenv("WORKEROS_CLOUD_DB_HOST", "db.example.com")
    monkeypatch.setitem(
        sys.modules,
        "psycopg",
        types.SimpleNamespace(
            Connection=object,
            connect=lambda *args, **kwargs: types.SimpleNamespace(
                cursor=lambda: types.SimpleNamespace(
                    __enter__=lambda self=None: types.SimpleNamespace(
                        execute=lambda *a, **k: None,
                        fetchone=lambda: (True,),
                    ),
                    __exit__=lambda *args: None,
                ),
                close=lambda: None,
                closed=False,
            ),
        ),
    )

    import apps.api.main as main

    events: list[str] = []

    monkeypatch.setattr(main, "start_cloud_scheduler", lambda: events.append("scheduler") or True)
    monkeypatch.setattr(main, "stop_cloud_scheduler", lambda: events.append("stop_scheduler"))
    monkeypatch.setattr(main.engine_run_service, "start_drain_loop", lambda: events.append("drain"))
    monkeypatch.setattr(
        main.engine_run_service,
        "re_enqueue_queued_runs_on_startup",
        lambda: events.append("requeue"),
    )
    monkeypatch.setattr(
        main.cloud_startup,
        "recover_cloud_runs_on_startup",
        lambda: events.append("recover") or 4,
    )
    monkeypatch.setattr(main.engine_run_service, "stop_drain_loop", lambda timeout=5.0: events.append("stop_drain"))

    async def _run():
        from fastapi import FastAPI

        async with main.lifespan(FastAPI()):
            events.append("inside")

    asyncio.run(_run())

    assert events == [
        "scheduler",
        "drain",
        "requeue",
        "recover",
        "inside",
        "stop_drain",
        "stop_scheduler",
    ]


def test_cloud_lifespan_requires_scheduler_lock_db(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.delenv("WORKEROS_CLOUD_DB_HOST", raising=False)

    import apps.api.main as main

    async def _run():
        from fastapi import FastAPI

        async with main.lifespan(FastAPI()):
            pass

    try:
        asyncio.run(_run())
    except RuntimeError as exc:
        assert "WORKEROS_CLOUD_DB_HOST is required" in str(exc)
    else:
        raise AssertionError("cloud lifespan must fail closed without scheduler DB lock env")
