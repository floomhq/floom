from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _request() -> Request:
    return Request({"type": "http", "headers": [(b"host", b"testserver")], "query_string": b""})


class _GitOps:
    GitOpsError = Exception

    def __init__(self, files: dict[str, str]):
        self.files = files

    def list_files_at_sha(self, workspace, sha, prefix):
        return [f"{prefix}/{name}" for name in self.files]

    def get_file_at_sha(self, workspace, sha, file_path):
        name = file_path.rsplit("/", 1)[-1]
        return self.files.get(name)


def test_rollback_route_requires_admin_before_mutation(monkeypatch):
    import routers.worker_versions as versions
    from auth.context import AuthContext

    monkeypatch.setattr(versions, "_worker_for_mutation", lambda *_args, **_kwargs: {"id": "shared-worker"})

    with pytest.raises(HTTPException) as exc:
        versions.rollback_worker(
            "shared-worker",
            "deadbeef",
            _request(),
            auth=AuthContext(user_id="member-user", role="member", auth_method="session"),
            repos=SimpleNamespace(),
        )

    assert exc.value.status_code == 403


def test_rollback_target_rejects_approval_downgrade():
    import routers.worker_versions as versions

    current_worker = {"manifest": {"approvals": {"required": True}}}
    git_ops = _GitOps({"worker.yml": "id: w\nname: w\napprovals:\n  required: false\n"})

    with pytest.raises(HTTPException) as exc:
        versions._validate_rollback_target_files(
            git_ops=git_ops,
            workspace=".",
            sha="deadbeef",
            worker_git_path="workers/w",
            current_worker=current_worker,
        )

    assert exc.value.status_code == 409
    assert "approvals.required" in str(exc.value.detail)


def test_rollback_target_rejects_reenable_of_disabled_worker():
    import routers.worker_versions as versions

    current_worker = {"enabled": False, "manifest": {"enabled": False}}
    git_ops = _GitOps({"worker.yml": "id: w\nname: w\nenabled: true\n"})

    with pytest.raises(HTTPException) as exc:
        versions._validate_rollback_target_files(
            git_ops=git_ops,
            workspace=".",
            sha="deadbeef",
            worker_git_path="workers/w",
            current_worker=current_worker,
        )

    assert exc.value.status_code == 409
    assert "re-enable" in str(exc.value.detail)


def test_rollback_target_rejects_secret_like_files():
    import routers.worker_versions as versions

    git_ops = _GitOps({
        "worker.yml": "id: w\nname: w\n",
        "run.py": "API_KEY = 'sk_live_123456789012345678901234'\n",
    })

    with pytest.raises(HTTPException) as exc:
        versions._validate_rollback_target_files(
            git_ops=git_ops,
            workspace=".",
            sha="deadbeef",
            worker_git_path="workers/w",
            current_worker={"manifest": {}},
        )

    assert exc.value.status_code == 409
    assert "secret-like" in str(exc.value.detail)
