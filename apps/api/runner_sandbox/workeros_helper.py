"""workeros_helper.py — source of the workeros.py module written into sandbox PYTHONPATH.

The string WORKEROS_PY_CONTENT is written to a temp dir before a run.py worker
subprocess starts, making `from workeros import call_worker` available to the script.
"""

WORKEROS_PY_CONTENT = '''"""WorkerOS stdlib for run.py workers.

Usage inside run.py:
    from workeros import call_worker, llm_chat, embed

    result = call_worker("my-other-worker", {"input_field": "value"})
    print(result["output_field"])

    judged = llm_chat([
        {"role": "user", "content": "Score this candidate..."}
    ])

call_worker() blocks until the child run completes and returns its output dict.
"""
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.request

_API_URL = os.environ.get("WORKEROS_API_URL", "").rstrip("/")
_RUN_TOKEN = os.environ.get("WORKEROS_RUN_TOKEN", "")
_CALL_DEPTH = int(os.environ.get("WORKEROS_CALL_DEPTH", "0"))
_MAX_DEPTH = 3


def _platform_headers() -> dict:
    if not _RUN_TOKEN:
        raise RuntimeError("WORKEROS_RUN_TOKEN must be set")
    if _RUN_TOKEN.startswith("wrt_"):
        return {
            "Authorization": f"Bearer {_RUN_TOKEN}",
            "Content-Type": "application/json",
        }
    return {
        "X-Workeros-Run-Token": _RUN_TOKEN,
        "Content-Type": "application/json",
    }


def _post_json(path: str, body: dict, *, timeout: int = 120) -> dict:
    if not _API_URL:
        raise RuntimeError("WORKEROS_API_URL must be set")
    req = urllib.request.Request(
        f"{_API_URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers=_platform_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"workeros platform call failed: HTTP {exc.code} - {detail}") from exc


def llm_chat(messages: list, *, model: str | None = None, timeout: int = 120, **kwargs) -> dict:
    """Call the workspace-managed chat model using this run's scoped token.

    Provider credentials stay in the WorkerOS API; the sandbox only sends its
    run token. The request is OpenAI chat-completions shaped.
    """
    run_id = os.environ.get("FLOOM_RUN_ID", "")
    if not run_id:
        raise RuntimeError("FLOOM_RUN_ID must be set")
    body = {"messages": messages, **kwargs}
    if model:
        body["model"] = model
    return _post_json(f"/runs/{run_id}/llm", body, timeout=timeout)


def llm_chat_batch(requests: list, *, max_parallel: int = 8, timeout: int = 300) -> list:
    """Run many workspace-managed chat calls through the platform batch proxy.

    This is the lightweight fan-out primitive for LLM-heavy workers: it avoids
    starting child worker sandboxes for each scoring/judging sub-task.
    """
    run_id = os.environ.get("FLOOM_RUN_ID", "")
    if not run_id:
        raise RuntimeError("FLOOM_RUN_ID must be set")
    out = _post_json(
        f"/runs/{run_id}/llm/batch",
        {"requests": requests, "max_parallel": max_parallel},
        timeout=timeout,
    )
    return out.get("results", [])


def embed(input, *, model: str | None = None, timeout: int = 120, **kwargs) -> dict:
    """Call the workspace-managed embedding model using this run's scoped token."""
    run_id = os.environ.get("FLOOM_RUN_ID", "")
    if not run_id:
        raise RuntimeError("FLOOM_RUN_ID must be set")
    body = {"input": input, **kwargs}
    if model:
        body["model"] = model
    return _post_json(f"/runs/{run_id}/embeddings", body, timeout=timeout)


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
            f"call_worker: failed to start run for {worker_id!r}: HTTP {exc.code} - {detail}"
        ) from exc

    run_id = run_data.get("run_id")
    if not run_id:
        raise RuntimeError(f"call_worker: API did not return a run_id: {run_data}")

    # 2. Poll until the run reaches a terminal state
    _TERMINAL = {"completed", "failed", "error", "approved", "rejected", "cancelled"}
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
        if status == "pending_approval":
            raise RuntimeError(
                f"call_worker: worker {worker_id!r} run {run_id!r} is awaiting approval; "
                "worker-to-worker calls cannot auto-approve child runs"
            )
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


def call_workers_parallel(calls: list, *, timeout: int = 300, max_workers: int = 8) -> list:
    """Invoke multiple declared workers concurrently and return outputs in order.

    Each item must be {"worker_id": "...", "inputs": {...}}. This preserves
    the existing worker-call authorization/depth model while avoiding a
    sequential call_worker loop in worker code.
    """
    if max_workers < 1:
        raise ValueError("max_workers must be >= 1")

    def _one(call: dict) -> dict:
        worker_id = call.get("worker_id") or call.get("id")
        if not worker_id:
            raise ValueError("each call requires worker_id")
        return call_worker(worker_id, call.get("inputs") or {}, timeout=timeout)

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(calls) or 1)) as pool:
        return list(pool.map(_one, calls))
'''
