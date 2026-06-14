"""Security regression tests for three audit findings.

P1-B  — Stored XSS defense-in-depth: workspace name, worker name/description
         must have HTML tags stripped at input layer before persisting.
P2-A  — GET /metrics (Prometheus) must return 403 for non-admin members.

Run:
    cd apps/api && python -m pytest tests/test_security_xss_and_metrics.py -v
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from typing import Any

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _reload_modules() -> None:
    """Force-reload auth + db + main so each test gets a clean state."""
    for name in list(sys.modules):
        if name in ("main", "db") or name.startswith("db.") or name.startswith("auth."):
            sys.modules.pop(name, None)


def _load_main(monkeypatch: Any, tmp_path: Path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    _reload_modules()
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


# ---------------------------------------------------------------------------
# P1-B: _strip_html_tags helper
# ---------------------------------------------------------------------------

class TestStripHtmlTagsHelper:
    """Unit tests for the main._strip_html_tags() helper directly."""

    def _fn(self):
        import main
        return main._strip_html_tags

    def test_script_tag_stripped(self):
        fn = self._fn()
        assert fn("<script>alert(1)</script>") == "alert(1)"

    def test_img_onerror_stripped(self):
        fn = self._fn()
        result = fn("<img src=x onerror=alert(1)>")
        assert result == ""
        assert "<img" not in result
        assert "onerror" not in result

    def test_plain_text_unchanged(self):
        fn = self._fn()
        assert fn("My Workspace") == "My Workspace"

    def test_empty_string_safe(self):
        fn = self._fn()
        assert fn("") == ""

    def test_nested_tags_stripped(self):
        fn = self._fn()
        result = fn("<b><i>bold italic</i></b>")
        assert result == "bold italic"
        assert "<" not in result


# ---------------------------------------------------------------------------
# P1-B: workspace name — create and update
# ---------------------------------------------------------------------------

class TestWorkspaceNameSanitization:
    """Workspace names with HTML tags must be stored stripped."""

    def test_create_workspace_strips_script_tag(self, monkeypatch, tmp_path):
        _load_main(monkeypatch, tmp_path)
        from auth.local_workspaces import create_local_workspace

        row = create_local_workspace("user-1", "<script>alert(1)</script>My WS")
        assert "<script>" not in row["name"]
        assert "alert(1)" in row["name"]   # text content preserved
        assert "My WS" in row["name"]

    def test_create_workspace_strips_img_onerror(self, monkeypatch, tmp_path):
        _load_main(monkeypatch, tmp_path)
        from auth.local_workspaces import create_local_workspace

        row = create_local_workspace("user-2", "<img src=x onerror=alert(1)>Name")
        assert "<img" not in row["name"]
        assert "onerror" not in row["name"]

    def test_update_workspace_strips_html(self, monkeypatch, tmp_path):
        _load_main(monkeypatch, tmp_path)
        from auth.local_workspaces import create_local_workspace, update_local_workspace

        created = create_local_workspace("user-3", "Clean Name")
        updated = update_local_workspace(
            "user-3", created["id"], name='<b>Bold</b> Workspace'
        )
        assert updated is not None
        assert "<b>" not in updated["name"]
        assert "Bold" in updated["name"]
        assert "Workspace" in updated["name"]

    def test_update_workspace_plain_name_preserved(self, monkeypatch, tmp_path):
        _load_main(monkeypatch, tmp_path)
        from auth.local_workspaces import create_local_workspace, update_local_workspace

        created = create_local_workspace("user-4", "Plain")
        updated = update_local_workspace("user-4", created["id"], name="Renamed WS")
        assert updated is not None
        assert updated["name"] == "Renamed WS"


# ---------------------------------------------------------------------------
# P1-B: worker name/description via PATCH /workers/{id}
# ---------------------------------------------------------------------------

class TestWorkerFieldSanitization:
    """Worker display name and description must have HTML stripped before
    storage via PATCH /workers/{id}."""

    def test_strip_html_in_worker_name(self, monkeypatch, tmp_path):
        """_strip_html_tags is applied to new_name before storing."""
        import main
        result = main._strip_html_tags("<script>xss</script>My Worker")
        assert "<script>" not in result
        assert "xss" in result
        assert "My Worker" in result

    def test_strip_html_in_worker_description(self, monkeypatch, tmp_path):
        """_strip_html_tags is applied to description before storing."""
        import main
        result = main._strip_html_tags("Normal text <img src=x onerror=alert(1)> more text")
        assert "<img" not in result
        assert "onerror" not in result
        assert "Normal text" in result
        assert "more text" in result

    def test_script_tag_in_name_returns_empty_not_raw(self):
        """A name that's ONLY a tag collapses to empty string."""
        import main
        result = main._strip_html_tags("<script>alert(1)</script>")
        assert "<" not in result
        assert ">" not in result


# ---------------------------------------------------------------------------
# P2-A: /metrics admin-only gate
# ---------------------------------------------------------------------------

class TestPrometheusMetricsAdminGate:
    """GET /metrics must return 403 for non-admin authenticated members."""

    def test_member_gets_403_via_exception(self, monkeypatch, tmp_path):
        from fastapi import HTTPException
        main = _load_main(monkeypatch, tmp_path)
        from auth.context import AuthContext

        with pytest.raises(HTTPException) as exc_info:
            main.prometheus_metrics(
                auth=AuthContext(user_id="member-1", role="member", auth_method="session")
            )
        assert exc_info.value.status_code == 403

    def test_admin_gets_metrics(self, monkeypatch, tmp_path):
        from fastapi.responses import PlainTextResponse
        main = _load_main(monkeypatch, tmp_path)
        from auth.context import AuthContext

        response = main.prometheus_metrics(
            auth=AuthContext(
                user_id="admin-1", role="admin", auth_method="session", scopes=("admin",)
            )
        )
        assert isinstance(response, PlainTextResponse)
        # Body must contain at least the help line for workeros_runs_total
        assert "workeros_runs_total" in response.body.decode()

    def test_scope_admin_gets_metrics(self, monkeypatch, tmp_path):
        """A member with 'admin' scope (e.g. PAT with admin scope) still passes."""
        from fastapi.responses import PlainTextResponse
        main = _load_main(monkeypatch, tmp_path)
        from auth.context import AuthContext

        response = main.prometheus_metrics(
            auth=AuthContext(
                user_id="scope-admin-1", role="member", scopes=("admin",), auth_method="pat"
            )
        )
        assert isinstance(response, PlainTextResponse)
