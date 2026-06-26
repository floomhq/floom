"""Workers must not expose credentials as run inputs."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from services.worker_registry_ops import _parse_worker_payload


def _worker_yml(inputs: str = "", *, exec_extra: str = "", extra: str = "") -> str:
    return f"""
schema_version: "0.3"
name: linear-triage
title: "Linear Triage"
description: "Triage Linear issues"
version: "0.1.0"
trigger:
  type: manual
exec:
  mode: pure-script
  runner: e2b
  runtime: python311
  entry: run.py
{inputs}
{exec_extra}
{extra}
""".strip()


def test_rejects_api_key_run_input():
    with pytest.raises(HTTPException) as exc:
        _parse_worker_payload(
            _worker_yml(
                """
  inputs:
    - name: linear_api_key
      type: string
      label: Linear API key
      description: API key used to call Linear
"""
            )
        )

    assert exc.value.status_code == 400
    assert "inputs must not collect credentials" in str(exc.value.detail)
    assert "linear_api_key" in str(exc.value.detail)
    assert "secrets" in str(exc.value.detail)


def test_rejects_auth_connection_run_input():
    with pytest.raises(HTTPException) as exc:
        _parse_worker_payload(
            _worker_yml(
                """
  inputs:
    - name: linear_connection
      type: string
      label: Linear Connection
      description: The Linear connection to authenticate API requests.
"""
            )
        )

    assert exc.value.status_code == 400
    assert "linear_connection" in str(exc.value.detail)
    assert "connections" in str(exc.value.detail)


def test_allows_business_key_input():
    worker_id, config = _parse_worker_payload(
        _worker_yml(
            """
  inputs:
    - name: team_key
      type: string
      label: Team key
      description: Linear team key, e.g. ENG.
"""
        )
    )

    assert worker_id == "linear-triage"
    assert [inp.name for inp in config.inputs] == ["team_key"]


def test_allows_declared_secret_instead_of_run_input():
    worker_id, config = _parse_worker_payload(
        _worker_yml(
            exec_extra="""
  secrets:
    - LINEAR_API_KEY
""",
            extra="""
connections:
  - app: linear
"""
        )
    )

    assert worker_id == "linear-triage"
    assert config.secrets == ["LINEAR_API_KEY"]
    assert config.connections[0].app == "linear"
