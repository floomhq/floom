from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-test-"))
os.environ["WORKEROS_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["FLOOM_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")

import main


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


class _Repos:
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
