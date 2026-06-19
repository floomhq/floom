"""P1-8 (audit 2026-05-29): infrastructure env vars must NOT appear as
deletable user secrets.

FLOOM_DB / FLOOM_WORKERS_DIR / FLOOM_ARTIFACTS_DIR / FLOOM_CONTEXTS_DIR /
FLOOM_RUN_TIMEOUT are platform-managed infra config (surfaced in Settings,
never the operator Secrets list). Deleting FLOOM_DB from the UI could break
the running system, so the secrets API must:
  - exclude them from GET /secrets
  - refuse upsert / delete / test on them

Run:
    python3 -m pytest tests/test_p1_8_infra_vars_not_user_secrets.py -q
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
# local auth requires FLOOM_SECRET; set a known one (load_dotenv uses
# override=False, so this pre-set value wins over any api.env on the host).
_TEST_SECRET = "p1-8-test-secret"
os.environ["FLOOM_SECRET"] = _TEST_SECRET

import db  # noqa: E402

db.DB_PATH = _tmp_db.name

import main as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app, raise_server_exceptions=True)
HEADERS = {"x-floom-secret": _TEST_SECRET}

INFRA_VARS = [
    "FLOOM_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_CONTEXTS_DIR",
    "FLOOM_RUN_TIMEOUT",
]


def test_infra_vars_in_platform_secrets_denylist():
    for name in INFRA_VARS:
        assert name in app_module.PLATFORM_SECRETS, (
            f"{name} must be in PLATFORM_SECRETS so it is excluded from the "
            "user-facing secrets API"
        )


def test_infra_vars_absent_from_secrets_list():
    resp = client.get("/secrets", headers=HEADERS)
    assert resp.status_code == 200, resp.text
    names = {item["name"] for item in resp.json()}
    for name in INFRA_VARS:
        assert name not in names, f"{name} leaked into the user Secrets list"


def test_infra_vars_cannot_be_deleted():
    for name in INFRA_VARS:
        resp = client.delete(f"/secrets/{name}", headers=HEADERS)
        assert resp.status_code == 400, (
            f"DELETE /secrets/{name} should be refused, got {resp.status_code}"
        )


def test_infra_vars_cannot_be_upserted():
    for name in INFRA_VARS:
        resp = client.post(f"/secrets/{name}", json={"value": "x"}, headers=HEADERS)
        assert resp.status_code == 400, (
            f"POST /secrets/{name} should be refused, got {resp.status_code}"
        )
