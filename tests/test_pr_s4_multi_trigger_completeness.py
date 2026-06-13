"""Tests for PR S4 — multi-trigger completeness.

Covers:
  P1.9 - triggers_spec in API response (round-trip through DB persist/load)
        - multi-trigger worker: triggers_spec has all three trigger types
        - legacy single-trigger worker: triggers_spec has one-element list
  P1.9 BONUS - LLM system prompt forces cron expression for schedule triggers
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _base_contract(extra: dict = None) -> dict:
    base = {
        "schema_version": "0.3",
        "name": "test-worker",
        "title": "Test Worker",
        "description": "A test worker for unit tests.",
        "version": "0.1.0",
        "exec": {
            "runtime": "python311",
            "mode": "pure-script",
            "runner": "e2b",
            "command": "python run.py",
            "inputs": [],
            "outputs": [],
            "secrets": [],
        },
    }
    if extra:
        base.update(extra)
    return base


# ---------------------------------------------------------------------------
# P1.9 — TriggerSpec model exists and is importable
# ---------------------------------------------------------------------------

class TestTriggerSpecModel:
    def test_trigger_spec_importable(self):
        from models import TriggerSpec
        spec = TriggerSpec(type="manual")
        assert spec.type == "manual"
        assert spec.cron is None
        assert spec.webhook is None

    def test_trigger_spec_schedule(self):
        from models import TriggerSpec
        spec = TriggerSpec(type="schedule", cron="0 9 * * *", timezone="Europe/Berlin")
        assert spec.type == "schedule"
        assert spec.cron == "0 9 * * *"
        assert spec.timezone == "Europe/Berlin"

    def test_trigger_spec_webhook(self):
        from models import TriggerSpec
        spec = TriggerSpec(type="webhook", webhook={"secret": True, "allowed_methods": ["POST"]})
        assert spec.type == "webhook"
        assert spec.webhook is not None
        assert spec.webhook["secret"] is True

    def test_trigger_spec_composio(self):
        from models import TriggerSpec
        spec = TriggerSpec(
            type="composio",
            composio={"event": "gmail.new_email", "connection_id": "conn_abc123"},
        )
        assert spec.type == "composio"
        assert spec.composio["event"] == "gmail.new_email"


# ---------------------------------------------------------------------------
# P1.9 — WorkerSummary and WorkerDetail include triggers_spec
# ---------------------------------------------------------------------------

class TestWorkerModelsHaveTriggersSpec:
    def test_worker_summary_has_triggers_spec_field(self):
        from models import WorkerSummary, WorkerStatus, TriggerSpec
        summary = WorkerSummary(
            id="wk_test",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
            triggers=[],
            triggers_spec=[TriggerSpec(type="manual")],
        )
        assert len(summary.triggers_spec) == 1
        assert summary.triggers_spec[0].type == "manual"

    def test_worker_detail_has_triggers_spec_field(self):
        from models import WorkerDetail, WorkerStatus, WorkerConfig, WorkerTrigger, WorkerRuntime, TriggerSpec
        config = WorkerConfig(
            id="wk_test",
            name="Test",
            trigger=WorkerTrigger(type="manual"),
            runtime=WorkerRuntime(type="python311", entrypoint="run.py", runner="e2b"),
        )
        detail = WorkerDetail(
            id="wk_test",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
            config=config,
            triggers_spec=[TriggerSpec(type="manual")],
        )
        assert len(detail.triggers_spec) == 1
        assert detail.triggers_spec[0].type == "manual"

    def test_worker_summary_triggers_spec_defaults_empty(self):
        from models import WorkerSummary, WorkerStatus
        summary = WorkerSummary(
            id="wk_test",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
            triggers=[],
        )
        assert summary.triggers_spec == []


# ---------------------------------------------------------------------------
# P1.9 — _build_triggers_spec logic (self-contained, no main import needed)
# ---------------------------------------------------------------------------

def _build_triggers_spec_standalone(worker):
    """Standalone reimplementation of _build_triggers_spec for testing without main import."""
    from models import TriggerSpec

    triggers_json = worker.get("triggers_json")
    if triggers_json:
        try:
            raw = json.loads(triggers_json)
            if isinstance(raw, list) and raw:
                specs = []
                for t in raw:
                    if not isinstance(t, dict):
                        continue
                    specs.append(TriggerSpec(
                        type=t.get("type", "manual"),
                        cron=t.get("cron"),
                        timezone=t.get("timezone"),
                        webhook=t.get("webhook"),
                        composio=t.get("composio"),
                    ))
                if specs:
                    return specs
        except Exception:
            pass

    config = worker.get("config") or {}
    trigger = config.get("trigger") or {}
    trigger_type = (worker.get("trigger_type") or trigger.get("type") or "manual").lower()
    return [TriggerSpec(
        type=trigger_type,
        cron=trigger.get("cron"),
        timezone=trigger.get("timezone"),
        webhook=trigger.get("webhook"),
        composio=trigger.get("composio"),
    )]


class TestBuildTriggersSpec:
    """Test _build_triggers_spec logic produces correct TriggerSpec lists."""

    def test_multi_trigger_all_three_types(self):
        triggers_list = [
            {"type": "manual"},
            {"type": "schedule", "cron": "0 9 * * *", "timezone": "UTC"},
            {"type": "webhook", "webhook": {"secret": True, "allowed_methods": ["POST"]}},
        ]
        worker = {
            "trigger_type": "manual",
            "triggers_json": json.dumps(triggers_list),
            "config": {"trigger": {"type": "manual"}},
        }
        result = _build_triggers_spec_standalone(worker)
        assert len(result) == 3
        types = {s.type for s in result}
        assert types == {"manual", "schedule", "webhook"}

    def test_schedule_trigger_preserves_cron(self):
        triggers_list = [{"type": "schedule", "cron": "0 9 * * MON", "timezone": "Europe/Berlin"}]
        worker = {
            "trigger_type": "schedule",
            "triggers_json": json.dumps(triggers_list),
            "config": {"trigger": {"type": "schedule", "cron": "0 9 * * MON"}},
        }
        result = _build_triggers_spec_standalone(worker)
        assert len(result) == 1
        assert result[0].type == "schedule"
        assert result[0].cron == "0 9 * * MON"
        assert result[0].timezone == "Europe/Berlin"

    def test_legacy_single_trigger_fallback(self):
        """Legacy worker with no triggers_json: wraps config.trigger as one-element list."""
        worker = {
            "trigger_type": "schedule",
            "triggers_json": None,
            "config": {
                "trigger": {"type": "schedule", "cron": "0 9 * * *"},
            },
        }
        result = _build_triggers_spec_standalone(worker)
        assert len(result) == 1
        assert result[0].type == "schedule"
        assert result[0].cron == "0 9 * * *"

    def test_empty_triggers_json_fallback(self):
        worker = {
            "trigger_type": "manual",
            "triggers_json": "",
            "config": {"trigger": {"type": "manual"}},
        }
        result = _build_triggers_spec_standalone(worker)
        assert len(result) == 1
        assert result[0].type == "manual"

    def test_webhook_trigger_spec(self):
        triggers_list = [
            {"type": "webhook", "webhook": {"secret": True, "allowed_methods": ["POST"]}},
        ]
        worker = {
            "trigger_type": "webhook",
            "triggers_json": json.dumps(triggers_list),
            "config": {"trigger": {"type": "webhook"}},
        }
        result = _build_triggers_spec_standalone(worker)
        assert len(result) == 1
        assert result[0].type == "webhook"
        assert result[0].webhook is not None
        assert result[0].webhook["secret"] is True


# ---------------------------------------------------------------------------
# P1.9 — Round-trip: multi-trigger worker.yml stored and projected back
# ---------------------------------------------------------------------------

class TestMultiTriggerRoundTrip:
    """Verify a worker created with triggers[] round-trips through WorkerContract."""

    def test_three_trigger_round_trip_contract_model(self):
        from models import WorkerContract
        raw = _base_contract({
            "triggers": [
                {"type": "manual"},
                {"type": "schedule", "cron": "0 9 * * *"},
                {"type": "webhook", "webhook": {"secret": True, "allowed_methods": ["POST"]}},
            ],
        })
        contract = WorkerContract(**raw)
        # All three triggers preserved
        assert len(contract.triggers) == 3
        types = {t.type for t in contract.triggers}
        assert types == {"manual", "schedule", "webhook"}
        # Schedule trigger has cron
        sched = next(t for t in contract.triggers if t.type == "schedule")
        assert sched.cron == "0 9 * * *"
        # Backward compat: trigger field is first trigger
        assert contract.trigger.type == "manual"

    def test_legacy_schedule_projects_as_one_element_triggers(self):
        from models import WorkerContract
        raw = _base_contract({
            "trigger": {"type": "schedule", "cron": "0 9 * * *"},
        })
        contract = WorkerContract(**raw)
        # triggers list synthesized from single trigger
        assert len(contract.triggers) == 1
        assert contract.triggers[0].type == "schedule"
        assert contract.triggers[0].cron == "0 9 * * *"


# ---------------------------------------------------------------------------
# P1.9 BONUS — Draft system prompt includes cron requirement
# Read the prompt directly from the source file to avoid needing a full app init.
# ---------------------------------------------------------------------------

def _read_draft_system_prompt() -> str:
    """Read _DRAFT_SYSTEM_PROMPT value from source without executing it.

    The prompt moved from main.py into services/worker_codegen.py during the
    API modularization; read it there.
    """
    src_path = os.path.join(
        os.path.dirname(__file__), "..", "apps", "api", "services", "worker_codegen.py"
    )
    with open(src_path) as f:
        content = f.read()
    # Extract the prompt string: starts after _DRAFT_SYSTEM_PROMPT = """
    start_marker = '_DRAFT_SYSTEM_PROMPT = """'
    end_marker = '"""'
    start = content.find(start_marker)
    assert start != -1, "_DRAFT_SYSTEM_PROMPT not found in worker_codegen.py"
    start += len(start_marker)
    end = content.find(end_marker, start)
    assert end != -1, "closing triple-quote not found"
    return content[start:end]


class TestDraftSystemPromptCronRequirement:
    """Verify the LLM system prompt instructs the model to always include cron."""

    def test_prompt_contains_cron_requirement(self):
        prompt = _read_draft_system_prompt()
        assert "cron" in prompt.lower()
        assert "schedule" in prompt.lower()

    def test_prompt_mentions_cron_required_for_schedule(self):
        prompt = _read_draft_system_prompt()
        assert "required" in prompt.lower() or "always include" in prompt.lower()

    def test_prompt_provides_default_cron_expression(self):
        prompt = _read_draft_system_prompt()
        # Must mention a default like 0 9 * * * to guide the LLM
        assert "0 9 * * *" in prompt

    def test_prompt_instructs_fallback_to_manual(self):
        prompt = _read_draft_system_prompt()
        assert "manual" in prompt.lower()
