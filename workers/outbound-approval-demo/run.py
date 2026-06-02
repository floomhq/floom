"""
outbound-approval-demo: two-phase HITL worker (S47).

Phase 1 (run 1): draft outbound message + emit decision_required (NO side-effect).
Phase 2 (run 2): execute the approved message (the side-effect — recorded once).

The side-effect MUST happen exactly once — in run 2 only.

Workeros passes inputs as an inputs.json FILE in the working dir (the platform
standard), NOT via an env var. The side-effect is recorded as an output field
(`sent: true`) so it is verifiable from the run record — a sandbox-local /tmp
file would be lost when the ephemeral sandbox tears down.
"""

import json
import sys


def _read_inputs():
    try:
        with open("inputs.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _write_result(result):
    with open("result.json", "w") as f:
        json.dump(result, f)


def main():
    inputs = _read_inputs()
    decision = inputs.get("decision")
    approved_output = inputs.get("approved_output")

    # -------------------------------------------------------------------------
    # Phase 2: approval decision received — execute the approved action ONCE
    # -------------------------------------------------------------------------
    if decision == "approved":
        if isinstance(approved_output, dict):
            message_text = approved_output.get("message_draft") or approved_output.get("text") \
                or json.dumps(approved_output, indent=2)
        elif isinstance(approved_output, str) and approved_output.strip():
            message_text = approved_output
        else:
            message_text = str(approved_output or "(empty)")

        # The side-effect. Recorded as an output so it is verifiable from the
        # run record; fires exactly once because run 2 is spawned once per approval.
        _write_result({
            "status": "success",
            "outputs": {
                "phase": "run-2-execute",
                "sent": "true",
                "sent_message": message_text,
            },
        })
        print("[phase-2] Approved message sent. Side-effect fired exactly once.")
        sys.exit(0)

    # -------------------------------------------------------------------------
    # Phase 1: draft the message + emit decision_required (NO side-effect)
    # -------------------------------------------------------------------------
    prospect_name = inputs.get("prospect_name", "Unknown prospect")
    role = inputs.get("role", "Engineer")

    draft = (
        f"Hi {prospect_name},\n\n"
        f"We noticed you're looking for a {role} and wanted to reach out.\n\n"
        "Our AI workers have already matched three candidates from your network "
        "that fit the profile. Happy to walk you through them in a 15-minute call.\n\n"
        "Best,\nThe Floom Workers team"
    )

    _write_result({
        "status": "success",
        "outputs": {
            "phase": "run-1-propose",
            "message_draft": draft,
        },
        "decision_required": {
            "label": "Approve outbound message before sending",
            "preview": draft,
        },
    })
    print("[phase-1] Draft complete — awaiting approval. Side-effect NOT fired.")
    sys.exit(0)


if __name__ == "__main__":
    main()
