"""Batch-7 backend fixes.

#551 — POST /workers/{id}/runs rejects with 422 when required secrets are missing
#561 — RunDetail.input parses run's actual input_json from the DB row (was hardcoded {})

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_batch7_backend.py -v
"""
from pathlib import Path
from tests._api_source import api_source

MAIN_PY = Path(__file__).resolve().parents[1] / "main.py"


# ---------------------------------------------------------------------------
# #551 — HTTP run creation gate for missing secrets
# ---------------------------------------------------------------------------

def test_551_gate_reads_available_secrets():
    """The run creation endpoint must call _available_secret_names_for_user before queuing."""
    src = MAIN_PY.read_text()
    # Find the POST /workers/{worker_id}/runs handler block
    gate_lines = [
        line for line in src.splitlines()
        if "_available_secret_names_for_user" in line and "_run_available_secrets" in line
    ]
    assert len(gate_lines) >= 1, (
        "POST /workers/{id}/runs must call _available_secret_names_for_user "
        "and store result in _run_available_secrets"
    )


def test_551_gate_computes_missing_secrets():
    """The gate must compute which required secrets are absent."""
    src = MAIN_PY.read_text()
    assert "_run_missing_secrets" in src, (
        "main.py must define _run_missing_secrets list in the run creation endpoint"
    )
    missing_lines = [
        line for line in src.splitlines()
        if "_run_missing_secrets" in line and "_run_required_secrets" in line
    ]
    assert len(missing_lines) >= 1, (
        "_run_missing_secrets must be derived from _run_required_secrets"
    )


def test_551_gate_raises_422():
    """A non-empty _run_missing_secrets must raise an HTTPException with status 422."""
    src = MAIN_PY.read_text()
    lines = src.splitlines()
    # Find the conditional check line
    check_indices = [i for i, l in enumerate(lines) if "if _run_missing_secrets:" in l.strip()]
    assert check_indices, "main.py must have 'if _run_missing_secrets:' conditional"
    # Within the next 5 lines after each check, there must be a 422 raise
    found_422 = False
    for idx in check_indices:
        window = "\n".join(lines[idx:idx + 6])
        if "status_code=422" in window or "HTTPException" in window:
            found_422 = True
            break
    assert found_422, (
        "main.py must raise HTTPException(status_code=422) within the if _run_missing_secrets: block"
    )


def test_551_gate_names_missing_secrets_in_detail():
    """The 422 error message must include the specific secret names, not a generic message."""
    src = MAIN_PY.read_text()
    # The detail string should join the missing secret names
    assert "join(_run_missing_secrets)" in src or "', '.join(_run_missing_secrets)" in src, (
        "The 422 error detail must name the specific missing secrets via join"
    )


# ---------------------------------------------------------------------------
# #561 — RunDetail.input populated from input_json DB column
# ---------------------------------------------------------------------------

def test_561_run_detail_parses_input_json():
    """The run detail endpoint must read input_json from the DB row, not return {}."""
    src = api_source()
    # Must reference input_json from the run row
    assert "input_json" in src, (
        "main.py must reference input_json from the DB row"
    )
    input_json_reads = [
        line.strip() for line in src.splitlines()
        if "input_json" in line and ("run.get" in line or 'run["input_json"]' in line or "_raw_input_json" in line)
    ]
    assert len(input_json_reads) >= 1, (
        "RunDetail endpoint must read input_json from the run row dict"
    )


def test_561_run_detail_not_hardcoded_empty():
    """RunDetail constructor must not pass input={} as a literal — must use the parsed variable."""
    src = api_source()
    # Look specifically for `input={}` as a keyword argument (not `run_input = {}`)
    # by checking for the pattern `input={}` where input is a kwarg, not an assignment
    import re
    # Match `input={}` as a keyword argument: preceded by comma/whitespace, not by word chars like run_
    hardcoded_kwarg = re.findall(r'(?<![a-zA-Z_])input\s*=\s*\{\}', src)
    assert hardcoded_kwarg == [], (
        f"RunDetail constructor must not pass input={{}} as a literal keyword argument. "
        f"Found {len(hardcoded_kwarg)} occurrence(s)."
    )


def test_561_run_input_variable_passed_to_rundetail():
    """The parsed run_input variable must be passed to the RunDetail constructor."""
    src = api_source()
    assert "input=run_input" in src, (
        "RunDetail must receive input=run_input (the parsed value), not a literal"
    )
