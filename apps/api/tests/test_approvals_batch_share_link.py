from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path


_ROOT = Path(__file__).resolve().parents[3]


_SCENARIO = r"""
from __future__ import annotations

import importlib
from typing import Any

from fastapi.testclient import TestClient

cloud_main = importlib.import_module("apps.api.main")

VALID_TOKEN = "fls_batchtoken123"
INVALID_TOKEN = "badbatch123"
WORKSPACE_ID = "ws_batch"
OWNER_ID = "owner_batch"
APPROVAL_ID = "apr_batch_1"

APPROVAL = {
    "id": APPROVAL_ID,
    "run_id": "run_batch_1",
    "owner_id": OWNER_ID,
    "workspace_id": WORKSPACE_ID,
    "worker_id": "worker_batch_1",
    "worker_name": "Video Publisher",
    "status": "pending",
    "label": "Approve video",
    "preview": "ready",
    "preview_payload": {
        "kind": "video",
        "url": "https://cdn.example.test/video.mp4",
        "access_token": "nested-preview-token",
    },
    "decision_input_json": "{}",
    "edited_output_json": "{}",
    "follow_up_run_id": "run_followup",
    "created_at": "2026-06-24T08:00:00Z",
}


def walk_keys(value: Any) -> list[str]:
    keys: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            keys.append(str(key))
            keys.extend(walk_keys(item))
    elif isinstance(value, list):
        for item in value:
            keys.extend(walk_keys(item))
    return keys


calls: list[dict[str, Any]] = []


class ApprovalsRepo:
    def list_pending_for_workspace(self, *, workspace_id: str, owner_id: str, limit: int = 200):
        if workspace_id == WORKSPACE_ID and owner_id == OWNER_ID:
            return [dict(APPROVAL)]
        return []

    def get_public(self, *, approval_id: str):
        return dict(APPROVAL) if approval_id == APPROVAL_ID else None


class WorkersRepo:
    def get_any(self, *, worker_id: str):
        return {"id": worker_id, "workspace_id": WORKSPACE_ID}


class RunsRepo:
    def list_artifacts(self, *, user_id: str, run_id: str):
        return []


class ShareLinksRepo:
    def resolve_approvals_batch_share(self, *, token_hash: str, now_iso_str: str):
        if token_hash == cloud_main._engine_share_links._hash_share_token(VALID_TOKEN):
            return {
                "entity_type": "approvals_batch",
                "entity_id": WORKSPACE_ID,
                "owner_id": OWNER_ID,
                "token_hash": token_hash,
                "revoked_at": None,
                "expires_at": "2999-01-01T00:00:00+00:00",
            }
        return None


class Repos:
    approvals = ApprovalsRepo()
    workers = WorkersRepo()
    runs = RunsRepo()
    share_links = ShareLinksRepo()


def load_share(token: str):
    if token == VALID_TOKEN:
        return {
            "entity_type": "approvals_batch",
            "entity_id": WORKSPACE_ID,
            "owner_id": OWNER_ID,
        }
    return None


def public_projection(approval: dict[str, Any], repos: Any):
    return {
        "id": approval["id"],
        "run_id": approval["run_id"],
        "worker_id": approval["worker_id"],
        "worker_name": approval["worker_name"],
        "workspace_id": approval["workspace_id"],
        "status": approval["status"],
        "label": approval["label"],
        "preview": approval["preview"],
        "preview_payload": dict(approval["preview_payload"]),
        "decision_input_json": approval["decision_input_json"],
        "edited_output_json": approval["edited_output_json"],
        "follow_up_run_id": approval["follow_up_run_id"],
    }


def token_for_approval(approval: dict[str, Any]) -> str:
    return f"per-approval-token-for-{approval['id']}"


def dispatch_decision(approval_id: str, approval: dict[str, Any], *, decision: str, body: dict[str, Any], repos: Any):
    calls.append(
        {
            "approval_id": approval_id,
            "owner_id": approval["owner_id"],
            "workspace_id": approval["workspace_id"],
            "decision": decision,
        }
    )
    return {"status": decision, "run_id": approval["run_id"]}


cloud_main._engine_share_links._load_standalone_share_row = load_share
cloud_main._engine_approvals._public_approval_response = public_projection
cloud_main._engine_approvals.try_approval_public_token = token_for_approval
cloud_main._engine_approvals._is_row_past_expiry = lambda row: False
cloud_main._dispatch_public_approval_decision = dispatch_decision
cloud_main.app.dependency_overrides[cloud_main._engine_db.get_repos] = lambda: Repos()
cloud_main._PUBLIC_BATCH_RATE_BUCKETS.clear()

client = TestClient(cloud_main.app)
public_batch = client.get(f"/approvals/public-batch/{VALID_TOKEN}")
short_share = client.get(f"/s/{VALID_TOKEN}")

for response in (public_batch, short_share):
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["entity_type"] == "approvals_batch"
    assert len(body["approvals"]) == 1
    approval = body["approvals"][0]
    assert approval["id"] == APPROVAL_ID
    item_keys = {key.lower() for key in walk_keys(approval)}
    assert "action_token" not in item_keys
    assert "approval_token" not in item_keys
    assert "public_token" not in item_keys
    assert "bearer" not in item_keys
    assert "authorization" not in item_keys
    assert "owner_id" not in item_keys
    assert "workspace_id" not in item_keys
    assert "decision_input_json" not in item_keys
    assert "edited_output_json" not in item_keys
    assert "follow_up_run_id" not in item_keys
    assert "access_token" not in item_keys
    assert "per-approval-token" not in response.text

decision = client.post(
    f"/approvals/public-batch/{VALID_TOKEN}/items/{APPROVAL_ID}/decision",
    json={"decision": "approved", "reason": "looks good"},
)
assert decision.status_code == 200, decision.text
assert calls == [
    {
        "approval_id": APPROVAL_ID,
        "owner_id": OWNER_ID,
        "workspace_id": WORKSPACE_ID,
        "decision": "approved",
    }
]

rejected = client.post(
    f"/approvals/public-batch/{INVALID_TOKEN}/items/{APPROVAL_ID}/decision",
    json={"decision": "approved"},
)
assert rejected.status_code == 404
assert len(calls) == 1
print("batch public response uses only batch token")
"""


def test_public_batch_response_uses_only_batch_token_and_decision_route():
    with tempfile.TemporaryDirectory(prefix="workeros-cloud-batch-share-test-") as td:
        tmp = Path(td)
        env = os.environ.copy()
        env.update(
            {
                "WORKEROS_DB": str(tmp / "workeros.db"),
                "FLOOM_DB": str(tmp / "workeros.db"),
                "WORKEROS_API_ENV_FILE": str(tmp / "api.env"),
                "FLOOM_SECRET": "test-secret-batch-share",
                "WORKEROS_SUPABASE_URL": "https://example.supabase.co",
                "SUPABASE_URL": "https://example.supabase.co",
                "WORKEROS_SUPABASE_SERVICE_KEY": "test-service-key",
                "SUPABASE_SERVICE_ROLE_KEY": "test-service-key",
            }
        )
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(_SCENARIO)],
            cwd=_ROOT,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
            check=False,
        )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "batch public response uses only batch token" in result.stdout
