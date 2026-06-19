"""Issue #54 (follow-up to #200): draft-and-create must dedupe worker ids
against the REPOSITORY (DB), not just the ephemeral filesystem.

In a multi-tenant deploy (a downstream host) worker rows live in the DB scoped by
workspace, but the worker id is a GLOBAL primary key (``id TEXT PRIMARY KEY``
on the ``workers`` table). When the LLM author emits an id that already exists
as a DB row in a DIFFERENT workspace than the request's active workspace, the
old filesystem-only ``_free_worker_id`` saw no collision and returned the id
as-is, so the create then collided / 409'd ("failed to upsert <id>").

This test reproduces that condition in local SQLite mode: it seeds a worker row
directly through the repository (so ``repos.workers.get_any`` reports it as
existing) WITHOUT creating its filesystem dir, then drafts a worker whose
generated id collides with the seeded one. With the fix, dedupe consults the
repo and returns a distinct id; no 409.

Kept in its own file (with FLOOM_SECRET cleared before importing main) to avoid
the pre-existing cross-file env-leak isolation bug where other test modules
leak FLOOM_SECRET into os.environ.

KNOWN PRE-EXISTING ISOLATION BUG (not introduced here): when the WHOLE suite is
run in a single ``pytest tests/`` process, sibling test modules mutate the
process-global ``FLOOM_SECRET`` / ``FLOOM_DB`` env after ``main`` has cached its
auth provider (``@lru_cache`` on ``get_auth_provider``), so the HTTP integration
test below can hit a cross-file 401. Both tests in this file PASS when the file
is run on its own (``pytest tests/test_pr_54_draft_id_collision_repo.py``). The
pure-function ``test_free_worker_id_consults_repo_for_global_collision`` below
touches no HTTP/auth/DB and is therefore immune to the leak: it is the durable
regression guard for the #54 fix. A prior agent already flagged this suite-wide
env-leak bug; it is out of scope for this PR.
"""

import json
import os
import sys
import tempfile

import pytest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
# Isolate this module's DB and clear any leaked auth secret so the unauth
# in-process client path is used deterministically.
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)
if not os.environ.get("OPENAI_API_KEY", "").strip():
    os.environ["OPENAI_API_KEY"] = "sk-test-fake-key"

# Force local (SQLite) repositories regardless of ambient config.
os.environ["WORKEROS_DEPLOY"] = "local"


def _valid_worker_yml(name: str = "applicant-followup") -> str:
    return f"""\
schema_version: "0.3"
name: {name}
title: "Applicant Followup"
description: "Unit test worker for #54."
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  runtime: skill
  mode: agent
  runner: e2b
  entrypoint: SKILL.md
  inputs: []
  outputs: []

trigger:
  type: manual
"""


def _llm_json_response(worker_yml: str) -> str:
    return json.dumps({
        "worker_yml": worker_yml,
        "suggested_name": "applicant-followup",
        "suggested_title": "Applicant Followup",
        "required_connections": [],
        "required_secrets": [],
        "inputs": [],
        "outputs": [],
        "files": [
            {"path": "worker.yml", "content": worker_yml},
            {"path": "SKILL.md", "content": "# Applicant Followup\n\nTest skill."},
        ],
    })


def _mock_openai_response(content: str):
    choice = MagicMock()
    choice.message.content = content
    response = MagicMock()
    response.choices = [choice]
    return response


@pytest.fixture()
def client_with_tmp_workers(tmp_path, monkeypatch):
    import worker_registry
    # Empty filesystem view: the colliding id will NOT exist on disk, only
    # in the repository (the hosted cross-workspace scenario).
    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)
    from fastapi.testclient import TestClient
    from main import app  # importing main auto-generates a FLOOM_SECRET in env

    # Local auth requires x-floom-secret; main sets one at import time.
    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}
    tc = TestClient(app, headers=headers)
    return tc, tmp_path


@patch("codegen_model.chat_completion_codegen")
def test_dedupe_against_repo_row_not_on_filesystem(mock_codegen, client_with_tmp_workers):
    """An id that exists only as a repo/DB row (not on this request's
    filesystem) must be deduped, so draft-and-create returns a distinct id and
    does not 409."""
    client, workers_dir = client_with_tmp_workers

    # ------------------------------------------------------------------
    # Seed a worker row directly through the repository so get_any() reports
    # the id as existing — but DO NOT create its filesystem dir. This models a
    # worker owned by a different workspace whose dir is absent from this
    # request's ephemeral filesystem view.
    # ------------------------------------------------------------------
    import yaml as pyyaml
    from db import get_repositories

    repos = get_repositories()
    seeded = repos.workers.upsert(
        user_id="someone-else",
        worker_id="applicant-followup",
        name="Applicant Followup",
        manifest_json=pyyaml.safe_load(_valid_worker_yml()),
        trigger_type="manual",
    )
    assert seeded is not None
    # Precondition: repo reports the id as existing globally, filesystem does not.
    assert repos.workers.get_any(worker_id="applicant-followup") is not None
    assert not (workers_dir / "applicant-followup").exists()

    # The LLM author returns the same colliding id.
    mock_codegen.return_value = _mock_openai_response(
        _llm_json_response(_valid_worker_yml())
    )

    resp = client.post(
        "/workers/draft-and-create",
        json={"prompt": "Follow up with applicants after interviews"},
    )
    assert resp.status_code == 200, resp.text
    new_id = resp.json()["worker_id"]

    # The fix: dedupe consults the repo, so the new worker gets a distinct id
    # instead of colliding and 409'ing.
    assert new_id != "applicant-followup", (
        "draft-and-create must dedupe against the repo, not reuse a DB-only id"
    )
    # Robust to any extra colliding rows left in the shared test DB by sibling
    # modules: the deduped id must be a suffixed variant of the base.
    assert new_id.startswith("applicant-followup-"), new_id

    # The new worker's dir + manifest exist and agree on the deduped id.
    assert (workers_dir / new_id / "worker.yml").exists()
    raw = pyyaml.safe_load((workers_dir / new_id / "worker.yml").read_text())
    assert raw.get("name") == new_id


def test_free_worker_id_consults_repo_for_global_collision(monkeypatch, tmp_path):
    """Unit-level: _free_worker_id treats an id that exists only in the repo
    (get_any) as taken, even when the filesystem is empty."""
    import worker_registry
    import main

    monkeypatch.setattr(worker_registry, "WORKERS_DIR", tmp_path)

    class _FakeWorkers:
        def __init__(self, existing):
            self._existing = set(existing)

        def get_any(self, *, worker_id):
            return {"id": worker_id} if worker_id in self._existing else None

    class _FakeRepos:
        workers = None

    fake = _FakeRepos()
    fake.workers = _FakeWorkers({"applicant-followup"})

    # Filesystem is empty; without the repo check this would return the base id.
    out = main._free_worker_id("applicant-followup", repos=fake)
    assert out == "applicant-followup-2"

    # An id absent from both repo and filesystem is returned unchanged.
    out2 = main._free_worker_id("brand-new-id", repos=fake)
    assert out2 == "brand-new-id"

    # Backward compatible: no repo -> filesystem-only behavior (returns base id).
    out3 = main._free_worker_id("applicant-followup")
    assert out3 == "applicant-followup"
