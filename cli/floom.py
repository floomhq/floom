#!/usr/bin/env python3
"""floom — minimal CLI for Workeros / Workeros.

Commands:
  floom dev           Start API + web dev servers concurrently
  floom reload        POST /workers/reload against FLOOM_API_BASE
  floom run <id>      POST /workers/<id>/runs, poll, print output
  floom worker create <id>  Scaffold a new worker directory

Configuration (env vars):
  FLOOM_API_BASE    Base URL (default: http://localhost:8000)
  FLOOM_API_SECRET  x-floom-secret header value (optional)
"""

import json
import os
import sys
import time
import subprocess
import threading
from pathlib import Path

try:
    import click
    import requests
except ImportError:
    # Bootstrap install if missing
    subprocess.check_call([sys.executable, "-m", "pip", "install", "click", "requests", "-q"])
    import click
    import requests

# #598: support both FLOOM_API_TOKEN (PAT / bearer token, preferred for
# multi-member installs) and FLOOM_API_SECRET (shared secret, single-tenant).
# Token takes precedence when both are set. FLOOM_API_BASE is respected for
# pointing the CLI at a non-default server (e.g. localhost during dev).
API_BASE = os.environ.get("FLOOM_API_BASE", "http://localhost:8000")
API_TOKEN = os.environ.get("FLOOM_API_TOKEN", "")
API_SECRET = os.environ.get("FLOOM_API_SECRET", "")

REPO_ROOT = Path(__file__).resolve().parent.parent


def _headers() -> dict:
    h = {"Content-Type": "application/json"}
    if API_TOKEN:
        h["Authorization"] = f"Bearer {API_TOKEN}"
    elif API_SECRET:
        h["x-floom-secret"] = API_SECRET
    return h


def _api(method: str, path: str, **kwargs) -> requests.Response:
    url = f"{API_BASE}{path}"
    kwargs.setdefault("headers", {}).update(_headers())
    return getattr(requests, method)(url, **kwargs)


# ---------------------------------------------------------------------------
# CLI group
# ---------------------------------------------------------------------------

@click.group()
@click.option("--secret", envvar="FLOOM_API_SECRET", default="", help="x-floom-secret header value (or set FLOOM_API_SECRET)")
@click.option("--token", envvar="FLOOM_API_TOKEN", default="", help="Bearer token / PAT (or set FLOOM_API_TOKEN)")
@click.option("--api-base", envvar="FLOOM_API_BASE", default="http://localhost:8000", help="API base URL")
@click.pass_context
def cli(ctx: click.Context, secret: str, token: str, api_base: str):
    """floom — Workeros operator CLI."""
    # #598: allow --secret / --token flags to override env vars at call time
    ctx.ensure_object(dict)
    if secret:
        ctx.obj["secret"] = secret
    if token:
        ctx.obj["token"] = token
    if api_base:
        ctx.obj["api_base"] = api_base


# ---------------------------------------------------------------------------
# floom dev
# ---------------------------------------------------------------------------

@cli.command()
def dev():
    """Start API (uvicorn :8000) and web (next dev :3000) concurrently."""
    api_dir = REPO_ROOT / "apps" / "api"
    web_dir = REPO_ROOT / "apps" / "web"

    # Security warning: dev mode binds 0.0.0.0 and may run without FLOOM_SECRET.
    env_file = api_dir / ".env"
    env_text = env_file.read_text(encoding="utf-8", errors="ignore") if env_file.exists() else ""
    has_secret = any(
        line.strip().startswith("FLOOM_SECRET=") and not line.strip().startswith("#")
        and len(line.strip()[len("FLOOM_SECRET="):].strip()) > 0
        for line in env_text.splitlines()
    )
    if not has_secret:
        click.secho("", fg="yellow")
        click.secho("  WARNING: workeros dev mode is starting WITHOUT FLOOM_SECRET set.", fg="yellow", bold=True)
        click.secho("  Any request that reaches the API will be accepted.", fg="yellow")
        click.secho("  Workers with runner: local run in-process and have full host access.", fg="yellow")
        click.secho("  Set FLOOM_SECRET in apps/api/.env before exposing this beyond localhost.", fg="yellow")
        click.secho("", fg="yellow")

    venv_python = api_dir / "venv" / "bin" / "python"
    python_exec = str(venv_python) if venv_python.exists() else sys.executable

    api_cmd = [python_exec, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
    web_cmd = ["npm", "run", "dev"]

    click.echo(f"Starting API  : {' '.join(api_cmd[:3])} ... (in {api_dir})")
    click.echo(f"Starting Web  : {' '.join(web_cmd)} (in {web_dir})")
    click.echo("Press Ctrl+C to stop both.\n")

    procs = []
    try:
        procs.append(subprocess.Popen(api_cmd, cwd=str(api_dir)))
        procs.append(subprocess.Popen(web_cmd, cwd=str(web_dir)))
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        click.echo("\nStopping...")
        for p in procs:
            p.terminate()


# ---------------------------------------------------------------------------
# floom reload
# ---------------------------------------------------------------------------

@cli.command()
def reload():
    """POST /workers/reload — reload all workers from disk."""
    try:
        r = _api("post", "/workers/reload")
        r.raise_for_status()
        data = r.json()
        click.echo(f"Reloaded: {data.get('workers_loaded', '?')} workers")
    except requests.RequestException as exc:
        click.echo(f"Error: {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# floom run <worker_id>
# ---------------------------------------------------------------------------

@cli.command(name="run")
@click.argument("worker_id")
@click.option("--input", "input_file", default=None, help="Path to JSON input file")
@click.option("--poll-interval", default=2, show_default=True, help="Seconds between polls")
@click.option("--timeout", default=120, show_default=True, help="Max seconds to wait")
def run_worker(worker_id: str, input_file: str | None, poll_interval: int, timeout: int):
    """POST /workers/<worker_id>/runs, poll until done, print output."""
    inputs: dict = {}
    if input_file:
        with open(input_file) as f:
            inputs = json.load(f)

    try:
        r = _api("post", f"/workers/{worker_id}/runs", json={
            "inputs": inputs,
            "trigger_source": "cli",
        })
        r.raise_for_status()
    except requests.RequestException as exc:
        click.echo(f"Failed to start run: {exc}", err=True)
        sys.exit(1)

    run_id = r.json()["run_id"]
    click.echo(f"Run started: {run_id}")

    elapsed = 0
    while elapsed < timeout:
        time.sleep(poll_interval)
        elapsed += poll_interval
        try:
            r2 = _api("get", f"/runs/{run_id}")
            r2.raise_for_status()
            run = r2.json()
        except requests.RequestException as exc:
            click.echo(f"Poll error: {exc}", err=True)
            continue

        status = run.get("status", "unknown")
        click.echo(f"  [{elapsed:>3}s] status={status}")
        if status in ("completed", "failed", "pending_approval", "approved", "rejected"):
            click.echo()
            if run.get("output"):
                click.echo("Output:")
                click.echo(json.dumps(run["output"], indent=2, ensure_ascii=False))
            if run.get("error"):
                click.echo(f"Error: {run['error']}", err=True)
                sys.exit(1)
            if status == "pending_approval":
                click.echo("NOTE: Run is awaiting approval. Approve at " + f"{API_BASE}/approvals")
            return

    click.echo(f"Timeout: run {run_id} did not complete within {timeout}s", err=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# floom worker create <id>
# ---------------------------------------------------------------------------

WORKER_YML_TEMPLATE = """\
schema_version: "0.3"
name: {slug}
title: {title}
description: Describe what this worker does.
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  command: python run.py
  runtime: python311
  runner: local
  inputs:
  - name: input_text
    kind: scalar
    type: string
    required: true
    label: Input text
    placeholder: "Enter your input here..."
    description: Text to process.
  secrets:
  - OPENAI_API_KEY
  outputs:
  - name: result
    kind: file
    media_type: text/markdown
    path: out/result.md
    required: true
    label: Result

capabilities:
  secrets:
  - OPENAI_API_KEY
  network: {{ egress: true }}

approvals:
  required: false

trigger:
  type: manual
"""

WORKER_RUN_TEMPLATE = '''\
"""Worker: {id}

Receives inputs dict and context, returns WorkerResult.
"""
from models import WorkerResult


def run(inputs: dict, context) -> WorkerResult:
    context.log("Starting {id}...")
    input_text = inputs.get("input_text", "")

    # TODO: implement your worker logic here
    result = f"Processed: {{input_text}}"

    return WorkerResult(
        status="success",
        outputs={{"result": result}},
    )
'''

WORKER_REQUIREMENTS_TEMPLATE = """\
openai>=1.0.0
"""


@cli.command(name="worker")
@click.argument("action", type=click.Choice(["create"]))
@click.argument("worker_id")
def worker_cmd(action: str, worker_id: str):
    """Scaffold a new worker directory.

    Usage: floom worker create <id>
    """
    workers_dir = REPO_ROOT / "workers"
    target = workers_dir / worker_id

    if target.exists():
        click.echo(f"Worker {worker_id!r} already exists at {target}", err=True)
        sys.exit(1)

    target.mkdir(parents=True)
    title = worker_id.replace("_", " ").title()
    slug = worker_id.replace("_", "-")

    (target / "worker.yml").write_text(WORKER_YML_TEMPLATE.format(slug=slug, title=title))
    (target / "run.py").write_text(WORKER_RUN_TEMPLATE.format(id=worker_id))
    (target / "requirements.txt").write_text(WORKER_REQUIREMENTS_TEMPLATE)
    (target / "SKILL.md").write_text(
        f"# {title}\n\n"
        "Placeholder WorkerContract entrypoint. Current execution uses `exec.command` from `worker.yml`.\n"
    )

    click.echo(f"Worker scaffold created at: {target}")
    click.echo(f"  {target}/worker.yml")
    click.echo(f"  {target}/SKILL.md")
    click.echo(f"  {target}/run.py")
    click.echo(f"  {target}/requirements.txt")
    click.echo(f"\nRun 'floom reload' to register the new worker.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli()
