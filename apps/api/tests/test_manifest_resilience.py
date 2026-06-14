"""Regression: stored worker manifests missing id/trigger/runtime must not crash.

Root cause (2026-06-14 cloud audit, Issue 10 + log noise): legacy manifests
persisted by older engine versions can lack the WorkerConfig-required `id`,
`trigger` and `runtime` fields. `_config_from_manifest` called
`parse_worker_manifest(raw)` -> `WorkerConfig(**raw)` which raised a pydantic
ValidationError. The global `@app.exception_handler(ValueError)` then masked it
as a generic `400 {"detail": "Invalid request"}`, and the constant parse errors
flooded the logs. The DB row carries authoritative fallbacks (id column,
trigger_type, cron_*), so we backfill (migration-on-read) instead of crashing.
"""

import json

from db.sqlite import _backfill_legacy_manifest, _config_from_manifest
from models import WorkerConfig, WorkerContract, parse_worker_manifest


def test_backfill_adds_missing_id_trigger_runtime():
    healed = _backfill_legacy_manifest(
        {"name": "Legacy Worker", "description": "no id/trigger/runtime"},
        worker_id="legacy-demo",
        trigger_type="schedule",
        cron_expr="0 9 * * *",
        cron_timezone="UTC",
    )
    assert healed["id"] == "legacy-demo"
    assert healed["trigger"]["type"] == "schedule"
    assert healed["trigger"]["cron"] == "0 9 * * *"
    assert healed["trigger"]["timezone"] == "UTC"
    assert healed["runtime"]["type"]  # some non-empty runtime type
    # Must parse cleanly into a WorkerConfig now.
    cfg = WorkerConfig(**healed)
    assert cfg.id == "legacy-demo"
    assert cfg.trigger.type == "schedule"


def test_backfill_defaults_trigger_manual_when_no_columns():
    healed = _backfill_legacy_manifest(
        {"name": "Bare"},
        worker_id="bare",
        trigger_type=None,
        cron_expr=None,
        cron_timezone=None,
    )
    assert healed["trigger"]["type"] == "manual"
    WorkerConfig(**healed)  # must not raise


def test_backfill_leaves_contract_manifests_untouched():
    contract_raw = {"schema_version": "0.3", "name": "x"}
    healed = _backfill_legacy_manifest(
        contract_raw,
        worker_id="x",
        trigger_type="manual",
        cron_expr=None,
        cron_timezone=None,
    )
    # 0.3 contracts have a different required shape; we must NOT inject legacy
    # WorkerConfig fields into them.
    assert "trigger" not in healed
    assert "runtime" not in healed
    assert healed == contract_raw


def test_config_from_manifest_heals_legacy_row():
    """The DB read path must produce a usable WorkerConfig from a broken row."""
    broken_manifest = json.dumps({"name": "Outbound Demo"})  # missing id/trigger/runtime
    cfg = _config_from_manifest(
        worker_id="outbound-approval-demo",
        manifest_json=broken_manifest,
        trigger_type="manual",
        cron_expr=None,
        cron_timezone=None,
        bundle_path="workers/outbound-approval-demo",
    )
    assert cfg is not None
    assert cfg.id == "outbound-approval-demo"
    assert cfg.trigger.type == "manual"
    assert cfg.runtime is not None
    assert cfg.runtime.bundle_path == "workers/outbound-approval-demo"


def test_config_from_manifest_preserves_valid_manifest():
    """A complete legacy manifest must round-trip unchanged (no over-healing)."""
    good = json.dumps(
        {
            "id": "valid-worker",
            "name": "Valid",
            "trigger": {"type": "webhook", "webhook": {"secret": True}},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        }
    )
    cfg = _config_from_manifest(
        worker_id="valid-worker",
        manifest_json=good,
        trigger_type=None,
        cron_expr=None,
        cron_timezone=None,
        bundle_path=None,
    )
    assert cfg is not None
    assert cfg.trigger.type == "webhook"
    assert cfg.runtime.entrypoint == "run.py"
