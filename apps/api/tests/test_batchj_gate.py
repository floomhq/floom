"""Batch J — run-create gate on a disabled worker (B-P1-1, 2026-05-29).

A smoke-disabled worker (enabled=False) must reject an on-demand run with
HTTP 409 worker_disabled BEFORE any run row is created — not run it to a
green-but-empty no-op.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_WORKER_YML = """\
schema_version: '0.3'
name: gated-probe
title: Gated Probe
description: A worker for testing the disabled gate.
version: 0.1.0
targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
trigger:
  type: manual
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    wdir = workers_dir / "gated-probe"
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_WORKER_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")
    (wdir / "requirements.txt").write_text("", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-batchj")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    repos = db.get_repositories()

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": "test-secret-batchj"})
    yield client, main, repos
    db.get_repositories.cache_clear()


def test_enabled_worker_run_is_not_gated(client_and_main):
    client, main, repos = client_and_main
    # An enabled worker is NOT blocked by the gate (it may still fail later in
    # the sandbox, but it must not 409 worker_disabled). We assert it does not
    # return 409.
    resp = client.post("/workers/gated-probe/runs", json={"inputs": {"x": "v"}})
    assert resp.status_code != 409, resp.text


def test_disabled_worker_run_returns_409(client_and_main):
    client, main, repos = client_and_main
    # Disable it the way the smoke gate does.
    repos.workers.update(user_id="local-user", worker_id="gated-probe", enabled=False)

    resp = client.post("/workers/gated-probe/runs", json={"inputs": {"x": "v"}})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    # The taxonomy headline for worker_disabled, not a raw string.
    assert body["detail"] == main._OPERATOR_ERROR_CODE_HEADLINES["worker_disabled"]


# --------------------------------------------------------------------------
# Batch L / P2 — worker-detail honesty:
#  - a never-run worker reports neutral "ready", never an unearned "healthy"
#  - GET /workers/{id} never leaks the absolute bundle_path (deploy dir)
#  - `enabled` is exposed so the UI can disable Run on a paused worker
# --------------------------------------------------------------------------

def test_never_run_worker_reports_ready_not_healthy(client_and_main):
    client, main, repos = client_and_main
    resp = client.get("/workers/gated-probe")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # No runs yet -> neutral READY, NOT the unearned "healthy".
    assert body["status"] == "ready", body["status"]
    assert body["enabled"] is True


def test_worker_detail_does_not_leak_bundle_path(client_and_main):
    client, main, repos = client_and_main
    resp = client.get("/workers/gated-probe")
    assert resp.status_code == 200, resp.text
    runtime = (resp.json().get("config") or {}).get("runtime") or {}
    bundle_path = runtime.get("bundle_path")
    # If present at all, it must be a bare basename — never an absolute host path.
    if bundle_path:
        assert "/opt/workeros" not in bundle_path, bundle_path
        assert not bundle_path.startswith("/"), bundle_path
        assert "/" not in bundle_path, bundle_path
    # Belt: the whole serialized detail never contains the deploy dir.
    assert "/opt/workeros/workers" not in resp.text


def test_paused_worker_detail_reports_enabled_false(client_and_main):
    client, main, repos = client_and_main
    repos.workers.update(user_id="local-user", worker_id="gated-probe", enabled=False)
    resp = client.get("/workers/gated-probe")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is False
    # A paused worker that has never run is needs_attention, not healthy/ready.
    assert body["status"] != "healthy"


# --------------------------------------------------------------------------
# Batch L / gen-quality (engine fix) — a generated scalar OUTPUT that omits the
# required `type` must NOT dead-end registration. _normalize_authored_worker_yml
# defaults a typeless scalar output to "string" (lossless) so the worker
# registers, instead of failing with "scalar field '<name>' must declare type".
# Fix the ENGINE, not just the generation prompt (the LLM is non-deterministic).
# --------------------------------------------------------------------------

def test_scalar_output_missing_type_defaults_to_string():
    import run_service as rs
    import yaml as pyyaml

    yml = (
        "name: reverse-string\n"
        "exec:\n  entry: run.py\n"
        "outputs:\n- name: reversed_string\n  kind: scalar\n  required: true\n  label: Reversed\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    field = pyyaml.safe_load(out)["outputs"][0]
    assert field.get("type") == "string"


def test_normalize_does_not_touch_file_output():
    import run_service as rs
    import yaml as pyyaml

    yml = (
        "name: x\nexec:\n  entry: run.py\n"
        "outputs:\n- name: report\n  kind: file\n  media_type: text/csv\n  path: out/report.csv\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    field = pyyaml.safe_load(out)["outputs"][0]
    assert field.get("type") is None
    assert field.get("media_type") == "text/csv"


def test_normalize_missing_file_kind_from_markers_validates_contract():
    # Live create-path schema drift: worker-author sometimes emits file outputs
    # with media_type/path but omits kind:file. WorkerContract defaults missing
    # kind to scalar, then rejects media_type/path. Normalize the intended file
    # shape before registration.
    import run_service as rs
    import yaml as pyyaml
    from models import WorkerContract

    yml = (
        "schema_version: '0.3'\nname: json-report\ntitle: JSON Report\n"
        "description: Writes a JSON report.\nversion: 0.1.0\n"
        "exec:\n  entry: run.py\n  command: python run.py\n  runtime: python311\n  runner: e2b\n"
        "  inputs:\n  - name: topic\n    kind: scalar\n    type: string\n    required: true\n"
        "  outputs:\n  - name: report\n    media_type: application/json\n"
        "    path: out/report.json\n    required: true\n"
        "trigger:\n  type: manual\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    parsed = pyyaml.safe_load(out)
    field = parsed["exec"]["outputs"][0]
    assert field.get("kind") == "file"
    assert field.get("media_type") == "application/json"
    assert field.get("path") == "out/report.json"
    WorkerContract.model_validate(parsed)


def test_normalize_select_without_options_to_string():
    import run_service as rs
    import yaml as pyyaml
    from models import WorkerContract

    yml = (
        "schema_version: '0.3'\nname: choose-topic\ntitle: Choose Topic\n"
        "description: Echoes the selected topic.\nversion: 0.1.0\n"
        "exec:\n  entry: run.py\n  command: python run.py\n  runtime: python311\n  runner: e2b\n"
        "  inputs:\n  - name: topic\n    kind: scalar\n    type: select\n    required: true\n"
        "  outputs:\n  - name: result\n    kind: scalar\n    type: string\n"
        "trigger:\n  type: manual\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    parsed = pyyaml.safe_load(out)
    field = parsed["exec"]["inputs"][0]
    assert field.get("type") == "string"
    WorkerContract.model_validate(parsed)


def test_normalize_handles_exec_outputs_block():
    import run_service as rs
    import yaml as pyyaml

    yml = (
        "name: x\nexec:\n  entry: run.py\n"
        "  outputs:\n  - name: total\n    kind: scalar\n    required: true\n    label: Total\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    field = pyyaml.safe_load(out)["exec"]["outputs"][0]
    assert field.get("type") == "string"


def test_normalize_resolves_contradictory_scalar_with_file_markers():
    # The exact live failure: LLM declared kind:scalar BUT added path+media_type
    # (file markers) and no type, which the schema rejects. Resolve to a clean
    # scalar (strip the stray file markers, default type) so it registers and
    # validates as a WorkerContract.
    import run_service as rs
    import yaml as pyyaml
    from models import WorkerContract

    yml = (
        "schema_version: '0.3'\nname: string-reverser\ntitle: String Reverser\n"
        "description: Reverses a string.\nversion: 0.1.0\n"
        "exec:\n  entry: run.py\n  command: python run.py\n  runtime: python311\n  runner: e2b\n"
        "  inputs:\n  - name: input_string\n    kind: scalar\n    type: string\n    required: true\n    label: Input\n"
        "  outputs:\n  - name: reversed_string\n    kind: scalar\n    media_type: text/plain\n"
        "    path: out/reversed_string.txt\n    required: true\n    label: Reversed\n"
        "  trigger:\n    type: manual\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    parsed = pyyaml.safe_load(out)
    field = parsed["exec"]["outputs"][0]
    assert field.get("kind") == "scalar"
    assert field.get("type") == "string"
    assert "path" not in field
    assert "media_type" not in field
    # And it now validates as a real contract (no more "must declare type").
    WorkerContract.model_validate(parsed)


def test_normalize_fixes_type_in_kind_slot_input():
    # The live sum_column failure: input declared kind:textarea (a TYPE value in
    # the kind slot). Normalize to kind:scalar + type:textarea so it validates.
    import run_service as rs
    import yaml as pyyaml
    from models import WorkerContract

    yml = (
        "schema_version: '0.3'\nname: sum-column\ntitle: Sum Column\n"
        "description: Sum numbers.\nversion: 0.1.0\n"
        "exec:\n  entry: run.py\n  command: python run.py\n  runtime: python311\n  runner: e2b\n"
        "  inputs:\n  - name: numbers\n    kind: textarea\n    required: true\n    label: Numbers\n"
        "  outputs:\n  - name: total\n    kind: scalar\n    media_type: text/plain\n    required: true\n    label: Total\n"
        "  trigger:\n    type: manual\n"
    )
    out = rs._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    parsed = pyyaml.safe_load(out)
    inp = parsed["exec"]["inputs"][0]
    assert inp.get("kind") == "scalar"
    assert inp.get("type") == "textarea"
    out_field = parsed["exec"]["outputs"][0]
    assert out_field.get("kind") == "scalar"
    assert out_field.get("type") == "string"
    assert "media_type" not in out_field
    # Whole contract validates now.
    WorkerContract.model_validate(parsed)
