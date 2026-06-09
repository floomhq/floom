#!/usr/bin/env python3
"""Run the active stock-worker smoke matrix against a live Workeros API.

The script is intentionally conservative:
  - It reads the active worker list from docs/workers/MANIFEST.md.
  - It posts one run per active stock worker.
  - It polls each run to a terminal state, except opendraft which uses a
    start-and-cancel smoke instead of waiting for the full long-form run.
  - It writes a dated markdown report to docs/workers/SMOKE-RESULTS-YYYY-MM-DD.md
    by default.

The report also snapshots system health counters and open alert incidents so the
same run that proves worker health also preserves the failure-rate evidence
called out in issue #526.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKERS_DOC = REPO_ROOT / "docs" / "workers" / "MANIFEST.md"
WORKER_INPUTS = REPO_ROOT / "docs" / "workers" / "inputs"

FILE_UPLOAD_FIXTURES: dict[str, tuple[str, Path]] = {
    "csv_enricher": ("csv_file", WORKER_INPUTS / "sample_candidates.csv"),
    "cv_writeup": ("cv_file", WORKER_INPUTS / "sample_cv.txt"),
    "reverse_match_crm": ("crm_csv", WORKER_INPUTS / "sample_crm.csv"),
}


@dataclass(frozen=True)
class WorkerSmokeSpec:
    worker_id: str
    smoke_input: Path
    runtime: str
    file_input_name: str | None = None
    sample_file: Path | None = None
    cancel_after_start: bool = False


@dataclass(frozen=True)
class WorkerSmokeResult:
    worker_id: str
    run_id: str | None
    status: str
    duration_ms: int | None
    output_bytes: int | None
    notes: str

    @property
    def pass_state(self) -> str:
        if self.status in {"completed", "cancelled", "cancel_requested"} and self.run_id:
            return "pass"
        if self.status in {"timeout", "failed", "error"}:
            return "fail"
        return "fail"


def _read_secret(explicit: str | None) -> str:
    if explicit:
        return explicit.strip()
    env_secret = os.environ.get("FLOOM_SECRET", "").strip()
    if env_secret:
        return env_secret
    for path in (Path(".deploy-secret"), REPO_ROOT / ".deploy-secret"):
        if path.is_file():
            return path.read_text(encoding="utf-8").strip()
    raise SystemExit("FLOOM_SECRET or --secret is required")


def _http(session: requests.Session, method: str, api_base: str, path: str, **kwargs: Any) -> requests.Response:
    url = f"{api_base.rstrip('/')}{path}"
    response = session.request(method, url, timeout=kwargs.pop("timeout", 90), **kwargs)
    response.raise_for_status()
    return response


def _manifest_sections(manifest_text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    current_id: str | None = None
    current_lines: list[str] = []
    for line in manifest_text.splitlines():
        match = re.match(r"^###\s+([A-Za-z0-9_-]+)\s*$", line)
        if match:
            if current_id is not None:
                sections.append((current_id, "\n".join(current_lines)))
            current_id = match.group(1)
            current_lines = []
            continue
        if current_id is not None:
            current_lines.append(line)
    if current_id is not None:
        sections.append((current_id, "\n".join(current_lines)))
    return sections


def _manifest_field(section: str, field: str) -> str | None:
    pattern = rf"- \*\*{re.escape(field)}:\*\*\s*(.+)"
    match = re.search(pattern, section)
    if not match:
        return None
    return match.group(1).strip()


def _manifest_status(section: str) -> str:
    return (_manifest_field(section, "Status") or "").strip().upper()


def load_active_workers(manifest_path: Path = WORKERS_DOC) -> list[WorkerSmokeSpec]:
    text = manifest_path.read_text(encoding="utf-8")
    in_active_workers = False
    current_id: str | None = None
    current_lines: list[str] = []
    specs: list[WorkerSmokeSpec] = []

    def flush_current() -> None:
        nonlocal current_id, current_lines
        if current_id is None:
            return
        section = "\n".join(current_lines)
        smoke_input = _manifest_field(section, "Smoke input")
        runtime = _manifest_field(section, "Runtime") or "unknown"
        if smoke_input is None:
            raise RuntimeError(f"Missing smoke input for active worker {current_id}")
        if "ARCHIVED" in _manifest_status(section):
            current_id = None
            current_lines = []
            return
        smoke_input = re.sub(r"\s+\(\+ file upload\)$", "", smoke_input).strip()
        sample_file = None
        file_input_name = None
        if current_id in FILE_UPLOAD_FIXTURES:
            file_input_name, sample_file = FILE_UPLOAD_FIXTURES[current_id]
        specs.append(
            WorkerSmokeSpec(
                worker_id=current_id,
                smoke_input=REPO_ROOT / smoke_input,
                runtime=runtime,
                file_input_name=file_input_name,
                sample_file=sample_file,
                cancel_after_start=current_id == "opendraft",
            )
        )
        current_id = None
        current_lines = []

    for line in text.splitlines():
        if re.match(r"^##\s+Active Workers\s*$", line):
            in_active_workers = True
            continue
        if re.match(r"^##\s+System Workers\b", line):
            flush_current()
            break
        if not in_active_workers:
            continue
        match = re.match(r"^###\s+([A-Za-z0-9_-]+)\s*$", line)
        if match:
            flush_current()
            current_id = match.group(1)
            current_lines = []
            continue
        if current_id is not None:
            current_lines.append(line)

    flush_current()
    return specs


def _load_inputs(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _upload_sample_file(session: requests.Session, api_base: str, secret: str, path: Path) -> str:
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    with path.open("rb") as fh:
        response = session.post(
            f"{api_base.rstrip('/')}/uploads",
            headers={"x-floom-secret": secret},
            files={"file": (path.name, fh, mime_type)},
            timeout=90,
        )
    response.raise_for_status()
    payload = response.json()
    sha256 = payload.get("sha256")
    if not isinstance(sha256, str) or not sha256:
        raise RuntimeError(f"Upload response for {path.name} did not include sha256")
    return sha256


def _poll_run(session: requests.Session, api_base: str, secret: str, run_id: str, timeout_seconds: int, poll_interval_seconds: int) -> dict[str, Any]:
    deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
    while datetime.now(timezone.utc) < deadline:
        response = _http(
            session,
            "GET",
            api_base,
            f"/runs/{run_id}",
            headers={"x-floom-secret": secret},
            timeout=90,
        )
        run = response.json()
        status = str(run.get("status") or "").lower()
        if status in {"completed", "failed", "cancelled", "error", "timeout", "pending_approval"}:
            return run
        # queued/running -> keep waiting
        import time

        time.sleep(poll_interval_seconds)
    raise TimeoutError(f"Run {run_id} did not reach a terminal state within {timeout_seconds}s")


def _start_run(session: requests.Session, api_base: str, secret: str, spec: WorkerSmokeSpec) -> tuple[str, dict[str, Any]]:
    inputs = _load_inputs(spec.smoke_input)
    if spec.sample_file and spec.file_input_name:
        inputs[spec.file_input_name] = _upload_sample_file(session, api_base, secret, spec.sample_file)

    response = session.post(
        f"{api_base.rstrip('/')}/workers/{spec.worker_id}/runs",
        headers={"x-floom-secret": secret},
        json={"inputs": inputs, "trigger_source": f"prod_smoke_{spec.worker_id}"},
        timeout=90,
    )
    response.raise_for_status()
    payload = response.json()
    run_id = payload.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise RuntimeError(f"Run create response for {spec.worker_id} did not include run_id")
    return run_id, inputs


def _cancel_run(session: requests.Session, api_base: str, secret: str, run_id: str) -> dict[str, Any]:
    response = session.post(
        f"{api_base.rstrip('/')}/runs/{run_id}/cancel",
        headers={"x-floom-secret": secret},
        timeout=90,
    )
    response.raise_for_status()
    return response.json()


def _smoke_one(session: requests.Session, api_base: str, secret: str, spec: WorkerSmokeSpec, *, poll_timeout_seconds: int, poll_interval_seconds: int) -> WorkerSmokeResult:
    run_id: str | None = None
    try:
        run_id, _inputs = _start_run(session, api_base, secret, spec)
        if spec.cancel_after_start:
            cancel_result = _cancel_run(session, api_base, secret, run_id)
            status = str(cancel_result.get("status") or "cancel_requested").lower()
            return WorkerSmokeResult(
                worker_id=spec.worker_id,
                run_id=run_id,
                status=status,
                duration_ms=None,
                output_bytes=None,
                notes="smoke start + cancel",
            )

        run = _poll_run(
            session,
            api_base,
            secret,
            run_id,
            timeout_seconds=poll_timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )
        status = str(run.get("status") or "").lower()
        output = run.get("output")
        if isinstance(output, str):
            output_bytes = len(output.encode("utf-8"))
        elif output is None:
            output_bytes = None
        else:
            output_bytes = len(json.dumps(output, sort_keys=True).encode("utf-8"))
        return WorkerSmokeResult(
            worker_id=spec.worker_id,
            run_id=run_id,
            status=status,
            duration_ms=run.get("duration_ms"),
            output_bytes=output_bytes,
            notes="",
        )
    except Exception as exc:
        return WorkerSmokeResult(
            worker_id=spec.worker_id,
            run_id=run_id,
            status="failed",
            duration_ms=None,
            output_bytes=None,
            notes=str(exc),
        )


def _collect_system_metrics(session: requests.Session, api_base: str, secret: str) -> dict[str, Any]:
    response = _http(session, "GET", api_base, "/system/metrics", headers={"x-floom-secret": secret}, timeout=90)
    return response.json()


def _collect_system_alerts(session: requests.Session, api_base: str, secret: str) -> list[dict[str, Any]]:
    response = _http(session, "GET", api_base, "/system/alerts", headers={"x-floom-secret": secret}, timeout=90)
    payload = response.json()
    incidents = payload.get("incidents") if isinstance(payload, dict) else []
    return [incident for incident in incidents if isinstance(incident, dict)]


def _collect_failure_streams(session: requests.Session, api_base: str, secret: str) -> list[tuple[str, int, int]]:
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    offset = 0
    limit = 200
    counts: Counter[str] = Counter()
    totals: Counter[str] = Counter()
    while True:
        response = _http(
            session,
            "GET",
            api_base,
            "/runs",
            headers={"x-floom-secret": secret},
            params={
                "since": since,
                "include_system": "true",
                "limit": limit,
                "offset": offset,
            },
            timeout=90,
        )
        rows = response.json()
        if not isinstance(rows, list):
            break
        for row in rows:
            if not isinstance(row, dict):
                continue
            worker_id = str(row.get("worker_id") or "")
            if not worker_id:
                continue
            totals[worker_id] += 1
            if str(row.get("status") or "").lower() == "failed":
                counts[worker_id] += 1
        if len(rows) < limit:
            break
        offset += limit

    return [(worker_id, counts[worker_id], totals[worker_id]) for worker_id in counts]


def _format_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))
    lines = [
        "| " + " | ".join(header.ljust(widths[index]) for index, header in enumerate(headers)) + " |",
        "|-" + "-|-".join("-" * widths[index] for index in range(len(headers))) + "-|",
    ]
    for row in rows:
        lines.append("| " + " | ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)) + " |")
    return "\n".join(lines)


def _render_report(
    *,
    report_date: str,
    api_base: str,
    metrics: dict[str, Any],
    alerts: list[dict[str, Any]],
    failures: list[tuple[str, int, int]],
    smoke_results: list[WorkerSmokeResult],
) -> str:
    runs_7d = int(metrics.get("runs_7d") or 0)
    runs_failed_7d = int(metrics.get("runs_failed_7d") or 0)
    failure_rate = (runs_failed_7d / runs_7d * 100.0) if runs_7d else 0.0
    open_alerts = [incident for incident in alerts if incident.get("open")]
    lines: list[str] = [
        f"# Smoke Results — {report_date}",
        "",
        f"All prod smoke runs executed against `{api_base}` with `x-floom-secret`.",
        "This report combines the stock-worker matrix with the system-health snapshot used for the run-failure-rate audit.",
        "",
        "## System Health Snapshot",
        "",
        _format_table(
            ["Metric", "Value"],
            [
                ["workers_count", str(metrics.get("workers_count", 0))],
                ["runs_total", str(metrics.get("runs_total", 0))],
                ["runs_7d", str(runs_7d)],
                ["runs_failed_7d", str(runs_failed_7d)],
                ["failure_rate_7d", f"{failure_rate:.1f}%"],
                ["connections_count", str(metrics.get("connections_count", 0))],
                ["secrets_count", str(metrics.get("secrets_count", 0))],
                ["active_triggers", str(metrics.get("active_triggers", 0))],
                ["drafts_last_hour", str(metrics.get("drafts_last_hour", 0))],
                ["open_alert_incidents", str(len(open_alerts))],
            ],
        ),
        "",
    ]

    if failures:
        top_rows = sorted(failures, key=lambda item: (-item[1], item[0]))[:5]
        lines.extend(
            [
                "## Top 7-Day Failure Streams",
                "",
                _format_table(
                    ["Worker", "Failed", "Runs", "Failure rate"],
                    [
                        [worker_id, str(failed), str(total), f"{(failed / total * 100.0) if total else 0.0:.1f}%"]
                        for worker_id, failed, total in top_rows
                    ],
                ),
                "",
            ]
        )

    if open_alerts:
        lines.extend(
            [
                "## Open Alerts",
                "",
                _format_table(
                    ["Worker", "Incident", "Reason"],
                    [
                        [
                            str(incident.get("worker_id") or "—"),
                            str(incident.get("incident_key") or incident.get("id") or "—"),
                            str(incident.get("reason") or "—"),
                        ]
                        for incident in open_alerts[:10]
                    ],
                ),
                "",
            ]
        )

    lines.extend(
        [
            "## Active Workers — Smoke Pass/Fail",
            "",
            _format_table(
                ["Worker", "Run ID", "Status", "Duration", "Output bytes", "Notes"],
                [
                    [
                        result.worker_id,
                        result.run_id or "—",
                        _status_symbol(result),
                        _duration_text(result),
                        str(result.output_bytes) if result.output_bytes is not None else "—",
                        result.notes or "—",
                    ]
                    for result in smoke_results
                ],
            ),
            "",
            "## Summary",
            "",
        ]
    )

    pass_count = sum(1 for result in smoke_results if result.pass_state == "pass")
    fail_count = len(smoke_results) - pass_count
    active_count = len(smoke_results)
    lines.extend(
        [
            _format_table(
                ["Category", "Count"],
                [
                    ["Active workers", str(active_count)],
                    ["Smoke PASS", str(pass_count)],
                    ["Smoke FAIL", str(fail_count)],
                    ["7-day failure rate", f"{failure_rate:.1f}%"],
                ],
            ),
            "",
        ]
    )

    return "\n".join(lines).rstrip() + "\n"


def _status_symbol(result: WorkerSmokeResult) -> str:
    if result.pass_state == "pass":
        return "✅ PASS"
    if result.status == "timeout":
        return "⏳ TIMEOUT"
    return "❌ FAIL"


def _duration_text(result: WorkerSmokeResult) -> str:
    if result.duration_ms is None:
        return "—"
    if result.duration_ms < 1000:
        return f"{result.duration_ms} ms"
    return f"{result.duration_ms / 1000:.1f} s"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=os.environ.get("WORKEROS_API_URL", "https://workers-api.floom.dev"))
    parser.add_argument("--secret", default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--poll-timeout", type=int, default=900)
    parser.add_argument("--poll-interval", type=int, default=10)
    parser.add_argument("--manifest", default=str(WORKERS_DOC))
    parser.add_argument(
        "--workers",
        default=None,
        help="Comma-separated worker IDs to run. Defaults to every non-archived worker in the active manifest section.",
    )
    args = parser.parse_args(argv)

    secret = _read_secret(args.secret)
    manifest_path = Path(args.manifest)
    specs = load_active_workers(manifest_path)
    if args.workers:
        selected = {worker_id.strip() for worker_id in args.workers.split(",") if worker_id.strip()}
        known = {spec.worker_id for spec in specs}
        unknown = sorted(selected - known)
        if unknown:
            raise SystemExit(f"Unknown or inactive worker(s): {', '.join(unknown)}")
        specs = [spec for spec in specs if spec.worker_id in selected]
    session = requests.Session()
    session.headers.update({"x-floom-secret": secret})

    smoke_results = [
        _smoke_one(
            session,
            args.api,
            secret,
            spec,
            poll_timeout_seconds=args.poll_timeout,
            poll_interval_seconds=args.poll_interval,
        )
        for spec in specs
    ]

    metrics = _collect_system_metrics(session, args.api, secret)
    alerts = _collect_system_alerts(session, args.api, secret)
    failures = _collect_failure_streams(session, args.api, secret)

    report_date = datetime.now().date().isoformat()
    report = _render_report(
        report_date=report_date,
        api_base=args.api,
        metrics=metrics,
        alerts=alerts,
        failures=failures,
        smoke_results=smoke_results,
    )
    output_path = Path(args.output) if args.output else REPO_ROOT / "docs" / "workers" / f"SMOKE-RESULTS-{report_date}.md"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")
    print(str(output_path))

    failures_present = any(result.pass_state != "pass" for result in smoke_results)
    if failures_present:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
