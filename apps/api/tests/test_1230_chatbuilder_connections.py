from __future__ import annotations

import sqlite3
import textwrap
from contextlib import contextmanager
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException

from models import WorkerContract, parse_worker_manifest
from services.worker_codegen import _DRAFT_SYSTEM_PROMPT, _repair_generated_worker_manifest
from services.worker_registry_ops import (
    _normalize_worker_yml_connections,
    _parse_worker_payload,
)


_CANONICAL_WORKER_YML = """\
schema_version: "0.3"
name: "connection-placement-test"
title: "Connection placement test"
description: "Verifies canonical connection placement."
version: "0.1.0"
connections:
  - app: gmail
    allowed_tools:
      - GMAIL_FETCH_EMAILS
trigger:
  type: manual
exec:
  entry: SKILL.md
  runtime: skill
  runner: e2b
  inputs: []
  outputs: []
"""


def _draft_prompt_example_c_manifest() -> dict:
    example = _DRAFT_SYSTEM_PROMPT.split("Example C (script that calls an LLM):", 1)[1]
    yaml_block = example.split("  worker.yml: |\n", 1)[1].split("  SKILL.md: |", 1)[0]
    return yaml.safe_load(textwrap.dedent(yaml_block))


def test_codegen_example_places_connections_at_worker_contract_top_level() -> None:
    manifest = _draft_prompt_example_c_manifest()

    assert manifest["connections"] == ["hubspot"]
    assert "connections" not in manifest["exec"]
    assert "Never put `connections` inside `exec` or `capabilities`" in _DRAFT_SYSTEM_PROMPT


def test_emily_create_guidance_forbids_nested_connections() -> None:
    chat_source = (
        Path(__file__).resolve().parents[1] / "chat_service.py"
    ).read_text(encoding="utf-8")
    create_tool = chat_source.split('"workers__create"', 1)[1].split('"workers__update"', 1)[0]

    assert "Never put connections inside either block" in create_tool
    assert "top-level sibling of exec and capabilities" in create_tool


def test_save_validation_rejects_connections_nested_under_exec() -> None:
    misplaced = _CANONICAL_WORKER_YML.replace(
        "connections:\n  - app: gmail\n    allowed_tools:\n      - GMAIL_FETCH_EMAILS\n",
        "",
    ).replace(
        "exec:\n",
        "exec:\n  connections:\n    - app: gmail\n      allowed_tools:\n        - GMAIL_FETCH_EMAILS\n",
    )

    with pytest.raises(HTTPException) as exc_info:
        _parse_worker_payload(misplaced)

    assert exc_info.value.status_code == 400
    assert "connections: must be a top-level field" in str(exc_info.value.detail)
    assert "not nested under exec" in str(exc_info.value.detail)


def test_contract_parser_rejects_misplaced_connections_for_all_parse_paths() -> None:
    misplaced = yaml.safe_load(
        _CANONICAL_WORKER_YML.replace(
            "connections:\n  - app: gmail\n    allowed_tools:\n      - GMAIL_FETCH_EMAILS\n",
            "",
        ).replace(
            "exec:\n",
            "exec:\n  connections:\n    - app: gmail\n      allowed_tools:\n        - GMAIL_FETCH_EMAILS\n",
        )
    )

    with pytest.raises(ValueError, match="top-level sibling of exec"):
        parse_worker_manifest(misplaced)


def test_codegen_repairs_capabilities_connections_to_top_level() -> None:
    misplaced = yaml.safe_load(_CANONICAL_WORKER_YML)
    connections = misplaced.pop("connections")
    misplaced["capabilities"] = {
        "network": {"egress": True},
        "connections": connections,
    }

    repaired = _repair_generated_worker_manifest(misplaced)

    assert repaired["connections"] == connections
    assert repaired["capabilities"] == {"network": {"egress": True}}


def test_save_normalization_persists_capabilities_connections_at_top_level() -> None:
    misplaced = _CANONICAL_WORKER_YML.replace(
        "connections:\n  - app: gmail\n    allowed_tools:\n      - GMAIL_FETCH_EMAILS\n",
        "capabilities:\n  network:\n    egress: true\n  connections:\n"
        "    - app: gmail\n      allowed_tools:\n        - GMAIL_FETCH_EMAILS\n",
    )

    normalized_yml = _normalize_worker_yml_connections(misplaced)
    normalized = yaml.safe_load(normalized_yml)
    worker_id, config = _parse_worker_payload(normalized_yml)

    assert worker_id == "connection-placement-test"
    assert normalized["connections"] == [
        {"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}
    ]
    assert normalized["capabilities"] == {"network": {"egress": True}}
    assert config.connections[0].app == "gmail"


def test_conflicting_capabilities_connections_prefer_top_level() -> None:
    conflicting = yaml.safe_load(_CANONICAL_WORKER_YML)
    conflicting["capabilities"] = {"connections": ["slack"]}

    with pytest.warns(UserWarning, match="capabilities.connections was ignored"):
        repaired = _repair_generated_worker_manifest(conflicting)

    assert repaired["connections"] == [
        {"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}
    ]
    assert repaired["capabilities"] == {}


def test_explicit_empty_top_level_connections_cannot_be_widened() -> None:
    conflicting = yaml.safe_load(_CANONICAL_WORKER_YML)
    conflicting["connections"] = []
    conflicting["capabilities"] = {"connections": ["gmail"]}

    with pytest.warns(UserWarning, match="capabilities.connections was ignored"):
        repaired = _repair_generated_worker_manifest(conflicting)

    assert repaired["connections"] == []
    assert repaired["capabilities"] == {}


def test_alesoda_dual_declared_worker_contract_parses_with_top_level_gmail() -> None:
    worker_manifest = yaml.safe_load(_CANONICAL_WORKER_YML)
    worker_manifest["name"] = "gmail-summary-agent"
    worker_manifest["title"] = "Gmail summary agent"
    worker_manifest["connections"] = [
        {"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}
    ]
    worker_manifest["capabilities"] = {
        "network": {"egress": True},
        "connections": [
            {"app": "gmail", "allowed_tools": ["GMAIL_SEND_EMAIL"]}
        ],
    }

    with pytest.warns(UserWarning, match="capabilities.connections was ignored"):
        contract = parse_worker_manifest(worker_manifest)

    assert isinstance(contract, WorkerContract)
    assert len(contract.connections) == 1
    assert contract.connections[0].app == "gmail"
    assert contract.connections[0].allowed_tools == ["GMAIL_FETCH_EMAILS"]
    assert contract.capabilities.network.egress is True


def test_canonical_connections_pass_validation_and_resolve_at_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker_id, config = _parse_worker_payload(_CANONICAL_WORKER_YML)

    assert worker_id == "connection-placement-test"
    assert len(config.connections) == 1
    connection = config.connections[0]
    assert connection.app == "gmail"
    assert connection.allowed_tools == ["GMAIL_FETCH_EMAILS"]

    connection_db = sqlite3.connect(":memory:")
    connection_db.row_factory = sqlite3.Row
    connection_db.execute(
        "CREATE TABLE composio_connections ("
        "app_name TEXT, user_id TEXT, composio_connection_id TEXT, "
        "status TEXT, updated_at TEXT)"
    )
    connection_db.execute(
        "INSERT INTO composio_connections VALUES (?, ?, ?, ?, ?)",
        ("gmail", "user-1230", "ca_gmail_1230", "active", "2026-07-20T00:00:00Z"),
    )

    @contextmanager
    def fake_get_db():
        yield connection_db

    import db as db_module
    import runner_utils

    monkeypatch.setattr(db_module, "get_db", fake_get_db)
    connection_ids, error = runner_utils._resolve_connections(
        worker_id,
        lambda *_args, **_kwargs: None,
        config,
        user_id="user-1230",
    )
    connection_db.close()

    assert error is None
    assert connection_ids == {"gmail": "ca_gmail_1230"}
