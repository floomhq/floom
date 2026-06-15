"""Security quick wins batch: #1293 #1294 #1295 #1296.

Tests for four targeted security/correctness fixes:
  #1293  SSRF DNS-rebind: pin resolved IP at connection test dial time.
  #1294  MCP secrets.set accepts falsy non-None values (0, False, "0").
  #1295  MCP /mcp-tools/serve returns proper JSON-RPC errors + handles batch.
  #1296  cron_timezone validated at create/update time; invalid zone → 400.

Run: cd apps/api && python -m pytest tests/test_security_quickwins_1293_1296.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ===========================================================================
# #1293 — SSRF: pin_safe_outbound_url
# ===========================================================================

class TestSSRFPinning:
    """pin_safe_outbound_url resolves once, validates, returns a URL with the
    IP literal so callers connect directly to the pinned address."""

    def setup_method(self):
        from models import pin_safe_outbound_url, UnsafeOutboundUrlError
        self.pin = pin_safe_outbound_url
        self.exc = UnsafeOutboundUrlError

    def test_ip_literal_returns_same_url(self):
        # When the host is already an IP literal there is no DNS to rebind.
        orig, pinned = self.pin("http://1.2.3.4/api", label="Test")
        assert orig == "http://1.2.3.4/api"
        assert pinned == "http://1.2.3.4/api"

    def test_private_ip_literal_rejected(self):
        with pytest.raises(self.exc, match="internal"):
            self.pin("http://127.0.0.1/api")

    def test_hostname_pins_to_ip(self, monkeypatch):
        """When the host is a public-looking hostname that resolves to a safe
        IP, the returned pinned_url must contain the IP literal."""
        import ipaddress

        def _mock_resolve(host):
            return [ipaddress.ip_address("93.184.216.34")]  # example.com

        monkeypatch.setattr("models._resolve_host_ips", _mock_resolve)
        orig, pinned = self.pin("http://example.com/path?q=1")
        assert "93.184.216.34" in pinned
        assert "/path" in pinned
        assert "q=1" in pinned
        # Original URL should still contain the hostname.
        assert "example.com" in orig

    def test_dns_rebind_rejected(self, monkeypatch):
        """If the hostname resolves to a private IP (DNS rebind), reject."""
        import ipaddress

        def _mock_resolve(host):
            return [ipaddress.ip_address("192.168.1.1")]

        monkeypatch.setattr("models._resolve_host_ips", _mock_resolve)
        with pytest.raises(self.exc):
            self.pin("http://evil-rebind.com/api")

    def test_allow_private_urls_bypasses_check(self, monkeypatch):
        """WORKEROS_ALLOW_PRIVATE_MCP_URLS=1 makes pin return the original."""
        monkeypatch.setenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", "1")
        # Reimport to pick up env var (the function reads it each call).
        import importlib
        import models as _m
        importlib.reload(_m)
        orig, pinned = _m.pin_safe_outbound_url("http://localhost/api")
        assert orig == "http://localhost/api"
        assert pinned == "http://localhost/api"
        monkeypatch.delenv("WORKEROS_ALLOW_PRIVATE_MCP_URLS", raising=False)
        importlib.reload(_m)


# ===========================================================================
# #1294 — MCP secrets.set: falsy values must not be coerced to "required"
# ===========================================================================

class TestMcpArgStr:
    """_mcp_arg_str preserves falsy non-None values (0, False, "0")."""

    def test_zero_integer_accepted(self):
        from main import _mcp_arg_str
        assert _mcp_arg_str({"value": 0}, "value") == "0"

    def test_false_boolean_accepted(self):
        from main import _mcp_arg_str
        assert _mcp_arg_str({"value": False}, "value") == "False"

    def test_string_zero_accepted(self):
        from main import _mcp_arg_str
        assert _mcp_arg_str({"value": "0"}, "value") == "0"

    def test_none_raises_required(self):
        from main import _mcp_arg_str
        with pytest.raises(ValueError, match="required"):
            _mcp_arg_str({"value": None}, "value")

    def test_missing_raises_required(self):
        from main import _mcp_arg_str
        with pytest.raises(ValueError, match="required"):
            _mcp_arg_str({}, "value")

    def test_empty_string_raises_required(self):
        """An empty string is still meaningless as a secret value."""
        from main import _mcp_arg_str
        with pytest.raises(ValueError, match="required"):
            _mcp_arg_str({"value": ""}, "value")

    def test_positive_integer_accepted(self):
        from main import _mcp_arg_str
        assert _mcp_arg_str({"value": 42}, "value") == "42"


# ===========================================================================
# #1295 — MCP /mcp-tools/serve: JSON-RPC errors + batch support
# ===========================================================================

class TestMcpServeEndpoint:
    """The /mcp-tools/serve endpoint must return proper JSON-RPC error
    responses on invalid args and handle JSON-RPC batch arrays."""

    def _get_client(self, monkeypatch, tmp_path):
        import importlib, os

        workers_dir = tmp_path / "workers"
        workers_dir.mkdir()

        monkeypatch.setenv("WORKEROS_DEPLOY", "local")
        monkeypatch.setenv("FLOOM_SECRET", "sec-1295-test")
        monkeypatch.setenv("WORKEROS_USER_ID", "tester")
        monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
        monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
        monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

        for mod in [x for x in list(sys.modules) if x in ("main", "db", "models", "worker_registry", "run_service") or x.startswith("routers") or x.startswith("services")]:
            sys.modules.pop(mod, None)

        import db as _db
        _db.init_db()
        _db.get_repositories.cache_clear()

        import main as _main
        _main.invalidate_worker_cache()

        from fastapi.testclient import TestClient
        return TestClient(_main.app, headers={"x-floom-secret": "sec-1295-test"}, raise_server_exceptions=False), _main

    def test_invalid_body_returns_jsonrpc_error(self, monkeypatch, tmp_path):
        client, _ = self._get_client(monkeypatch, tmp_path)
        # Send a plain string instead of a JSON-RPC object.
        import json
        resp = client.post(
            "/mcp-tools/serve",
            content=json.dumps("not-a-dict"),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body
        assert body["error"]["code"] == -32600  # Invalid Request

    def test_batch_request_returns_array(self, monkeypatch, tmp_path):
        client, _ = self._get_client(monkeypatch, tmp_path)
        batch = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ]
        import json
        resp = client.post(
            "/mcp-tools/serve",
            content=json.dumps(batch),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list), f"expected array, got: {body}"
        assert len(body) == 2
        ids = {item.get("id") for item in body}
        assert ids == {1, 2}

    def test_batch_invalid_item_returns_error_entry(self, monkeypatch, tmp_path):
        client, _ = self._get_client(monkeypatch, tmp_path)
        batch = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            "not-a-dict",  # invalid item in batch
        ]
        import json
        resp = client.post(
            "/mcp-tools/serve",
            content=json.dumps(batch),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        # At least one response must be an error.
        errors = [item for item in body if "error" in item]
        assert len(errors) >= 1

    def test_single_request_still_works(self, monkeypatch, tmp_path):
        client, _ = self._get_client(monkeypatch, tmp_path)
        import json
        resp = client.post(
            "/mcp-tools/serve",
            content=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "result" in body


# ===========================================================================
# #1296 — cron timezone validated at create time
# ===========================================================================

class TestCronTimezoneValidation:
    """is_valid_timezone rejects garbage values; WorkerTrigger/WorkerContractTrigger
    raise a ValueError on invalid zones; the PATCH endpoint returns 400."""

    def test_is_valid_timezone_utc(self):
        from cron_utils import is_valid_timezone
        assert is_valid_timezone("UTC") is True

    def test_is_valid_timezone_common_zone(self):
        from cron_utils import is_valid_timezone
        assert is_valid_timezone("Europe/Berlin") is True

    def test_is_valid_timezone_garbage_rejected(self):
        from cron_utils import is_valid_timezone
        assert is_valid_timezone("Not/ATimezone") is False
        assert is_valid_timezone("foo") is False
        assert is_valid_timezone("") is False
        assert is_valid_timezone("  ") is False

    def test_worker_trigger_invalid_tz_raises(self):
        from models import WorkerTrigger
        with pytest.raises(Exception):
            WorkerTrigger(type="schedule", cron="0 9 * * 1", timezone="Not/ATimezone")

    def test_worker_trigger_valid_tz_accepted(self):
        from models import WorkerTrigger
        t = WorkerTrigger(type="schedule", cron="0 9 * * 1", timezone="UTC")
        assert t.timezone == "UTC"

    def test_worker_contract_trigger_invalid_tz_raises(self):
        from models import WorkerContractTrigger
        with pytest.raises(Exception):
            WorkerContractTrigger(type="schedule", cron="0 9 * * 1", timezone="Bad/Zone")

    def test_worker_contract_trigger_none_tz_ok(self):
        """None timezone is always valid (defaults to UTC downstream)."""
        from models import WorkerContractTrigger
        t = WorkerContractTrigger(type="schedule", cron="0 9 * * 1", timezone=None)
        assert t.timezone is None

    def _make_client(self, monkeypatch, tmp_path, worker_name, secret, user_id):
        """Helper: stand up an isolated server with a single schedule worker."""
        workers_dir = tmp_path / "workers"
        wdir = workers_dir / worker_name
        wdir.mkdir(parents=True)
        (wdir / "worker.yml").write_text(
            f'schema_version: "0.3"\nname: "{worker_name}"\ntitle: "TZ"\n'
            'description: "d"\nversion: "0.1.0"\ntrigger:\n  type: schedule\n'
            '  cron: "0 9 * * 1"\nexec:\n  entry: run.py\n  runtime: python311\n'
            '  runner: e2b\n  command: python run.py\nconnections: []\n'
        )
        (wdir / "run.py").write_text("print('ok')\n")

        monkeypatch.setenv("WORKEROS_DEPLOY", "local")
        monkeypatch.setenv("FLOOM_SECRET", secret)
        monkeypatch.setenv("WORKEROS_USER_ID", user_id)
        monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
        monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
        monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
        monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

        for mod in list(sys.modules):
            if mod in ("main", "db", "models", "worker_registry", "cron_utils") or \
               mod.startswith("routers") or mod.startswith("services") or \
               mod.startswith("db."):
                sys.modules.pop(mod, None)

        import db as _db
        _db.init_db()
        _db.get_repositories.cache_clear()
        import main as _main
        _main.invalidate_worker_cache()
        workers = _main.discover_workers()
        with _main.get_db() as conn:
            _main._persist_discovered_workers(conn, workers, user_id=user_id)

        from fastapi.testclient import TestClient
        return TestClient(_main.app, headers={"x-floom-secret": secret}, raise_server_exceptions=False)

    def test_patch_endpoint_returns_400_for_invalid_timezone(self, monkeypatch, tmp_path):
        """PATCH /workers/{id} with cron_timezone=garbage must return 400."""
        client = self._make_client(monkeypatch, tmp_path, "tz-worker", "sec-1296-a", "ownerA")
        resp = client.patch("/workers/tz-worker", json={"cron_timezone": "Not/ATimezone"})
        assert resp.status_code == 400, resp.text
        assert "timezone" in resp.text.lower()

    def test_patch_endpoint_accepts_valid_timezone(self, monkeypatch, tmp_path):
        """PATCH /workers/{id} with cron_timezone=UTC must succeed."""
        client = self._make_client(monkeypatch, tmp_path, "tz-worker2", "sec-1296-b", "ownerB")
        resp = client.patch("/workers/tz-worker2", json={"cron_timezone": "UTC"})
        assert resp.status_code == 200, resp.text
