"""Review-pack public route security and direct-run wiring tests."""

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


def _pack(pack_id: str) -> dict:
    return {
        "schema_version": "1.0",
        "id": pack_id,
        "client": {"slug": "demo-client-gmbh", "name": "Demo Client GmbH"},
        "meta": {
            "title": "t",
            "published_at": "2026-06-22T00:00:00Z",
            "expires_at": "2030-01-01T00:00:00Z",
            "locale": "de-DE",
        },
        "reviewers_suggested": [
            {"name": "Vera", "role": "Recruiting"},
            {"name": "Hendrik", "role": "Founder"},
        ],
        "jobs": [
            {
                "id": "software-engineer",
                "title": "SWE",
                "location": "DE",
                "department": "Tech",
                "must_haves": ["python"],
                "internal_notes": "never public",
                "candidates": [
                    {
                        "id": "c_lisa-01",
                        "rank": 1,
                        "name": "Lisa",
                        "title": "Eng",
                        "company": "Co",
                        "location": "DE",
                        "score": 90,
                        "why": "Gute Erfahrung für München",
                        "strengths": ["Python"],
                        "concerns": ["Notice period"],
                        "linkedin": "https://linkedin.com/in/lisa",
                        "raw_model_reasoning": "never public",
                    }
                ],
            }
        ],
        "integrity": {"password_plain": "secret123", "internal_score_cost": 12.34},
    }


def _write_pack(client: TestClient, context_name: str, pack_id: str, pack: dict) -> None:
    rel = f"review-packs/{pack_id}/pack.json"
    created = client.post(f"/contexts/{context_name}", json={"writeable": True}, headers=_secret_headers())
    assert created.status_code == 200, created.text
    encoded_rel = "/".join(quote(part) for part in rel.split("/"))
    put = client.put(
        f"/contexts/{context_name}/files/{encoded_rel}",
        json={"content": json.dumps(pack, ensure_ascii=False, indent=2)},
        headers=_secret_headers(),
    )
    assert put.status_code == 200, put.text


def _mint(client: TestClient, context_name: str, pack_id: str) -> tuple[str, str]:
    mint = client.post(
        f"/contexts/{context_name}/review-packs/{pack_id}/share-link",
        headers=_secret_headers(),
    )
    assert mint.status_code == 200, mint.text
    body = mint.json()
    return body["token"], body["reviewer_links"][0]["token"]


def test_review_pack_public_vote_roundtrip_is_bound_to_reviewer_token(monkeypatch, tmp_path):
    main, contexts_dir = _load_api(monkeypatch, tmp_path)
    pack_id = "rp_demo_client_2026-06-22"
    context_name = "review_pack-demo-client"

    with TestClient(main.app) as client:
        _write_pack(client, context_name, pack_id, _pack(pack_id))
        token, reviewer_token = _mint(client, context_name, pack_id)

        bad = client.get(f"/review/public/{token}?password=wrong")
        assert bad.status_code == 401

        ok = client.get(
            f"/review/public/{token}",
            headers={
                "x-review-pack-password": "secret123",
                "x-review-pack-reviewer-token": reviewer_token,
            },
        )
        assert ok.status_code == 200, ok.text
        body = ok.json()
        public_json = json.dumps(body, ensure_ascii=False)
        assert "integrity" not in public_json
        assert "internal_score_cost" not in public_json
        assert "internal_notes" not in public_json
        assert "raw_model_reasoning" not in public_json
        assert body["pack"]["jobs"][0]["candidates"][0]["why"] == "Gute Erfahrung für München"
        assert body["reviewer"]["name"] == "Vera"

        forged_identity_vote = client.post(
            f"/review/public/{token}/feedback",
            headers={"x-review-pack-reviewer-token": reviewer_token},
            json={
                "password": "secret123",
                "job_id": "software-engineer",
                "candidate_id": "c_lisa-01",
                "reviewer_key": "hendrik",
                "reviewer_name": "Hendrik",
                "reviewer_role": "CEO",
                "verdict": "interested",
            },
        )
        assert forged_identity_vote.status_code == 200, forged_identity_vote.text
        vote = forged_identity_vote.json()["vote"]
        assert vote["reviewer_key"] == "vera"
        assert vote["reviewer_name"] == "Vera"
        assert forged_identity_vote.json()["consensus"][0]["counts"]["interested"] == 1

        missing_reviewer = client.post(
            f"/review/public/{token}/feedback",
            json={
                "password": "secret123",
                "job_id": "software-engineer",
                "candidate_id": "c_lisa-01",
                "verdict": "pass",
            },
        )
        assert missing_reviewer.status_code == 422

    feedback_files = list((contexts_dir / context_name / "feedback" / "review" / pack_id).glob("*.json"))
    assert len(feedback_files) == 1


def test_review_pack_can_materialize_directly_from_run_output_utf8(monkeypatch, tmp_path):
    main, _contexts_dir = _load_api(monkeypatch, tmp_path)
    context_name = "review_pack-demo-client"
    pack_id = "rp_demo_client_2026-06-22"
    source_run_id = "run_review_pack"
    pack = _pack(pack_id)
    pack["jobs"][0]["candidates"][0]["why"] = "Führungserfahrung für München"

    with TestClient(main.app) as client:
        created = client.post(f"/contexts/{context_name}", json={"writeable": True}, headers=_secret_headers())
        assert created.status_code == 200, created.text

        from db import get_repos

        repos = get_repos()
        repos.workers.create(
            user_id="review-pack-user",
            worker_id="review-pack-worker",
            name="Review Pack Worker",
            manifest_json={"name": "review-pack-worker", "version": "0.1.0"},
            runner="e2b",
        )
        repos.runs.create(
            user_id="review-pack-user",
            run_id=source_run_id,
            worker_id="review-pack-worker",
            status="completed",
            trigger_source="manual",
            runner="e2b",
            input_json={},
            output_json={"review_pack": pack},
        )

        materialized = client.post(
            f"/contexts/{context_name}/review-packs/{pack_id}/from-run",
            json={"run_id": source_run_id},
            headers=_secret_headers(),
        )
        assert materialized.status_code == 200, materialized.text

        token, reviewer_token = _mint(client, context_name, pack_id)
        public = client.get(
            f"/review/public/{token}",
            headers={
                "x-review-pack-password": "secret123",
                "x-review-pack-reviewer-token": reviewer_token,
            },
        )
        assert public.status_code == 200, public.text
        assert public.json()["pack"]["jobs"][0]["candidates"][0]["why"] == "Führungserfahrung für München"
