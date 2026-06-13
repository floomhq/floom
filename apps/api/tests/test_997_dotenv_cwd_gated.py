"""#997 — main.py must not load a .env from the process cwd in production.

A bare `load_dotenv()` at import loaded a .env from cwd, silently injecting
config/secrets (a stale dev file, or one an attacker drops in cwd). The cwd
load is now gated to WORKEROS_DEV=1; the explicit fixed-location api.env
loader (WORKEROS_API_ENV_FILE / ~/.config/workeros/api.env) remains.

Run: cd apps/api && python -m pytest tests/test_997_dotenv_cwd_gated.py -q
"""
from __future__ import annotations

import importlib
import os
import sys
import types
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _boot(monkeypatch, tmp_path, *, dev: bool, cwd: Path):
    monkeypatch.chdir(cwd)
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    (tmp_path / "workers").mkdir(exist_ok=True)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    if dev:
        monkeypatch.setenv("WORKEROS_DEV", "1")
    else:
        monkeypatch.delenv("WORKEROS_DEV", raising=False)
    monkeypatch.delenv("LEAKED_FROM_CWD_DOTENV", raising=False)
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("db", "auth", "contexts")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    importlib.import_module("main")


def test_cwd_dotenv_ignored_in_production(monkeypatch, tmp_path):
    """The security property: importing main from a dir with a .env present
    must NOT pull that .env into the environment in production."""
    cwd = tmp_path / "rundir"
    cwd.mkdir()
    (cwd / ".env").write_text("LEAKED_FROM_CWD_DOTENV=yes\n")
    _boot(monkeypatch, tmp_path, dev=False, cwd=cwd)
    assert os.environ.get("LEAKED_FROM_CWD_DOTENV") is None, (
        "production import loaded .env from cwd (#997)"
    )


def test_cwd_load_is_gated_behind_dev_in_source():
    """Pin the gate so the bare cwd load can't regress back to unconditional."""
    src = (API_DIR / "main.py").read_text(encoding="utf-8")
    # the only bare load_dotenv() call must sit under the WORKEROS_DEV gate
    assert 'if os.environ.get("WORKEROS_DEV") == "1":' in src
    gate_idx = src.index('if os.environ.get("WORKEROS_DEV") == "1":')
    # the bare load_dotenv() appears after the gate, and there is no
    # unconditional one before the explicit api.env loader
    before_gate = src[:gate_idx]
    assert "\nload_dotenv()\n" not in before_gate, "unconditional cwd load_dotenv() still present (#997)"
