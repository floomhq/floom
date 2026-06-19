#!/usr/bin/env python3
"""Smoke a git-backed brain pack in a live Workeros API.

The script creates a disposable worker that:
  1. declares a git-backed brain pack via ``contexts:``,
  2. lists the cloned directory from inside ``run.py``,
  3. fails if the clone did not land in ``context/<name>/``,
  4. and then writes ``result.json`` so the run completes cleanly.

Example:
  python scripts/smoke_git_context_worker.py \
    --api https://localhost:8000 \
    --secret "$FLOOM_SECRET"
"""

from __future__ import annotations

import argparse
import json
import textwrap
import time

import requests


DEFAULT_GIT_REPO = "https://github.com/octocat/Hello-World.git"
DEFAULT_CONTEXT_NAME = "hello-world"


def _headers(secret: str, workspace: str | None) -> dict[str, str]:
    headers = {"x-floom-secret": secret}
    if workspace:
        headers["x-workeros-workspace"] = workspace
    return headers


def _worker_yml(worker_id: str, repo_url: str, context_name: str) -> str:
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: "Git Context Smoke"
        description: "Smoke test for git-backed brain pack staging in E2B."
        version: "0.1.0"
        exec:
          entry: "run.py"
          runtime: "python311"
          runner: "e2b"
          command: "python run.py"
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        contexts:
          - name: "{context_name}"
            source: "git+{repo_url}"
        """
    ).strip() + "\n"


def _run_py(context_name: str) -> str:
    return textwrap.dedent(
        f"""
        from pathlib import Path
        import json

        context_root = Path("context/{context_name}")
        entries = sorted(path.name for path in context_root.iterdir()) if context_root.exists() else []
        if not entries:
            raise RuntimeError("git-backed context did not clone any files")

        with open("result.json", "w", encoding="utf-8") as fh:
            json.dump({{"status": "success", "outputs": {{"entries": entries}}}}, fh)
        """
    ).strip() + "\n"


def _request(session: requests.Session, method: str, api: str, path: str, **kwargs):
    url = f"{api.rstrip('/')}{path}"
    resp = session.request(method, url, timeout=kwargs.pop("timeout", 90), **kwargs)
    resp.raise_for_status()
    return resp


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="https://localhost:8000")
    parser.add_argument("--secret", required=True)
    parser.add_argument("--workspace", default=None)
    parser.add_argument("--repo-url", default=DEFAULT_GIT_REPO)
    parser.add_argument("--context-name", default=DEFAULT_CONTEXT_NAME)
    parser.add_argument("--worker-id", default=None)
    parser.add_argument("--poll-seconds", type=int, default=120)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    args = parser.parse_args()

    worker_id = args.worker_id or f"git-context-smoke-{int(time.time())}"
    headers = _headers(args.secret, args.workspace)
    session = requests.Session()
    session.headers.update(headers)

    created = False
    try:
        create_resp = session.post(
            f"{args.api.rstrip('/')}/workers",
            json={
                "worker_yml": _worker_yml(worker_id, args.repo_url, args.context_name),
                "run_py": _run_py(args.context_name),
            },
            timeout=90,
        )
        create_resp.raise_for_status()
        created = True

        run_resp = session.post(
            f"{args.api.rstrip('/')}/workers/{worker_id}/runs",
            json={"inputs": {}, "trigger_source": "manual"},
            timeout=90,
        )
        run_resp.raise_for_status()
        run_id = run_resp.json().get("run_id")
        if not isinstance(run_id, str) or not run_id:
            raise RuntimeError(f"Run start response did not include run_id: {run_resp.text}")

        deadline = time.monotonic() + args.poll_seconds
        while time.monotonic() < deadline:
            poll = _request(session, "GET", args.api, f"/runs/{run_id}", timeout=90)
            run = poll.json()
            status = str(run.get("status") or "").lower()
            if status in {"completed", "failed", "cancelled", "error", "timeout"}:
                if status != "completed":
                    raise RuntimeError(f"Smoke run ended with status={status}: {json.dumps(run, indent=2)}")
                output = run.get("output") or {}
                entries = output.get("entries") if isinstance(output, dict) else None
                if not isinstance(entries, list) or not entries:
                    raise RuntimeError(f"Git context clone did not surface any files: {json.dumps(run, indent=2)}")
                print(json.dumps({"worker_id": worker_id, "run_id": run_id, "entries": entries}, indent=2))
                return 0
            time.sleep(args.poll_interval)

        raise TimeoutError(f"Run {run_id} did not finish within {args.poll_seconds}s")
    finally:
        if created:
            try:
                session.delete(f"{args.api.rstrip('/')}/workers/{worker_id}", timeout=90)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
