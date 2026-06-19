"""Smoke tests for NovaSearch Review Pack public routes."""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from urllib.parse import quote

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
    monkeypatch.setenv("WORKEROS_USER_ID", "review-pack-user")
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


def test_review_pack_public_vote_roundtrip(monkeypatch, tmp_path):
    main, contexts_dir = _load_api(monkeypatch, tmp_path)
    pack_id = "rp_reltix_gmbh_2026-06-22"
    rel = f"review-packs/{pack_id}/pack.json"
    pack = {
        "schema_version": "1.0",
        "id": pack_id,
        "client": {"slug": "reltix-gmbh", "name": "reltix GmbH"},
        "meta": {
            "title": "t",
            "published_at": "2026-06-22T00:00:00Z",
            "expires_at": "2030-01-01T00:00:00Z",
            "locale": "de-DE",
        },
        "jobs": [
            {
                "id": "software-engineer",
                "title": "SWE",
                "location": "DE",
                "department": "Tech",
                "must_haves": ["python"],
                "candidates": [
                    {
                        "id": "c_lisa-01",
                        "rank": 1,
                        "name": "Lisa",
                        "title": "Eng",
                        "company": "Co",
                        "location": "DE",
                        "score": 90,
                        "why": "Good",
                    }
                ],
            }
        ],
        "integrity": {"password_plain": "secret123"},
    }

    with TestClient(main.app) as client:
        created = client.post("/contexts/novasearch-reltix", json={"writeable": True}, headers=_secret_headers())
        assert created.status_code == 200, created.text

        encoded_rel = "/".join(quote(part) for part in rel.split("/"))
        put = client.put(
            f"/contexts/novasearch-reltix/files/{encoded_rel}",
            json={"content": json.dumps(pack, indent=2)},
            headers=_secret_headers(),
        )
        assert put.status_code == 200, put.text

        mint = client.post(
            f"/contexts/novasearch-reltix/review-packs/{pack_id}/share-link",
            headers=_secret_headers(),
        )
        assert mint.status_code == 200, mint.text
        token = mint.json()["token"]

        bad = client.get(f"/review/public/{token}?password=wrong")
        assert bad.status_code == 401

        ok = client.get(f"/review/public/{token}?password=secret123")
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert "integrity" not in json.dumps(body)
        assert body["pack"]["id"] == pack_id

        vote = client.post(
            f"/review/public/{token}/feedback",
            json={
                "password": "secret123",
                "job_id": "software-engineer",
                "candidate_id": "c_lisa-01",
                "reviewer_key": "vera",
                "reviewer_name": "Vera",
                "reviewer_role": "Recruiting",
                "verdict": "interested",
            },
        )
        assert vote.status_code == 200, vote.text
        assert vote.json()["consensus"][0]["counts"]["interested"] == 1

    feedback_files = list((contexts_dir / "novasearch-reltix" / "feedback" / "review" / pack_id).glob("*.json"))
    assert len(feedback_files) == 1
