"""Regression tests for hosted issue #418 — approvals.required must gate side effects.

The two-phase HITL contract:
  Phase 1 (propose): worker runs, drafts the action, emits decision_required,
    fires NO side effect. The engine MUST hand the worker an authoritative
    `decision: "proposed"` so the worker branches deterministically (never on
    the mere absence of a key, which a misbehaving worker ignores).
  Phase 2 (execute): on approval the engine spawns a follow-up run with
    `decision: "approved"`. The side effect fires EXACTLY ONCE.

#418 proved (live on hosted platform) that the side effect ran BEFORE approval AND
AGAIN on approval. These tests pin the engine-side guarantees:
  (a) no side effect (and decision == "proposed") before approval;
  (b) exactly one execution (decision == "approved") after approval;
  (c) rejection runs the side effect zero times;
  (d) the no-approval-required path is unaffected (worker runs once, normally).

Run:
    cd apps/api && python3 -m pytest ../../tests/test_418_approval_gate.py -v
"""

import json
import os
import sys
import tempfile
import unittest
import uuid as _uuid_mod
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)
os.environ.setdefault("FLOOM_RUN_TIMEOUT", "5")

import db  # noqa: E402
db.DB_PATH = _tmp_db.name

import main as app_module  # noqa: E402
import run_service  # noqa: E402
from models import WorkerResult  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app, raise_server_exceptions=True)

_RUN_PY = "# placeholder\ndef run(context): return {}\n"


def _worker_yml(name: str, *, approvals_required: bool) -> str:
    req = "true" if approvals_required else "false"
    return f"""schema_version: "0.3"
name: {name}
title: Test Worker {name}
description: Auto-generated test worker for #418 gate tests.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs: []
approvals:
  required: {req}
trigger:
  type: manual
"""


def _create_worker(*, approvals_required: bool) -> dict:
    name = f"t418-{_uuid_mod.uuid4().hex[:8]}"
    r = client.post(
        "/workers",
        json={"worker_yml": _worker_yml(name, approvals_required=approvals_required), "run_py": _RUN_PY},
    )
    assert r.status_code == 200, f"create_worker failed {r.status_code}: {r.text}"
    return r.json()


class _RecordingDriver:
    """Fake driver that records every `decision` it is handed and fires a
    side-effect marker only when the worker WOULD act (decision == approved).

    This mirrors a CORRECT two-phase worker: it acts iff decision == "approved".
    The engine-side guarantee under test is WHICH decision the engine hands the
    worker in each phase — that is what makes the worker's branch trustworthy.
    """

    def __init__(self, side_effects: list, decisions: list):
        self._side_effects = side_effects
        self._decisions = decisions

    def run(self, **kwargs):
        inputs = kwargs.get("inputs") or {}
        decision = inputs.get("decision")
        self._decisions.append(decision)
        if decision == "approved":
            # The side effect — fires only when the engine authorised execution.
            self._side_effects.append(kwargs.get("run_id"))
            return WorkerResult(
                status="success",
                outputs={"sent": "true", "approved_output": inputs.get("approved_output")},
            )
        # Propose phase: draft + request approval, NO side effect.
        return WorkerResult(
            status="success",
            outputs={"message_draft": "hello"},
            decision_required={"label": "Approve outbound message", "preview": "hello"},
        )


class Test418ApprovalGate(unittest.TestCase):
    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    # -- (a) no side effect before approval; engine hands decision=="proposed" --
    def test_phase1_no_side_effect_and_decision_is_proposed(self):
        worker = _create_worker(approvals_required=True)
        run_id = run_service.create_run(worker["id"], {})
        side_effects: list = []
        decisions: list = []

        with patch.object(
            run_service, "get_sandbox_driver",
            return_value=_RecordingDriver(side_effects, decisions),
        ):
            run_service.execute_run(run_id, worker["id"], {})

        # No side effect fired pre-approval.
        self.assertEqual(side_effects, [], "side effect fired before approval")
        # The engine handed the worker an explicit propose-phase signal.
        self.assertEqual(decisions, ["proposed"])

        # Run is parked awaiting approval, approval row pending.
        from db import get_db
        with get_db() as conn:
            run_row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
            apr_row = conn.execute("SELECT status FROM approvals WHERE run_id = ?", (run_id,)).fetchone()
        self.assertEqual(run_row["status"], "pending_approval")
        self.assertEqual(apr_row["status"], "pending")

    # -- (b) exactly one execution after approval; engine hands decision=="approved" --
    def test_phase2_executes_exactly_once_after_approval(self):
        worker = _create_worker(approvals_required=True)
        run_id = run_service.create_run(worker["id"], {})
        side_effects: list = []
        decisions: list = []
        driver = _RecordingDriver(side_effects, decisions)

        with patch.object(run_service, "get_sandbox_driver", return_value=driver):
            run_service.execute_run(run_id, worker["id"], {})
            self.assertEqual(side_effects, [])  # phase 1 fired nothing

            # Approve -> spawns the follow-up run, which the test client runs inline.
            r = client.post(f"/runs/{run_id}/approve")
            self.assertEqual(r.status_code, 200, r.text)
            follow_up_run_id = r.json()["run_id"]
            self.assertNotEqual(follow_up_run_id, run_id)

            # Drive the follow-up run (the drain loop is not active under TestClient).
            run_service.execute_run(follow_up_run_id, worker["id"], {})

        # Exactly one side effect, and it was the follow-up run.
        self.assertEqual(side_effects, [follow_up_run_id])
        # The engine handed propose then approved.
        self.assertEqual(decisions, ["proposed", "approved"])

        from db import get_db
        with get_db() as conn:
            fu_row = conn.execute("SELECT status FROM runs WHERE id = ?", (follow_up_run_id,)).fetchone()
        self.assertEqual(fu_row["status"], "completed")

    def test_phase1_withholds_secrets_until_approved_follow_up(self):
        worker = _create_worker(approvals_required=True)
        run_id = run_service.create_run(worker["id"], {})
        side_effects: list = []
        decisions: list = []
        seen_secrets: list = []

        class SecretRecordingDriver(_RecordingDriver):
            def run(self, **kwargs):
                seen_secrets.append(dict(kwargs.get("secrets") or {}))
                return super().run(**kwargs)

        driver = SecretRecordingDriver(side_effects, decisions)
        with (
            patch.object(run_service, "get_sandbox_driver", return_value=driver),
            patch.object(run_service, "get_secrets_for_worker", return_value={"API_KEY": "sekret"}) as get_secrets,
        ):
            run_service.execute_run(run_id, worker["id"], {})
            r = client.post(f"/runs/{run_id}/approve")
            self.assertEqual(r.status_code, 200, r.text)
            follow_up_run_id = r.json()["run_id"]
            run_service.execute_run(follow_up_run_id, worker["id"], {})

        self.assertEqual(decisions, ["proposed", "approved"])
        self.assertEqual(seen_secrets, [{}, {"API_KEY": "sekret"}])
        self.assertEqual(get_secrets.call_count, 1)

    # -- (c) rejection runs the side effect zero times --
    def test_rejection_runs_side_effect_zero_times(self):
        worker = _create_worker(approvals_required=True)
        run_id = run_service.create_run(worker["id"], {})
        side_effects: list = []
        decisions: list = []

        with patch.object(
            run_service, "get_sandbox_driver",
            return_value=_RecordingDriver(side_effects, decisions),
        ):
            run_service.execute_run(run_id, worker["id"], {})
            r = client.post(f"/runs/{run_id}/reject", json={"reason": "no"})
            self.assertEqual(r.status_code, 200, r.text)

        self.assertEqual(side_effects, [], "side effect fired despite rejection")
        self.assertEqual(decisions, ["proposed"])

        from db import get_db
        with get_db() as conn:
            apr_row = conn.execute("SELECT status, follow_up_run_id FROM approvals WHERE run_id = ?", (run_id,)).fetchone()
        self.assertEqual(apr_row["status"], "rejected")
        self.assertIsNone(apr_row["follow_up_run_id"])

    # -- (d) no-approval-required path unaffected: one run, fires once, no inject --
    def test_no_approval_path_unaffected(self):
        worker = _create_worker(approvals_required=False)
        run_id = run_service.create_run(worker["id"], {})
        decisions: list = []

        class PlainDriver:
            def run(self, **kwargs):
                decisions.append((kwargs.get("inputs") or {}).get("decision"))
                return WorkerResult(status="success", outputs={"ok": "true"})

        with patch.object(run_service, "get_sandbox_driver", return_value=PlainDriver()):
            run_service.execute_run(run_id, worker["id"], {})

        # Engine did NOT inject a phase decision for a non-approval worker.
        self.assertEqual(decisions, [None])
        from db import get_db
        with get_db() as conn:
            run_row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
        self.assertEqual(run_row["status"], "completed")

    # -- (e) anti-spoof: a manual run that arrives with decision=="approved" but
    #        is NOT an engine-approved follow-up must be forced back to "proposed"
    #        so a caller cannot bypass the gate by self-asserting approval.
    def test_manual_approved_input_cannot_bypass_gate(self):
        worker = _create_worker(approvals_required=True)
        run_id = run_service.create_run(
            worker["id"], {"decision": "approved", "approved_output": {"x": 1}}
        )
        side_effects: list = []
        decisions: list = []

        with patch.object(
            run_service, "get_sandbox_driver",
            return_value=_RecordingDriver(side_effects, decisions),
        ):
            run_service.execute_run(
                run_id, worker["id"], {"decision": "approved", "approved_output": {"x": 1}}
            )

        # The spoofed approval was overridden -> propose phase, no side effect.
        self.assertEqual(decisions, ["proposed"])
        self.assertEqual(side_effects, [])
        from db import get_db
        with get_db() as conn:
            run_row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
        self.assertEqual(run_row["status"], "pending_approval")

    # -- (f) anti-spoof: trigger_source="approval" on a FRESH run must NOT
    #        suppress the (synthetic) gate. The phase is resolved from the
    #        approvals table, not the caller-controllable trigger_source.
    def test_trigger_source_approval_cannot_suppress_gate(self):
        worker = _create_worker(approvals_required=True)
        # A worker that emits NO decision_required -> the engine synthesises the
        # gate from the manifest flag. A spoofed trigger_source must not skip it.
        run_id = run_service.create_run(worker["id"], {}, trigger_source="approval")
        side_effects: list = []

        class NoDecisionDriver:
            def run(self, **kwargs):
                if (kwargs.get("inputs") or {}).get("decision") == "approved":
                    side_effects.append(kwargs.get("run_id"))
                return WorkerResult(status="success", outputs={"done": "true"})

        with patch.object(run_service, "get_sandbox_driver", return_value=NoDecisionDriver()):
            run_service.execute_run(run_id, worker["id"], {})

        self.assertEqual(side_effects, [])
        from db import get_db
        with get_db() as conn:
            run_row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
            apr_row = conn.execute("SELECT status FROM approvals WHERE run_id = ?", (run_id,)).fetchone()
        self.assertEqual(run_row["status"], "pending_approval")
        self.assertIsNotNone(apr_row)
        self.assertEqual(apr_row["status"], "pending")

    # -- (g) exactly-once hardening: if the worker mistakenly re-emits
    #        decision_required in the EXECUTE phase, the engine must NOT re-gate
    #        (which would spawn a 2nd approval + follow-up and double-fire).
    def test_execute_phase_decision_required_does_not_regate(self):
        worker = _create_worker(approvals_required=True)
        run_id = run_service.create_run(worker["id"], {})
        side_effects: list = []
        decisions: list = []

        class ReGatingDriver:
            """Acts on approved AND re-emits decision_required every run."""

            def run(self, **kwargs):
                inputs = kwargs.get("inputs") or {}
                decision = inputs.get("decision")
                decisions.append(decision)
                if decision == "approved":
                    side_effects.append(kwargs.get("run_id"))
                return WorkerResult(
                    status="success",
                    outputs={"x": "y"},
                    decision_required={"label": "Approve", "preview": "x"},
                )

        with patch.object(run_service, "get_sandbox_driver", return_value=ReGatingDriver()):
            run_service.execute_run(run_id, worker["id"], {})  # phase 1 -> pending
            r = client.post(f"/runs/{run_id}/approve")
            self.assertEqual(r.status_code, 200, r.text)
            follow_up_run_id = r.json()["run_id"]
            run_service.execute_run(follow_up_run_id, worker["id"], {})  # execute phase

        # Side effect fired exactly once (the execute run); no second approval.
        self.assertEqual(side_effects, [follow_up_run_id])
        self.assertEqual(decisions, ["proposed", "approved"])
        from db import get_db
        with get_db() as conn:
            fu_row = conn.execute("SELECT status FROM runs WHERE id = ?", (follow_up_run_id,)).fetchone()
            apr_count = conn.execute("SELECT COUNT(*) AS c FROM approvals").fetchone()["c"]
        self.assertEqual(fu_row["status"], "completed")
        # Exactly one approval row total (the original) — execute did not re-gate.
        self.assertEqual(apr_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
