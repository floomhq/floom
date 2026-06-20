"""#1137 - create-mode worker authoring uses the platform provider path."""
from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from unittest.mock import patch

import yaml

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_BEDROCK = "bedrock/us.anthropic.claude-sonnet-4-6"
_GEMINI = "gemini/gemini-3.5-flash"


def _load_worker_author_module():
    path = REPO_ROOT / "workers" / "worker-author" / "run.py"
    spec = importlib.util.spec_from_file_location("worker_author_run_for_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_codegen_model_falls_back_to_chat_model(monkeypatch):
    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", _BEDROCK)
    sys.modules.pop("codegen_model", None)

    codegen_model = importlib.import_module("codegen_model")

    assert codegen_model.codegen_model() == _BEDROCK


def test_worker_author_model_falls_back_to_chat_model(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", _BEDROCK)

    assert worker_author._codegen_model() == _BEDROCK


def test_worker_author_reports_missing_bedrock_credentials(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _BEDROCK)
    for name in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION_NAME",
        "AWS_DEFAULT_REGION",
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_PROFILE",
    ):
        monkeypatch.delenv(name, raising=False)

    assert "AWS credentials" in worker_author._provider_credentials_error(_BEDROCK)


def test_worker_author_reports_missing_gemini_credentials(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _GEMINI)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    assert "GEMINI_API_KEY" in worker_author._provider_credentials_error(_GEMINI)


def test_worker_author_routes_bedrock_through_litellm(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _BEDROCK)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION_NAME", "us-west-2")
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "OK"

    with patch("litellm.completion", side_effect=fake_completion):
        out = worker_author._codegen_chat(
            messages=[{"role": "system", "content": "S"}, {"role": "user", "content": "u"}],
            max_output_tokens=12,
            temperature=0.2,
            response_format={"type": "json_object"},
        )

    assert out == "OK"
    assert captured["model"] == _BEDROCK
    assert captured["max_tokens"] == 12
    assert captured["messages"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}


def test_worker_author_routes_gemini_through_litellm(monkeypatch):
    worker_author = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _GEMINI)
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return "OK"

    with patch("litellm.completion", side_effect=fake_completion):
        out = worker_author._codegen_chat(
            messages=[{"role": "system", "content": "S"}, {"role": "user", "content": "u"}],
            max_output_tokens=12,
            temperature=0.2,
            response_format={"type": "json_object"},
        )

    assert out == "OK"
    assert captured["model"] == _GEMINI
    assert captured["max_tokens"] == 12
    assert captured["messages"][0]["content"] == "S"


def test_worker_author_env_bridge_uses_resolved_model_and_provider_env(monkeypatch):
    from runner_sandbox.e2b_driver import _worker_author_platform_env

    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", _BEDROCK)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("AWS_REGION_NAME", "us-west-2")

    env = _worker_author_platform_env()

    assert env["WORKEROS_CODEGEN_MODEL"] == _BEDROCK
    assert env["AWS_ACCESS_KEY_ID"] == "AKIAEXAMPLE"
    assert env["AWS_SECRET_ACCESS_KEY"] == "secret"
    assert env["AWS_REGION_NAME"] == "us-west-2"


def test_worker_author_env_bridge_forwards_gemini_key(monkeypatch):
    from runner_sandbox.e2b_driver import _worker_author_platform_env

    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", _GEMINI)
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    env = _worker_author_platform_env()

    assert env["WORKEROS_CODEGEN_MODEL"] == _GEMINI
    assert env["GEMINI_API_KEY"] == "test-gemini-key"


def test_worker_author_manifest_does_not_require_byo_ai_key():
    manifest_path = REPO_ROOT / "workers" / "worker-author" / "worker.yml"
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))

    assert (manifest.get("exec") or {}).get("secrets") == []
