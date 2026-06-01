from __future__ import annotations

import os
import tempfile
import importlib
from pathlib import Path
from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-test-"))
os.environ["WORKEROS_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["FLOOM_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")

import main


def _set_artifacts_dir(monkeypatch, artifact_root: Path) -> None:
    runner_utils = importlib.import_module("runner_utils")
    monkeypatch.setattr(runner_utils, "ARTIFACTS_DIR", artifact_root)


class _RunsRepo:
    def list_artifacts(self, *, user_id: str, run_id: str):
        assert user_id == "user_1"
        assert run_id == "run_1"
        return [
            {
                "id": "art_1",
                "run_id": "run_1",
                "name": "report.csv",
                "type": "text/csv",
                "path": "run_1/out/report.csv",
                "relative_path": "run_1/out/report.csv",
                "size_bytes": 42,
                "created_at": "2026-06-01T10:00:00Z",
            },
            {
                "id": "art_2",
                "run_id": "run_1",
                "name": "transcript.jsonl",
                "type": "application/jsonl",
                "path": "run_1/transcript.jsonl",
                "size_bytes": 100,
                "created_at": "2026-06-01T10:00:01Z",
            },
        ]


class _ApprovalsRepo:
    def get_public(self, *, approval_id: str):
        if approval_id != "apr_1":
            return None
        return {
            "id": "apr_1",
            "run_id": "run_1",
            "owner_id": "user_1",
            "worker_id": "worker_1",
            "status": "pending",
        }


class _Repos:
    approvals = _ApprovalsRepo()
    runs = _RunsRepo()


def test_public_approval_response_includes_safe_artifact_metadata_without_owner():
    response = main._public_approval_response(
        {
            "id": "apr_1",
            "run_id": "run_1",
            "owner_id": "user_1",
            "worker_id": "worker_1",
            "status": "pending",
        },
        _Repos(),
    )

    assert "owner_id" not in response
    assert response["artifacts"] == [
        {
            "id": "art_1",
            "run_id": "run_1",
            "name": "report.csv",
            "type": "text/csv",
            "path": "run_1/out/report.csv",
            "relative_path": "run_1/out/report.csv",
            "size_bytes": 42,
            "created_at": "2026-06-01T10:00:00Z",
        }
    ]


def test_public_approval_artifact_download_uses_signed_link(monkeypatch, tmp_path):
    artifact_root = tmp_path / "artifacts"
    artifact_path = artifact_root / "run_1" / "out" / "report.csv"
    artifact_path.parent.mkdir(parents=True)
    artifact_path.write_text("name,value\nFloom,1\n")
    _set_artifacts_dir(monkeypatch, artifact_root)
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    token = main._approval_public_token(_ApprovalsRepo().get_public(approval_id="apr_1"))

    try:
        client = TestClient(main.app)
        response = client.get(
            f"/approvals/public/apr_1/artifacts/art_1/download?token={token}"
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "report.csv" in response.headers["content-disposition"]
    assert response.text == "name,value\nFloom,1\n"


def test_public_approval_artifact_download_hides_sensitive_artifacts(monkeypatch, tmp_path):
    artifact_root = tmp_path / "artifacts"
    transcript_path = artifact_root / "run_1" / "transcript.jsonl"
    transcript_path.parent.mkdir(parents=True)
    transcript_path.write_text('{"secret":true}\n')
    _set_artifacts_dir(monkeypatch, artifact_root)
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    token = main._approval_public_token(_ApprovalsRepo().get_public(approval_id="apr_1"))

    try:
        client = TestClient(main.app)
        response = client.get(
            f"/approvals/public/apr_1/artifacts/art_2/download?token={token}"
        )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 404
