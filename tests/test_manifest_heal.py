"""Regression tests for the clobbered-manifest self-heal.

A partial write (e.g. an archive/pause that wrote a record-summary back over
``skill_versions.manifest_json``) can drop a worker's parsed contract
(``exec``/``title``/``version``/``trigger``), leaving only state fields plus
``_files``. The read path then fails strict parse and degrades to an empty
``python``/``run.py`` stub — so a skill/agent worker silently runs and produces
nothing. ``_heal_manifest_contract`` reconstructs the contract from
``_files['worker.yml']`` (which still holds the real recipe) so the worker
resolves correctly instead of degrading. (morning-brief was the live casualty.)
"""

from __future__ import annotations

import json

import apps.api.db.supabase_repos as sr
from apps.api.db.supabase_repos import _heal_manifest_contract, _worker_record_from_rows

# A valid skill/e2b recipe — what _files['worker.yml'] should contain.
_RECIPE_YML = """schema_version: "0.3"
name: "heal-test"
title: "Heal Test"
description: "recipe from worker.yml"
version: "0.1.0"
targets: ["generic"]
exec:
  entry: "SKILL.md"
  runtime: "skill"
  runner: "e2b"
inputs: []
outputs: []
trigger:
  type: manual
"""

_FILES = {
    "worker.yml": _RECIPE_YML,
    "SKILL.md": "You are a test assistant.",
    "run.py": "def run(inputs, context=None):\n    return {}\n",
}

# What a clobbered manifest_json looks like in the wild: contract gone, only
# state flags + _files remain (the morning-brief shape).
_CLOBBERED = {
    "name": "heal-test",
    "paused": True,
    "enabled": True,
    "description": "stale summary description",
    "archive_reason": None,
    "_files": _FILES,
}


def test_heal_reconstructs_clobbered_contract():
    healed = _heal_manifest_contract(dict(_CLOBBERED), worker_id="heal-test")
    # Contract fields recovered from worker.yml.
    assert healed.get("exec", {}).get("entry") == "SKILL.md"
    assert healed.get("title") == "Heal Test"
    assert healed.get("version") == "0.1.0"
    assert healed.get("schema_version") == "0.3"
    # _files preserved, and runtime state flags carried over.
    assert healed.get("_files") == _FILES
    assert healed.get("paused") is True
    assert healed.get("enabled") is True


def test_heal_is_noop_for_healthy_manifest():
    healthy = {"name": "ok", "exec": {"entry": "run.py"}, "title": "OK", "_files": _FILES}
    assert _heal_manifest_contract(dict(healthy)) == healthy


def test_heal_is_noop_without_worker_yml():
    # Contract-less AND no recipe to recover from -> unchanged (still degrades,
    # but loudly — there is genuinely nothing to heal).
    no_recipe = {"name": "x", "paused": True, "_files": {"run.py": "..."}}
    assert _heal_manifest_contract(dict(no_recipe)) == no_recipe
    assert _heal_manifest_contract({"name": "x"}) == {"name": "x"}


def test_heal_handles_non_dict_input():
    assert _heal_manifest_contract(None) is None
    assert _heal_manifest_contract("not a dict") == "not a dict"


def test_worker_record_resolves_real_recipe_not_python_stub():
    """End-to-end: a clobbered skill_version row must resolve to the real
    skill/e2b runtime, NOT the degraded {type: python, run.py} stub."""
    worker_row = {
        "id": "heal-test",
        "name": "Heal Test",
        "trigger_type": "manual",
        "skill_version_id": "sv_heal-test_0_1_0",
    }
    skill_version_row = {
        "id": "sv_heal-test_0_1_0",
        "manifest_json": json.dumps(_CLOBBERED),
        "bundle_path": "workers/heal-test",
    }
    record = _worker_record_from_rows(worker_row, skill_version_row)
    # Heal restored the real recipe into the record's manifest, so a later
    # archive/update reads the full manifest and can't re-clobber it.
    assert record["manifest"].get("exec", {}).get("entry") == "SKILL.md"
    assert record["manifest"].get("title") == "Heal Test"
    # The resolved config is the real recipe, NOT the degraded python/run.py stub
    # (the stub's signature is type=python + entrypoint=run.py).
    runtime = (record.get("config") or {}).get("runtime") or {}
    assert not (runtime.get("type") == "python" and runtime.get("entrypoint") == "run.py"), record["config"]


def test_config_from_manifest_degrades_without_heal():
    """Guard: confirm the bug exists without the heal — a contract-less manifest
    (no _files) still degrades to the python stub, proving the heal is what
    rescues the _files case above (not some unrelated leniency)."""
    cfg = sr._config_from_manifest(
        worker_id="bare",
        manifest_json={"name": "bare"},
        trigger_type="manual",
        cron_expr=None,
        cron_timezone=None,
        bundle_path=None,
    )
    rt = cfg.runtime
    assert rt is not None
    # Degraded stub signature: type=python + entrypoint=run.py (the default
    # runner happens to be e2b, which is exactly why runner can't be the test).
    assert rt.type == "python" and rt.entrypoint == "run.py"
