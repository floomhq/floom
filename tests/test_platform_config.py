"""Tests for GET /system/platform-config with the new structured spec response.

Run with:
    cd apps/api && python3 -m pytest ../../tests/test_platform_config.py -x -q
"""

import os
import sys
import tempfile

import pytest

# Point to the API source before importing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

# Use a temp DB, clear optional vars for clean test state
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_RUN_TIMEOUT", None)  # ensure absent for the optional test

import db  # noqa: E402
db.DB_PATH = _tmp_db.name

import main as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Capture whatever secret load_dotenv loaded so we can pass it in headers.
# If FLOOM_SECRET is not set (dev mode), headers will be empty and auth passes anyway.
_SECRET = os.environ.get("FLOOM_SECRET", "")
_AUTH_HEADERS = {"x-floom-secret": _SECRET} if _SECRET else {}

client = TestClient(app_module.app, raise_server_exceptions=True)


def get_platform_config():
    resp = client.get("/system/platform-config", headers=_AUTH_HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert "platform_secrets" in data
    return {item["name"]: item for item in data["platform_secrets"]}


def get_infra_paths():
    resp = client.get("/system/platform-config", headers=_AUTH_HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert "infra_paths" in data, "Response missing 'infra_paths' key"
    return {item["name"]: item for item in data["infra_paths"]}


class TestPlatformConfigShape:
    """Verify the response contains the new required/default/description fields."""

    def test_response_has_platform_secrets_list(self):
        resp = client.get("/system/platform-config", headers=_AUTH_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data["platform_secrets"], list)
        assert len(data["platform_secrets"]) > 0

    def test_response_has_infra_paths_list(self):
        resp = client.get("/system/platform-config", headers=_AUTH_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data["infra_paths"], list)
        assert len(data["infra_paths"]) > 0

    def test_each_item_has_required_fields(self):
        resp = client.get("/system/platform-config", headers=_AUTH_HEADERS)
        data = resp.json()
        all_items = data["platform_secrets"] + data["infra_paths"]
        for item in all_items:
            assert "name" in item, f"Missing 'name' in {item}"
            assert "status" in item, f"Missing 'status' in {item}"
            assert "required" in item, f"Missing 'required' in {item}"
            assert "default" in item, f"Missing 'default' key in {item}"
            assert "description" in item, f"Missing 'description' in {item}"

    def test_required_field_is_bool(self):
        resp = client.get("/system/platform-config", headers=_AUTH_HEADERS)
        data = resp.json()
        all_items = data["platform_secrets"] + data["infra_paths"]
        for item in all_items:
            assert isinstance(item["required"], bool), (
                f"{item['name']}.required should be bool, got {type(item['required'])}"
            )

    def test_infra_vars_not_in_platform_secrets(self):
        """FLOOM_DB etc. must live in infra_paths, not in platform_secrets."""
        infra_names = {"FLOOM_DB", "FLOOM_WORKERS_DIR", "FLOOM_ARTIFACTS_DIR", "FLOOM_RUN_TIMEOUT"}
        secrets = get_platform_config()
        overlap = infra_names & set(secrets.keys())
        assert not overlap, f"Infra vars found in platform_secrets: {overlap}"

    def test_infra_vars_in_infra_paths(self):
        """FLOOM_DB etc. must appear in the infra_paths section."""
        infra = get_infra_paths()
        for name in ("FLOOM_DB", "FLOOM_WORKERS_DIR", "FLOOM_ARTIFACTS_DIR", "FLOOM_RUN_TIMEOUT"):
            assert name in infra, f"{name} missing from infra_paths"


class TestOpenAiApiKeyRequired:
    """OPENAI_API_KEY is required and must appear in platform_secrets."""

    def test_openai_api_key_in_platform_secrets(self):
        secrets = get_platform_config()
        assert "OPENAI_API_KEY" in secrets, "OPENAI_API_KEY not found in platform_secrets"

    def test_openai_api_key_is_required(self):
        secrets = get_platform_config()
        spec = secrets["OPENAI_API_KEY"]
        assert spec["required"] is True, "OPENAI_API_KEY should be required=True"

    def test_openai_api_key_shows_set_when_env_present(self):
        os.environ["OPENAI_API_KEY"] = "sk-test-key"
        try:
            secrets = get_platform_config()
            spec = secrets["OPENAI_API_KEY"]
            assert spec["status"] == "set", f"Expected 'set', got {spec['status']!r}"
        finally:
            os.environ.pop("OPENAI_API_KEY", None)

    def test_openai_api_key_shows_missing_when_absent(self):
        saved = os.environ.pop("OPENAI_API_KEY", None)
        try:
            secrets = get_platform_config()
            spec = secrets["OPENAI_API_KEY"]
            assert spec["status"] == "missing"
        finally:
            if saved is not None:
                os.environ["OPENAI_API_KEY"] = saved


class TestFloomRunTimeoutOptional:
    """FLOOM_RUN_TIMEOUT is optional with default '300', now in infra_paths section."""

    def test_floom_run_timeout_in_infra_paths(self):
        infra = get_infra_paths()
        assert "FLOOM_RUN_TIMEOUT" in infra, "FLOOM_RUN_TIMEOUT not found in infra_paths"

    def test_floom_run_timeout_not_required(self):
        infra = get_infra_paths()
        spec = infra["FLOOM_RUN_TIMEOUT"]
        assert spec["required"] is False, "FLOOM_RUN_TIMEOUT should be optional"

    def test_floom_run_timeout_has_default_300(self):
        infra = get_infra_paths()
        spec = infra["FLOOM_RUN_TIMEOUT"]
        assert spec["default"] == "300", f"Expected default '300', got {spec['default']!r}"

    def test_floom_run_timeout_missing_without_env_var(self):
        """When env var is absent, status is 'missing' but required is False."""
        saved = os.environ.pop("FLOOM_RUN_TIMEOUT", None)
        try:
            infra = get_infra_paths()
            spec = infra["FLOOM_RUN_TIMEOUT"]
            assert spec["status"] == "missing"
            assert spec["required"] is False
            assert spec["default"] == "300"
        finally:
            if saved is not None:
                os.environ["FLOOM_RUN_TIMEOUT"] = saved


class TestComposioApiKeyRequired:
    """COMPOSIO_API_KEY is required; when set it shows status 'set' regardless of required flag."""

    def test_composio_api_key_is_required(self):
        secrets = get_platform_config()
        spec = secrets.get("COMPOSIO_API_KEY")
        assert spec is not None, "COMPOSIO_API_KEY not found"
        assert spec["required"] is True

    def test_composio_api_key_shows_set_when_env_present(self):
        os.environ["COMPOSIO_API_KEY"] = "test-key-value"
        try:
            secrets = get_platform_config()
            spec = secrets["COMPOSIO_API_KEY"]
            assert spec["status"] == "set", (
                f"Expected 'set', got {spec['status']!r}"
            )
        finally:
            os.environ.pop("COMPOSIO_API_KEY", None)

    def test_composio_api_key_shows_missing_when_absent(self):
        saved = os.environ.pop("COMPOSIO_API_KEY", None)
        try:
            secrets = get_platform_config()
            spec = secrets["COMPOSIO_API_KEY"]
            assert spec["status"] == "missing"
        finally:
            if saved is not None:
                os.environ["COMPOSIO_API_KEY"] = saved
