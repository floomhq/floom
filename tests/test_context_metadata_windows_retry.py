from __future__ import annotations

import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import contexts  # noqa: E402


@pytest.mark.flaky_ci
def test_save_context_metadata_retries_transient_windows_replace_error(monkeypatch, tmp_path):
    monkeypatch.setattr(contexts, "CONTEXTS_DIR", tmp_path)
    monkeypatch.setattr(contexts, "CONTEXT_METADATA_PATH", tmp_path / ".workeros-contexts.json")
    monkeypatch.setattr(contexts, "current_contexts_root", lambda: tmp_path)
    monkeypatch.setattr(contexts, "current_metadata_path", lambda: tmp_path / ".workeros-contexts.json")
    monkeypatch.setattr(contexts.time, "sleep", lambda _seconds: None)

    real_replace = contexts.os.replace
    calls = {"count": 0}

    def flaky_replace(src, dst):
        calls["count"] += 1
        if calls["count"] == 1:
            raise PermissionError("transient Windows replace lock")
        return real_replace(src, dst)

    monkeypatch.setattr(contexts.os, "replace", flaky_replace)

    contexts.save_context_metadata({"kb": {"writeable": True}})

    assert calls["count"] == 2
    assert contexts.load_context_metadata() == {"kb": {"writeable": True}}
