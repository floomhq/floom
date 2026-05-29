"""
outbound-approval-demo: two-phase HITL worker (S47).

Phase 1 (run 1): draft outbound message + emit decision_required.
Phase 2 (run 2): execute the approved message (harmless side-effect).

The side-effect MUST happen exactly once — in run 2 only.
"""

import json
import os
import sys


def main():
    inputs = json.loads(os.environ.get("WORKEROS_INPUTS", "{}"))

    decision = inputs.get("decision")
    approved_output = inputs.get("approved_output")

    # -------------------------------------------------------------------------
    # Phase 2: approval decision received — execute the approved action
    # -------------------------------------------------------------------------
    if decision == "approved":
        # Read the approved output. It may be a dict (JSON) or a bare string.
        if isinstance(approved_output, dict):
            message_text = approved_output.get("text") or json.dumps(approved_output, indent=2)
        elif isinstance(approved_output, str) and approved_output.strip():
            message_text = approved_output
        else:
            # Fallback: use whatever was passed
            message_text = str(approved_output or "(empty)")

        # Side-effect: write to a temp file (harmless, proves it ran exactly once)
        side_effect_path = "/tmp/outbound-approval-demo-sent.txt"
        with open(side_effect_path, "w") as f:
            f.write(message_text)

        result = {
            "status": "success",
            "outputs": {
                "phase": "run-2-execute",
                "message_draft": message_text,
                "side_effect_path": side_effect_path,
            },
        }
        with open("result.json", "w") as f:
            json.dump(result, f)
        print(f"[phase-2] Side-effect written to {side_effect_path}")
        sys.exit(0)

    # -------------------------------------------------------------------------
    # Phase 1: draft the message + emit decision_required (NO side-effect here)
    # -------------------------------------------------------------------------
    prospect_name = inputs.get("prospect_name", "Unknown prospect")
    role = inputs.get("role", "Engineer")

    draft = (
        f"Hi {prospect_name},\n\n"
        f"We noticed you're looking for a {role} and wanted to reach out.\n\n"
        "Our AI workers have already matched three candidates from your network "
        "that fit the profile. Happy to walk you through them in a 15-minute call.\n\n"
        "Best,\nThe Workeros team"
    )

    # Emit decision_required — the API will intercept this and land PENDING_APPROVAL
    result = {
        "status": "success",
        "outputs": {
            "phase": "run-1-propose",
            "message_draft": draft,
        },
        "decision_required": {
            "label": "Approve outbound message before sending",
            "preview": draft,
        },
    }
    with open("result.json", "w") as f:
        json.dump(result, f)

    print("[phase-1] Draft complete — awaiting approval. Side-effect NOT fired.")
    sys.exit(0)


if __name__ == "__main__":
    main()
