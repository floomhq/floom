"""Per-user spend cap overrides + the 80% warning band.

Regression cover for the 2026-07-25 outage: a $25.69 month-to-date spend crossed a
$25 per-USER monthly cap that had no override path and no warning, so every
scheduled worker on the account silently stopped firing for four days.

What is asserted here:
  - an override applies to THAT user and to nobody else (the whole point: headroom
    for one customer without raising the ceiling globally);
  - clearing an override falls back to the env default;
  - a store outage falls back to the env default, never to "no cap";
  - crossing the warn ratio surfaces a warning while runs still succeed;
  - a user under the cap sees no behaviour change at all;
  - admission is a threshold, so the reported overshoot is visible, not hidden.

Run: cd apps/api && python -m pytest tests/test_user_spend_cap_overrides.py -q
"""
from __future__ import annotations

import importlib
import sys
import textwrap
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-user-caps"


def _yml(worker_id: str) -> str:
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: t
        description: d
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        """
    ).strip() + "\n"


@pytest.fixture
def client_main(monkeypatch, tmp_path):
    (tmp_path / "workers").mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "25")
    monkeypatch.setenv("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "5")
    # Keep the workspace backstops out of the way: these tests are about the USER
    # caps, and the workspace caps sit later in the same admission ladder.
    monkeypatch.setenv("WORKEROS_DEFAULT_MONTHLY_SPEND_CAP_USD", "100000")
    monkeypatch.setenv("WORKEROS_DEFAULT_DAILY_SPEND_CAP_USD", "100000")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(
            ("routers", "services", "core", "db", "auth", "contexts", "runner_sandbox")
        ):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    main = importlib.import_module("main")
    main.start_run = lambda *a, **k: None
    import run_service

    run_service.start_run = main.start_run
    from fastapi.testclient import TestClient

    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield client, main
    from services.run_cost import clear_user_spend_cap_store

    clear_user_spend_cap_store()


def _seed_cost(worker_id, cost, created_at, *, actor_user_id=None, run_suffix=""):
    from db import get_db

    columns = ["id", "worker_id", "status", "trigger_source", "runner", "created_at", "total_cost_usd"]
    values = [
        f"r_{worker_id}_{int(cost * 100)}{run_suffix}",
        worker_id,
        "completed",
        "manual",
        "e2b",
        created_at,
        cost,
    ]
    if actor_user_id is not None:
        columns.insert(2, "actor_user_id")
        values.insert(2, actor_user_id)
    placeholders = ", ".join("?" for _ in columns)
    with get_db() as conn:
        conn.execute(f"INSERT INTO runs ({', '.join(columns)}) VALUES ({placeholders})", tuple(values))


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")


class TestOverrideResolution:
    def test_default_is_env_when_no_override(self, client_main):
        from services.run_cost import _user_daily_spend_cap_usd, _user_monthly_spend_cap_usd

        assert _user_monthly_spend_cap_usd("alice") == 25.0
        assert _user_daily_spend_cap_usd("alice") == 5.0

    def test_override_applies_to_that_user_only(self, client_main):
        from services.run_cost import (
            _user_daily_spend_cap_usd,
            _user_monthly_spend_cap_usd,
            set_user_spend_caps,
        )

        set_user_spend_caps("alice", monthly_spend_cap_usd=500.0, daily_spend_cap_usd=90.0)

        assert _user_monthly_spend_cap_usd("alice") == 500.0
        assert _user_daily_spend_cap_usd("alice") == 90.0
        # The whole reason this exists: bob must be untouched.
        assert _user_monthly_spend_cap_usd("bob") == 25.0
        assert _user_daily_spend_cap_usd("bob") == 5.0

    def test_clearing_an_override_returns_to_env_default(self, client_main):
        from services.run_cost import _user_monthly_spend_cap_usd, set_user_spend_caps

        set_user_spend_caps("alice", monthly_spend_cap_usd=500.0, daily_spend_cap_usd=None)
        assert _user_monthly_spend_cap_usd("alice") == 500.0
        set_user_spend_caps("alice", monthly_spend_cap_usd=None, daily_spend_cap_usd=None)
        assert _user_monthly_spend_cap_usd("alice") == 25.0

    def test_override_can_also_lower_a_cap(self, client_main):
        from services.run_cost import _user_monthly_spend_cap_usd, set_user_spend_caps

        set_user_spend_caps("alice", monthly_spend_cap_usd=1.0, daily_spend_cap_usd=None)
        assert _user_monthly_spend_cap_usd("alice") == 1.0

    def test_store_failure_falls_back_to_env_default_not_to_no_cap(self, client_main):
        """A store outage must never silently remove the platform cost control."""
        from services.run_cost import _user_monthly_spend_cap_usd, register_user_spend_cap_store

        class _BrokenStore:
            def get(self, user_id):
                raise RuntimeError("supabase unreachable")

            def set(self, user_id, **kwargs):
                raise RuntimeError("supabase unreachable")

        register_user_spend_cap_store(_BrokenStore())
        assert _user_monthly_spend_cap_usd("alice") == 25.0

    def test_injected_store_wins_over_sqlite(self, client_main):
        from services.run_cost import _user_monthly_spend_cap_usd, register_user_spend_cap_store

        class _FakeStore:
            def get(self, user_id):
                return {"monthly_spend_cap_usd": 777.0} if user_id == "alice" else {}

            def set(self, user_id, **kwargs):
                raise AssertionError("not used in this test")

        register_user_spend_cap_store(_FakeStore())
        assert _user_monthly_spend_cap_usd("alice") == 777.0
        assert _user_monthly_spend_cap_usd("bob") == 25.0

    def test_negative_and_garbage_overrides_are_ignored(self, client_main):
        from services.run_cost import _user_monthly_spend_cap_usd, register_user_spend_cap_store

        class _JunkStore:
            def get(self, user_id):
                return {"monthly_spend_cap_usd": -3.0, "daily_spend_cap_usd": "abc"}

            def set(self, user_id, **kwargs):
                pass

        register_user_spend_cap_store(_JunkStore())
        assert _user_monthly_spend_cap_usd("alice") == 25.0

    def test_set_rejects_out_of_range(self, client_main):
        from services.run_cost import set_user_spend_caps

        with pytest.raises(ValueError):
            set_user_spend_caps("alice", monthly_spend_cap_usd=-1.0, daily_spend_cap_usd=None)
        with pytest.raises(ValueError):
            set_user_spend_caps("alice", monthly_spend_cap_usd=2_000_000.0, daily_spend_cap_usd=None)


class TestEnforcementUsesTheOverride:
    """The override has to change ADMISSION, not just a getter."""

    def _make_worker(self, client, worker_id):
        assert (
            client.post("/workers", json={"worker_yml": _yml(worker_id), "run_py": "print(1)"}).status_code == 200
        )

    def test_run_blocked_at_env_default_is_admitted_after_override(self, client_main):
        client, main = client_main
        self._make_worker(client, "capuserworker")
        import run_service

        # Spend past the $25 env default for the run owner.
        owner = run_service._worker_owner_id("capuserworker", run_service._repos(None))
        _seed_cost("capuserworker", 26.0, _today(), actor_user_id=owner)

        resp = client.post("/workers/capuserworker/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 402, resp.text
        assert resp.json()["detail"]["error_code"] == "spend_cap_exceeded"
        # Admission is a threshold, so the message names the overshoot instead of
        # pretending spend stopped exactly at the cap.
        assert "over" in resp.json()["detail"]["message"]

        from services.run_cost import set_user_spend_caps

        set_user_spend_caps(owner, monthly_spend_cap_usd=500.0, daily_spend_cap_usd=500.0)
        resp = client.post("/workers/capuserworker/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 200, resp.text

    def test_other_user_stays_capped(self, client_main):
        """Raising alice's cap must not raise anyone else's."""
        client, _ = client_main
        from services.run_cost import _user_monthly_spend_cap_usd, set_user_spend_caps

        set_user_spend_caps("alice", monthly_spend_cap_usd=500.0, daily_spend_cap_usd=500.0)
        assert _user_monthly_spend_cap_usd("alice") == 500.0
        assert _user_monthly_spend_cap_usd("carol") == 25.0


class TestWarningBand:
    def test_no_warning_below_the_ratio(self, client_main):
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("warnworkerlow"), "run_py": "print(1)"}).status_code
            == 200
        )
        import run_service

        owner = run_service._worker_owner_id("warnworkerlow", run_service._repos(None))
        _seed_cost("warnworkerlow", 1.0, _today(), actor_user_id=owner)

        from services.run_cost import spend_cap_warnings

        assert spend_cap_warnings(owner, repos=run_service._repos(None), scope_user_id=owner) == []

    def test_warning_fires_at_the_ratio_while_runs_still_succeed(self, client_main):
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("warnworker"), "run_py": "print(1)"}).status_code == 200
        )
        import run_service

        owner = run_service._worker_owner_id("warnworker", run_service._repos(None))
        # 80% of the $25 monthly default, and below the $5 daily default is
        # impossible at $20, so seed the spend in a prior day of the same month.
        month_start = datetime.now(timezone.utc).replace(day=1).strftime("%Y-%m-01T00:00:00+00:00")
        _seed_cost("warnworker", 20.5, month_start, actor_user_id=owner)

        from services.run_cost import spend_cap_warnings, user_spend_snapshot

        warnings = spend_cap_warnings(owner, repos=run_service._repos(None), scope_user_id=owner)
        assert [w["scope"] for w in warnings] == ["user_monthly"]
        assert "82%" in warnings[0]["message"]
        assert warnings[0]["exceeded"] is False

        snapshot = user_spend_snapshot(owner, repos=run_service._repos(None), scope_user_id=owner)
        monthly = next(s for s in snapshot["scopes"] if s["scope"] == "user_monthly")
        assert monthly["warning"] is True
        assert monthly["exceeded"] is False
        assert monthly["overshoot_usd"] == 0.0

        # The point of a warning: the user is told BEFORE anything stops working.
        resp = client.post("/workers/warnworker/runs", json={"inputs": {}, "trigger_source": "manual"})
        assert resp.status_code == 200, resp.text

    def test_exceeded_is_reported_as_exceeded_not_dropped(self, client_main):
        """Past 100% the item changes tone but must stay visible."""
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("overworker"), "run_py": "print(1)"}).status_code == 200
        )
        import run_service

        owner = run_service._worker_owner_id("overworker", run_service._repos(None))
        month_start = datetime.now(timezone.utc).replace(day=1).strftime("%Y-%m-01T00:00:00+00:00")
        _seed_cost("overworker", 25.69, month_start, actor_user_id=owner)

        from services.run_cost import spend_cap_warnings, user_spend_snapshot

        snapshot = user_spend_snapshot(owner, repos=run_service._repos(None), scope_user_id=owner)
        monthly = next(s for s in snapshot["scopes"] if s["scope"] == "user_monthly")
        assert monthly["warning"] is False
        assert monthly["exceeded"] is True
        # The exact overshoot from the real incident, reported rather than hidden.
        assert monthly["overshoot_usd"] == 0.69

        # The notice must NOT vanish at 100%: that would hide the problem exactly
        # when it starts refusing runs.
        reported = spend_cap_warnings(owner, repos=run_service._repos(None), scope_user_id=owner)
        assert [w["scope"] for w in reported] == ["user_monthly"]
        assert "Runs are being refused" in reported[0]["message"]
        assert "$0.69 over" in reported[0]["message"]

    def test_warning_ratio_is_configurable(self, client_main, monkeypatch):
        monkeypatch.setenv("WORKEROS_SPEND_CAP_WARN_RATIO", "0.5")
        from services.run_cost import _spend_cap_warn_ratio

        assert _spend_cap_warn_ratio() == 0.5
        monkeypatch.setenv("WORKEROS_SPEND_CAP_WARN_RATIO", "nonsense")
        assert _spend_cap_warn_ratio() == 0.8
        monkeypatch.setenv("WORKEROS_SPEND_CAP_WARN_RATIO", "3")
        assert _spend_cap_warn_ratio() == 0.8


class TestOverviewSurface:
    def test_overview_lists_a_spend_cap_warning(self, client_main):
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("ovwarnworker"), "run_py": "print(1)"}).status_code
            == 200
        )
        import run_service

        owner = run_service._worker_owner_id("ovwarnworker", run_service._repos(None))
        month_start = datetime.now(timezone.utc).replace(day=1).strftime("%Y-%m-01T00:00:00+00:00")
        _seed_cost("ovwarnworker", 21.0, month_start, actor_user_id=owner)

        resp = client.get("/system/overview")
        assert resp.status_code == 200, resp.text
        items = [i for i in resp.json()["needs_attention"] if i["type"] == "spend_cap_warning"]
        assert items, resp.json()["needs_attention"]
        assert "spend cap" in items[0]["message"]
        assert items[0]["action_url"] == "/settings"

    def test_overview_reports_an_exceeded_cap_too(self, client_main):
        client, _ = client_main
        assert (
            client.post("/workers", json={"worker_yml": _yml("ovoverworker"), "run_py": "print(1)"}).status_code
            == 200
        )
        import run_service

        owner = run_service._worker_owner_id("ovoverworker", run_service._repos(None))
        month_start = datetime.now(timezone.utc).replace(day=1).strftime("%Y-%m-01T00:00:00+00:00")
        _seed_cost("ovoverworker", 25.69, month_start, actor_user_id=owner)

        resp = client.get("/system/overview")
        assert resp.status_code == 200, resp.text
        items = [i for i in resp.json()["needs_attention"] if i["type"] == "spend_cap_exceeded"]
        assert items, resp.json()["needs_attention"]
        assert "Runs are being refused" in items[0]["message"]

    def test_overview_has_no_spend_item_when_under_the_ratio(self, client_main):
        client, _ = client_main
        resp = client.get("/system/overview")
        assert resp.status_code == 200
        spend_items = [
            i
            for i in resp.json()["needs_attention"]
            if i["type"] in ("spend_cap_warning", "spend_cap_exceeded")
        ]
        assert spend_items == []


class TestApiSurface:
    def test_account_spend_is_self_scoped(self, client_main):
        client, _ = client_main
        resp = client.get("/account/spend")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # All four admission scopes: a user blocked by the WORKSPACE cap needs to
        # see that too, not just their own budget.
        assert {s["scope"] for s in body["scopes"]} == {
            "user_monthly",
            "user_daily",
            "workspace_monthly",
            "workspace_daily",
        }
        assert body["warn_ratio"] == 0.8
        # No cross-user parameter exists, so there is nothing to scope-check.
        assert "user_id" in body

    def test_admin_can_read_and_write_a_users_caps(self, client_main):
        client, _ = client_main
        resp = client.put(
            "/admin/users/alice/spend-caps",
            json={"monthly_spend_cap_usd": 500, "daily_spend_cap_usd": 90},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["effective_monthly_spend_cap_usd"] == 500
        assert resp.json()["monthly_cap_source"] == "override"

        assert client.get("/admin/users/alice/spend-caps").json()["effective_monthly_spend_cap_usd"] == 500
        # And nobody else moved.
        assert client.get("/admin/users/bob/spend-caps").json()["effective_monthly_spend_cap_usd"] == 25
        assert client.get("/admin/users/bob/spend-caps").json()["monthly_cap_source"] == "env_default"

    def test_put_rejects_negative(self, client_main):
        client, _ = client_main
        resp = client.put("/admin/users/alice/spend-caps", json={"monthly_spend_cap_usd": -5})
        assert resp.status_code == 422, resp.text

    def test_put_with_nulls_clears_the_override(self, client_main):
        client, _ = client_main
        client.put("/admin/users/alice/spend-caps", json={"monthly_spend_cap_usd": 500})
        resp = client.put("/admin/users/alice/spend-caps", json={})
        assert resp.status_code == 200, resp.text
        assert resp.json()["monthly_cap_source"] == "env_default"
        assert resp.json()["effective_monthly_spend_cap_usd"] == 25
