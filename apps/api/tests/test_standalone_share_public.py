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
    with tempfile.TemporaryDirectory(prefix="workeros-share-") as td:
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
    with tempfile.TemporaryDirectory(prefix="workeros-share-") as td:
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
    with tempfile.TemporaryDirectory(prefix="workeros-share-") as td:
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
