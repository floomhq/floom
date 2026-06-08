"""workeros_helper.py — source of the workeros.py module written into sandbox PYTHONPATH.

The string WORKEROS_PY_CONTENT is written to a temp dir before a run.py worker
subprocess starts, making `from workeros import call_worker` available to the script.
"""

WORKEROS_PY_CONTENT = '''"""WorkerOS stdlib for run.py workers.

Usage inside run.py:
    from workeros import call_worker

    result = call_worker("my-other-worker", {"input_field": "value"})
    print(result["output_field"])

call_worker() blocks until the child run completes and returns its output dict.
"""
import json
import os
import time
import urllib.error
import urllib.request

_API_URL = os.environ.get("WORKEROS_API_URL", "").rstrip("/")
_RUN_TOKEN = os.environ.get("WORKEROS_RUN_TOKEN", "")
_CALL_DEPTH = int(os.environ.get("WORKEROS_CALL_DEPTH", "0"))
_MAX_DEPTH = 3


def call_worker(worker_id: str, inputs: dict, *, timeout: int = 300) -> dict:
    """Invoke another worker synchronously and return its output dict.

    Args:
        worker_id: ID of the worker to invoke (must be in this worker\'s calls: list).
        inputs:    Input values matching the target worker\'s declared inputs.
        timeout:   Maximum seconds to wait for the child run to complete.

    Returns:
        The child run\'s output dict (keys match the target worker\'s outputs).

    Raises:
        RuntimeError: if the environment is not configured, depth is exceeded,
                      or the child run ends in a non-completed state.
        TimeoutError: if the child run does not complete within `timeout` seconds.
    """
    if not _API_URL or not _RUN_TOKEN:
        raise RuntimeError(
            "call_worker: WORKEROS_API_URL and WORKEROS_RUN_TOKEN must be set. "
            "Ensure the worker.yml declares the calls: field."
        )
    if _CALL_DEPTH >= _MAX_DEPTH:
        raise RuntimeError(
            f"call_worker: maximum call depth ({_MAX_DEPTH}) exceeded"
        )

    _headers = {
        "Authorization": f"Bearer {_RUN_TOKEN}",
        "Content-Type": "application/json",
    }

    # 1. Trigger the run
    body = json.dumps({"inputs": inputs, "trigger_source": "worker_call"}).encode("utf-8")
    req = urllib.request.Request(
        f"{_API_URL}/workers/{worker_id}/runs",
        data=body,
        headers=_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            run_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"call_worker: failed to start run for {worker_id!r}: HTTP {exc.code} — {detail}"
        ) from exc

    run_id = run_data.get("run_id")
    if not run_id:
        raise RuntimeError(f"call_worker: API did not return a run_id: {run_data}")

    # 2. Poll until the run reaches a terminal state
    _TERMINAL = {"completed", "failed", "error"}
    deadline = time.monotonic() + timeout
    poll_interval = 1.0

    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"call_worker: worker {worker_id!r} run {run_id!r} "
                f"did not complete within {timeout}s"
            )

        poll_req = urllib.request.Request(
            f"{_API_URL}/runs/{run_id}",
            headers=_headers,
        )
        try:
            with urllib.request.urlopen(poll_req, timeout=30) as resp:
                row = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"call_worker: failed to poll run {run_id!r}: HTTP {exc.code}"
            ) from exc

        status = row.get("status", "")
        if status in _TERMINAL:
            if status != "completed":
                err = row.get("error") or status
                raise RuntimeError(
                    f"call_worker: worker {worker_id!r} run {run_id!r} "
                    f"ended with status {status!r}: {err}"
                )
            return row.get("output") or {}

        time.sleep(min(poll_interval, deadline - time.monotonic()))
        poll_interval = min(poll_interval * 1.5, 5.0)
'''
