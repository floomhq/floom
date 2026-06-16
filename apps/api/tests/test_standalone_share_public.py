from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient


def _boot(tmp_path: Path):
    os.environ["WORKEROS_DB"] = str(tmp_path / "workeros.db")
    os.environ["FLOOM_DB"] = str(tmp_path / "workeros.db")
    os.environ["FLOOM_CONTEXTS_DIR"] = str(tmp_path / "contexts")
    os.environ["WORKEROS_DEPLOY"] = "local"
    os.environ["WORKEROS_USER_ID"] = "federico"
    os.environ["FLOOM_SECRET"] = "standalone-share-test-secret"
    import contexts
    import db
    import main

    importlib.reload(contexts)
    importlib.reload(db)
    # Purge router modules so reloading main rebuilds their handlers against the
    # freshly-reloaded db (routers hold Depends(get_repos) directly; without this
    # they'd keep a stale get_repos and 404 on the test's worker rows).
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(_rn, None)
    importlib.reload(main)
    return main, TestClient(main.app)


def _headers() -> dict[str, str]:
    return {"x-floom-secret": "standalone-share-test-secret"}


def test_brain_file_share_returns_noindex_content_and_download():
    with tempfile.TemporaryDirectory(prefix="workeros-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        created = client.post("/contexts/research", headers=_headers(), json={"writeable": True})
        assert created.status_code == 200, created.text
        saved = client.put(
            "/contexts/research/files/brief.md",
            headers=_headers(),
            json={"content": "# Brief\nUseful notes.\n"},
        )
        assert saved.status_code == 200, saved.text

        link = client.post("/contexts/research/files/brief.md/share-link", headers=_headers())
        assert link.status_code == 200, link.text
        token = link.json()["token"]
        assert link.json()["url"].endswith(f"/s/{token}")

        public = client.get(f"/s/{token}")
        assert public.status_code == 200, public.text
        assert public.headers["x-robots-tag"] == "noindex, nofollow"
        body = public.json()
        assert body["entity_type"] == "brain_file"
        assert body["file"]["content_text"] == "# Brief\nUseful notes.\n"
        assert "owner_id" not in public.text

        download = client.get(f"/s/{token}/download")
        assert download.status_code == 200, download.text
        assert download.headers["x-robots-tag"] == "noindex, nofollow"
        assert download.content == b"# Brief\nUseful notes.\n"


def test_brain_pack_share_blocks_detected_secret_values():
    with tempfile.TemporaryDirectory(prefix="workeros-share-", ignore_cleanup_errors=True) as td:
        _main, client = _boot(Path(td))
        assert client.post("/contexts/unsafe", headers=_headers(), json={"writeable": True}).status_code == 200
        saved = client.put(
            "/contexts/unsafe/files/.env",
            headers=_headers(),
            json={"content": "OPENAI_API_KEY=sk-" + "a" * 48},
        )
        assert saved.status_code == 200, saved.text

        link = client.post("/contexts/unsafe/share-link", headers=_headers())
        assert link.status_code == 409
        assert "sk-" not in link.text


def test_worker_standalone_share_wraps_public_worker_projection():
    with tempfile.TemporaryDirectory(prefix="workeros-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        worker = {
            "id": "share-worker",
            "owner_id": "federico",
            "name": "Share Worker",
            "description": "Does useful work.",
            "example_output": "A tidy result",
            "trigger_type": "manual",
            "runner": "e2b",
            "config": {
                "id": "share-worker",
                "name": "Share Worker",
                "trigger": {"type": "manual"},
                "runtime": {"type": "skill", "entrypoint": "SKILL.md"},
                "connections": ["gmail"],
                "inputs": [],
                "outputs": [],
                "secrets": ["OPENAI_API_KEY"],
            },
        }

        class WorkersRepo:
            def get(self, *, user_id: str, worker_id: str):
                return worker if worker_id == "share-worker" else None

            def get_any(self, *, worker_id: str):
                return worker if worker_id == "share-worker" else None

            def list(self, user_id: str):
                return [worker]

        class RunsRepo:
            def list_for_worker(self, **kwargs):
                return []

        class Repos:
            workers = WorkersRepo()
            runs = RunsRepo()

        main.app.dependency_overrides[main.get_repos] = lambda: Repos()
        try:
            link = client.post("/workers/share-worker/share-link", headers=_headers())
            assert link.status_code == 200, link.text
            token = link.json()["token"]
            public = client.get(f"/s/{token}")
        finally:
            main.app.dependency_overrides.clear()

        assert public.status_code == 200, public.text
        assert public.headers["x-robots-tag"] == "noindex, nofollow"
        body = public.json()
        assert body["entity_type"] == "worker"
        assert body["worker"]["name"] == "Share Worker"
        assert body["worker"]["connections"] == ["gmail"]
        assert "OPENAI_API_KEY" not in public.text
        assert "owner_id" not in public.text


def test_worker_share_run_meta_and_public_run_are_scoped(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="workeros-share-run-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        worker = {
            "id": "share-worker",
            "owner_id": "federico",
            "name": "Share Worker",
            "description": "Public form worker.",
            "trigger_type": "manual",
            "runner": "e2b",
            "config": {
                "id": "share-worker",
                "name": "Share Worker",
                "trigger": {"type": "manual"},
                "runtime": {"type": "python", "entrypoint": "run.py"},
                "inputs": [{"name": "topic", "label": "Topic", "type": "string", "required": True}],
                "outputs": [{"name": "answer", "label": "Answer", "type": "markdown"}],
                "secrets": ["OPENAI_API_KEY"],
            },
        }

        class WorkersRepo:
            def get_any(self, *, worker_id: str):
                return worker if worker_id == "share-worker" else None

            def get(self, *, user_id: str, worker_id: str, role: str | None = None):
                return worker if user_id == "federico" and worker_id == "share-worker" else None

        class RunsRepo:
            pass

        class Repos:
            workers = WorkersRepo()
            runs = RunsRepo()

        captured = {}

        class Result:
            run_id = "run_public_1"

        def fake_create_worker_run(worker_id, payload, request, auth, repos):
            captured.update(
                {
                    "worker_id": worker_id,
                    "inputs": payload.inputs,
                    "trigger_source": payload.trigger_source,
                    "auth_user_id": auth.user_id,
                    "auth_method": auth.auth_method,
                }
            )
            return Result()

        monkeypatch.setattr(main, "create_worker_run", fake_create_worker_run)
        main.app.dependency_overrides[main.get_repos] = lambda: Repos()
        from services.share_links import _create_or_get_standalone_share_link

        token = _create_or_get_standalone_share_link(
            entity_type="worker",
            entity_id="share-worker",
            owner_id="federico",
        )["token"]
        try:
            meta = client.get(f"/workers/public/share-worker/run-meta?token={token}")
            assert meta.status_code == 200, meta.text
            assert meta.json()["inputs"][0]["name"] == "topic"
            assert meta.json()["outputs"][0]["name"] == "answer"
            assert "OPENAI_API_KEY" not in meta.text
            assert "owner_id" not in meta.text

            started = client.post(
                "/workers/public/share-worker/runs",
                json={"token": token, "inputs": {"topic": "pricing"}},
            )
            assert started.status_code == 200, started.text
            assert started.json() == {"run_id": "run_public_1"}
            assert captured == {
                "worker_id": "share-worker",
                "inputs": {"topic": "pricing"},
                "trigger_source": "public_share",
                "auth_user_id": "federico",
                "auth_method": "public_share",
            }

            assert client.get("/workers/public/other-worker/run-meta?token=" + token).status_code == 404
            assert client.post(
                "/workers/public/other-worker/runs",
                json={"token": token, "inputs": {}},
            ).status_code == 404
        finally:
            main.app.dependency_overrides.clear()
            import db

            db.get_repositories.cache_clear()


def test_worker_share_token_streams_only_same_worker_run(monkeypatch):
    with tempfile.TemporaryDirectory(prefix="workeros-share-stream-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        from services.share_links import _create_or_get_standalone_share_link

        token = _create_or_get_standalone_share_link(
            entity_type="worker",
            entity_id="share-worker",
            owner_id="federico",
        )["token"]
        other_token = _create_or_get_standalone_share_link(
            entity_type="worker",
            entity_id="other-worker",
            owner_id="federico",
        )["token"]
        run = {
            "id": "run_public_1",
            "worker_id": "share-worker",
            "actor_user_id": "federico",
            "status": "completed",
        }

        class RunsRepo:
            def get_any(self, *, run_id: str):
                return run if run_id == "run_public_1" else None

        class WorkersRepo:
            pass

        class Repos:
            runs = RunsRepo()
            workers = WorkersRepo()

        runs_router = sys.modules["routers.runs"]
        monkeypatch.setattr(
            runs_router,
            "_get_run_by_explicit_id",
            lambda run_id, *, user_id, repos: run
            if run_id == "run_public_1" and user_id == "federico"
            else None,
        )
        monkeypatch.setattr(runs_router, "_run_part_snapshot", lambda run_id: None)
        monkeypatch.setattr(
            runs_router,
            "_finish_part_from_run_row",
            lambda row: {"type": "finish", "finishReason": "stop"},
        )
        monkeypatch.setattr(runs_router, "_log_replay_parts", lambda repos, user_id, run_id: [])
        monkeypatch.setattr(runs_router, "_sse_stream_acquire", lambda user_id: user_id)
        monkeypatch.setattr(runs_router, "_sse_stream_release", lambda slot: None)
        main.app.dependency_overrides[main.get_repos] = lambda: Repos()
        try:
            streamed = client.get(f"/runs/run_public_1/stream?token={token}")
            assert streamed.status_code == 200, streamed.text
            assert "finishReason" in streamed.text

            wrong_worker = client.get(f"/runs/run_public_1/stream?token={other_token}")
            assert wrong_worker.status_code == 404
        finally:
            main.app.dependency_overrides.clear()
            import db

            db.get_repositories.cache_clear()
