from __future__ import annotations

import os
from pathlib import Path

from apps.api import _engine


def test_cloud_workers_dir_defaults_to_vendored_engine(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", "/opt/workeros-cloud/var/workers")
    monkeypatch.delenv("WORKEROS_WORKERS_DIR", raising=False)

    workers_dir = _engine.configure_cloud_workers_dir()

    assert workers_dir == _engine.engine_workers_dir()
    assert os.environ["FLOOM_WORKERS_DIR"] == str(_engine.engine_workers_dir())
    assert (workers_dir / "worker-author" / "run.py").is_file()
    assert (workers_dir / "worker-author" / "SKILL.md").is_file()
    assert (workers_dir / "worker-author" / "requirements.txt").is_file()


def test_cloud_workers_dir_supports_explicit_cloud_override(monkeypatch, tmp_path):
    custom_workers = tmp_path / "workers"
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_WORKERS_DIR", str(custom_workers))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", "/opt/workeros-cloud/var/workers")

    workers_dir = _engine.configure_cloud_workers_dir()

    assert workers_dir == custom_workers.resolve()
    assert os.environ["FLOOM_WORKERS_DIR"] == str(custom_workers.resolve())


def test_local_deploy_does_not_rewrite_floom_workers_dir(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", "/tmp/local-workers")
    monkeypatch.delenv("WORKEROS_WORKERS_DIR", raising=False)

    assert _engine.configure_cloud_workers_dir() is None
    assert os.environ["FLOOM_WORKERS_DIR"] == "/tmp/local-workers"


def test_ensure_engine_api_path_configures_cloud_workers_before_import(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", "/opt/workeros-cloud/var/workers")
    monkeypatch.delenv("WORKEROS_WORKERS_DIR", raising=False)

    api_path = _engine.ensure_engine_api_path()

    assert api_path == _engine.engine_api_dir()
    assert Path(os.environ["FLOOM_WORKERS_DIR"]) == _engine.engine_workers_dir()
