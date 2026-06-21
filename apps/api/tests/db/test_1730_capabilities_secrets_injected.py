"""#1730 — secrets declared under `capabilities.secrets` must be injected.

A worker that declared `capabilities: {secrets: [BUFFER_API_TOKEN]}` saw the
secret as unset at runtime even though it was set in the workspace, because
`get_secrets_for_worker` only resolved `config.secrets` (top-level/exec) and
never the `capabilities.secrets` shape. The resolver now unions both.
"""

from __future__ import annotations

import importlib
import json
import os

import pytest

_SECRET = "BUFFER_API_TOKEN"


@pytest.fixture
def run_service(repo_bundle):
    import run_service as _run_service

    return importlib.reload(_run_service)


@pytest.fixture(autouse=True)
def _isolate_secret_env():
    saved = os.environ.get(_SECRET)
    os.environ.pop(_SECRET, None)
    try:
        yield
    finally:
        if saved is None:
            os.environ.pop(_SECRET, None)
        else:
            os.environ[_SECRET] = saved


def _capabilities_secret_manifest(worker_id: str) -> str:
    return json.dumps(
        {
            "id": worker_id,
            "name": "Buffer poster",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
            "inputs": [],
            "outputs": [],
            "connections": [],
            # Declared ONLY under capabilities.secrets (not top-level/exec).
            "capabilities": {"secrets": [_SECRET], "network": {"egress": True}},
        }
    )


def test_capabilities_secret_is_resolved_for_injection(repo_bundle, run_service):
    repos, _db, _manifest = repo_bundle
    owner = "local-user"
    worker_id = "buffer-poster"

    repos.workers.create(
        user_id=owner,
        worker_id=worker_id,
        name="Buffer poster",
        manifest_json=_capabilities_secret_manifest(worker_id),
        bundle_path=f"workers/{worker_id}",
    )
    repos.secrets.set(user_id=owner, name=_SECRET, value="x" * 43)

    # Sanity: the secret lives under capabilities.secrets, NOT config.secrets —
    # i.e. the exact shape that used to be dropped.
    config = run_service._get_worker_config_for_run(worker_id, repos)
    assert _SECRET not in (config.secrets or [])
    assert config.capabilities is not None
    assert _SECRET in (config.capabilities.secrets or [])

    os.environ.pop(_SECRET, None)
    run_service._load_runtime_env_files()
    resolved = run_service.get_secrets_for_worker(worker_id, user_id=owner, repos=repos)

    assert resolved.get(_SECRET) == "x" * 43


def test_unset_capabilities_secret_is_absent(repo_bundle, run_service):
    repos, _db, _manifest = repo_bundle
    owner = "local-user"
    worker_id = "buffer-poster-2"

    repos.workers.create(
        user_id=owner,
        worker_id=worker_id,
        name="Buffer poster 2",
        manifest_json=_capabilities_secret_manifest(worker_id),
        bundle_path=f"workers/{worker_id}",
    )
    # secret NOT set in the workspace
    os.environ.pop(_SECRET, None)
    run_service._load_runtime_env_files()
    resolved = run_service.get_secrets_for_worker(worker_id, user_id=owner, repos=repos)

    assert _SECRET not in resolved
