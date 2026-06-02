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
            {
                "id": "art_3",
                "run_id": "run_1",
                "name": "brief.pdf",
                "type": "application/pdf",
                "path": "run_1/out/brief.pdf",
                "relative_path": "run_1/out/brief.pdf",
                "size_bytes": 28,
                "created_at": "2026-06-01T10:00:02Z",
            },
            {
                "id": "art_4",
                "run_id": "run_1",
                "name": "metrics.xlsx",
                "type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "path": "run_1/out/metrics.xlsx",
                "relative_path": "run_1/out/metrics.xlsx",
                "size_bytes": 22,
                "created_at": "2026-06-01T10:00:03Z",
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
    artifact_ids = [artifact["id"] for artifact in response["artifacts"]]
    assert artifact_ids == ["art_1", "art_3", "art_4"]
    assert "art_2" not in artifact_ids


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


def test_public_approval_artifact_download_serves_pdf_and_xlsx(monkeypatch, tmp_path):
    artifact_root = tmp_path / "artifacts"
    pdf_path = artifact_root / "run_1" / "out" / "brief.pdf"
    xlsx_path = artifact_root / "run_1" / "out" / "metrics.xlsx"
    pdf_path.parent.mkdir(parents=True)
    pdf_bytes = b"%PDF-1.4\n% test pdf\n"
    xlsx_bytes = b"PK\x03\x04test workbook bytes"
    pdf_path.write_bytes(pdf_bytes)
    xlsx_path.write_bytes(xlsx_bytes)
    _set_artifacts_dir(monkeypatch, artifact_root)
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    token = main._approval_public_token(_ApprovalsRepo().get_public(approval_id="apr_1"))

    try:
        client = TestClient(main.app)
        pdf_response = client.get(
            f"/approvals/public/apr_1/artifacts/art_3/download?token={token}"
        )
        xlsx_response = client.get(
            f"/approvals/public/apr_1/artifacts/art_4/download?token={token}"
        )
    finally:
        main.app.dependency_overrides.clear()

    assert pdf_response.status_code == 200
    assert pdf_response.headers["content-type"].startswith("application/pdf")
    assert "brief.pdf" in pdf_response.headers["content-disposition"]
    assert pdf_response.content == pdf_bytes
    assert xlsx_response.status_code == 200
    assert xlsx_response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert "metrics.xlsx" in xlsx_response.headers["content-disposition"]
    assert xlsx_response.content == xlsx_bytes


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
