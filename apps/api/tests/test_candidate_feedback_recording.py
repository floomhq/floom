from __future__ import annotations

import concurrent.futures
import importlib
import json
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1]
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", "test-api-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "candidate-feedback-user")
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKSPACE_AGENT_MCP_TOKEN", "test-mcp-token")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)

    sys.path.insert(0, str(api_dir))
    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "worker_registry", "runner_utils",
            "run_service", "chat_service", "auth", "contexts", "git_ops",
        ]):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main"), contexts_dir


def _secret_headers():
    return {"x-floom-secret": "test-api-secret"}


def _mcp_headers():
    return {
        "Authorization": "Bearer test-mcp-token",
        "Content-Type": "application/json",
    }


def _rpc(method, request_id=1, params=None):
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    return payload


def test_concurrent_record_candidate_feedback_calls_create_distinct_files(monkeypatch, tmp_path):
    main, contexts_dir = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        created = client.post("/contexts/review_pack-data", json={"writeable": True}, headers=_secret_headers())
        assert created.status_code == 200, created.text

        payloads = [
            {
                "run_id": "run-a",
                "candidate_id": "candidate-1",
                "rank": 1,
                "feedback_text": "Good result.",
                "outcome": "good",
                "scope": "global",
                "reporter": "emily",
            },
            {
                "run_id": "run-b",
                "candidate_id": "candidate-2",
                "rank": 2,
                "feedback_text": "Missed the target.",
                "outcome": "miss",
                "scope": "client",
                "reporter": "emily",
            },
        ]

        def _post(payload):
            return client.post(
                "/contexts/review_pack-data/record-candidate-feedback",
                json=payload,
                headers=_secret_headers(),
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(_post, payloads))

    for response in responses:
        assert response.status_code == 201, response.text
    records = [response.json() for response in responses]
    paths = {record["path"] for record in records}
    assert len(paths) == 2
    assert all(path.startswith("feedback/raw/") and path.endswith(".json") for path in paths)

    files = sorted((contexts_dir / "review_pack-data" / "feedback" / "raw").glob("*/*.json"))
    assert len(files) == 2
    stored = [json.loads(path.read_text()) for path in files]
    assert {item["uuid"] for item in stored} == {record["uuid"] for record in records}
    assert {item["feedback_text"] for item in stored} == {"Good result.", "Missed the target."}
    assert {item["outcome"] for item in stored} == {"good", "miss"}


def test_mcp_record_candidate_feedback_writes_event_file(monkeypatch, tmp_path):
    main, contexts_dir = _load_api(monkeypatch, tmp_path)
    with TestClient(main.app) as client:
        created = client.post("/contexts/review_pack-data", json={"writeable": True}, headers=_secret_headers())
        response = client.post(
            "/api/mcp",
            data=json.dumps(
                _rpc(
                    "tools/call",
                    params={
                        "name": "record_candidate_feedback",
                        "arguments": {
                            "name": "review_pack-data",
                            "run_id": "run-mcp",
                            "candidate_id": "candidate-mcp",
                            "rank": 3,
                            "feedback_text": "Bad candidate.",
                            "outcome": "bad",
                            "scope": "global",
                            "reporter": "mcp-client",
                        },
                    },
                )
            ),
            headers=_mcp_headers(),
        )

    assert created.status_code == 200, created.text
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["isError"] is False
    record = result["structuredContent"]
    assert record["path"].startswith("feedback/raw/")
    stored_path = contexts_dir / "review_pack-data" / record["path"]
    stored = json.loads(stored_path.read_text())
    assert stored["uuid"] == record["uuid"]
    assert stored["run_id"] == "run-mcp"
    assert stored["candidate_id"] == "candidate-mcp"
    assert stored["outcome"] == "bad"
