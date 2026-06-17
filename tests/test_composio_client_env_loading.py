import importlib
import os
import sys
from pathlib import Path

import dotenv


API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _import_composio_client(monkeypatch, *, workeros_dev: str | None):
    sys.modules.pop("composio_client", None)
    if workeros_dev is None:
        monkeypatch.delenv("WORKEROS_DEV", raising=False)
    else:
        monkeypatch.setenv("WORKEROS_DEV", workeros_dev)
    return importlib.import_module("composio_client")


def test_composio_client_does_not_load_api_env_outside_dev(monkeypatch):
    calls = []
    monkeypatch.setattr(
        dotenv,
        "load_dotenv",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    _import_composio_client(monkeypatch, workeros_dev=None)

    assert calls == []


def test_composio_client_loads_api_env_in_explicit_dev(monkeypatch, tmp_path):
    calls = []
    api_env = tmp_path / "api.env"
    api_env.write_text("COMPOSIO_API_KEY=dev-key\n", encoding="utf-8")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(api_env))
    monkeypatch.setattr(
        dotenv,
        "load_dotenv",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    _import_composio_client(monkeypatch, workeros_dev="1")

    assert len(calls) == 1
    assert Path(calls[0][0][0]) == api_env
    assert calls[0][1]["override"] is False
