#!/usr/bin/env python3
"""Regression tests for content-hashed file input bindings.

Runs against an isolated SQLite database and blob directory.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "apps" / "api"
WORKERS_DIR = ROOT / "workers"
TEST_WORKERS_DIR = Path("/tmp/workeros-t1d-file-inputs-workers")
DB_PATH = Path("/tmp/workeros-t1d-file-inputs.db")
BLOBS_DIR = Path("/tmp/workeros-t1d-file-inputs-blobs")
MOUNTED_INPUTS_DIR = TEST_WORKERS_DIR / "file_access_test" / "inputs"


def reset_environment() -> None:
    DB_PATH.unlink(missing_ok=True)
    shutil.rmtree(BLOBS_DIR, ignore_errors=True)
    shutil.rmtree(TEST_WORKERS_DIR, ignore_errors=True)
    shutil.rmtree(MOUNTED_INPUTS_DIR, ignore_errors=True)
    os.environ["FLOOM_DB"] = str(DB_PATH)
    os.environ["FLOOM_BLOBS_DIR"] = str(BLOBS_DIR)
    os.environ["FLOOM_WORKERS_DIR"] = str(TEST_WORKERS_DIR)
    os.environ["FLOOM_ARTIFACTS_DIR"] = "/tmp/workeros-t1d-file-inputs-artifacts"
    sys.path.insert(0, str(API_DIR))


def write_test_worker() -> None:
    worker_dir = TEST_WORKERS_DIR / "file_access_test"
    worker_dir.mkdir(parents=True, exist_ok=True)
    (worker_dir / "worker.yml").write_text(
        """schema_version: '0.3'
name: file-access-test
title: File Access Test
description: Reads a mounted file input from the worker cwd.
version: 0.1.0
entrypoint: SKILL.md
targets:
- generic
exec:
  command: python run.py
  runtime: python311
  runner: local
  inputs:
  - name: upload
    kind: file
    media_type: text/csv
    accepts:
    - text/csv
    max_size_mb: 1
    path: inputs/upload
    required: true
    label: Upload
  secrets: []
  outputs:
  - name: summary
    kind: file
    media_type: text/markdown
    path: out/summary.md
    required: true
    label: Summary
  - name: raw_inputs
    kind: file
    media_type: application/json
    path: out/raw_inputs.json
    required: true
    label: Raw inputs
capabilities:
  secrets: []
  files:
  - upload
  network:
    egress: false
approvals:
  required: false
trigger:
  type: manual
"""
    )
    (worker_dir / "run.py").write_text(
        """from pathlib import Path
from typing import Any, Dict


def run(inputs: Dict[str, Any], context) -> Dict[str, Any]:
    upload_path = Path(inputs["upload"])
    body = upload_path.read_text()
    return {
        "status": "success",
        "outputs": {
            "summary": f"# File Access Test\\n\\n{body}",
            "raw_inputs": {
                "upload": inputs["upload"],
                "body": body,
                "cwd": str(Path.cwd()),
            },
        },
        "artifacts": [],
    }
"""
    )
    (worker_dir / "requirements.txt").write_text("")
    (worker_dir / "SKILL.md").write_text("# File Access Test\n")


reset_environment()
write_test_worker()

from fastapi.testclient import TestClient  # noqa: E402

import db  # noqa: E402
from main import app  # noqa: E402


client = TestClient(app)
failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {name}")
        return
    print(f"  FAIL  {name}" + (f": {detail}" if detail else ""))
    failures.append(name)


def post_upload(
    content: bytes,
    *,
    filename: str = "scores.csv",
    media_type: str = "text/csv",
    accepts: list[str] | None = None,
    max_size_mb: float = 1,
) -> Any:
    return client.post(
        "/uploads",
        files={"file": (filename, content, media_type)},
        data={
            "accepts": json.dumps(accepts or ["text/csv"]),
            "max_size_mb": str(max_size_mb),
        },
    )


def wait_for_run(run_id: str) -> dict[str, Any]:
    for _ in range(100):
        run_response = client.get(f"/runs/{run_id}")
        if run_response.status_code == 200:
            run = run_response.json()
            if run["status"] in {
                "completed",
                "failed",
                "pending_approval",
                "approved",
                "rejected",
            }:
                return run
        time.sleep(0.05)
    raise TimeoutError(f"Run {run_id} did not finish")


def db_scalar(query: str, params: tuple[Any, ...] = ()) -> Any:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute(query, params).fetchone()[0]


def main() -> int:
    db.init_db()
    reload_response = client.post("/workers/reload")
    check("worker reload succeeds", reload_response.status_code == 200, reload_response.text[:200])

    content = b"name,score\nAda,98\nGrace,97\n"
    expected_sha = hashlib.sha256(content).hexdigest()

    upload_response = post_upload(content)
    check("upload returns 200", upload_response.status_code == 200, upload_response.text[:200])
    upload = upload_response.json()
    check("upload response id is sha256", upload.get("id") == expected_sha, str(upload))
    check("upload response sha256 matches content", upload.get("sha256") == expected_sha, str(upload))
    check("upload response size matches content", upload.get("size") == len(content), str(upload))
    check("upload response media_type is text/csv", upload.get("media_type") == "text/csv", str(upload))

    blob_path = BLOBS_DIR / expected_sha[:2] / expected_sha
    check("blob path exists", blob_path.is_file(), str(blob_path))
    check("blob bytes match upload", blob_path.read_bytes() == content, str(blob_path))

    dedup_response = post_upload(content, filename="same-content.csv")
    check("dedup upload returns 200", dedup_response.status_code == 200, dedup_response.text[:200])
    check("dedup upload returns same hash", dedup_response.json().get("sha256") == expected_sha, dedup_response.text[:200])
    row_count = db_scalar("SELECT COUNT(*) FROM files WHERE id = ?", (expected_sha,))
    check("dedup keeps one files row", row_count == 1, f"count={row_count}")

    oversize_response = post_upload(b"x" * 2048, filename="too-big.csv", max_size_mb=0.001)
    check("max_size_mb rejected at upload", oversize_response.status_code == 413, oversize_response.text[:200])

    run_response = client.post(
        "/workers/file_access_test/runs",
        json={
            "inputs": {
                "upload": expected_sha,
            },
            "trigger_source": "file_inputs_regression",
        },
    )
    check("file reference run starts", run_response.status_code == 200, run_response.text[:200])
    run_id = run_response.json()["run_id"]
    run = wait_for_run(run_id)
    check("file reference run completes", run.get("status") == "completed", json.dumps(run, default=str)[:500])

    mounted_rel = run.get("input", {}).get("upload")
    check("run input is mounted relative file path", mounted_rel == "inputs/upload.csv", str(mounted_rel))
    mounted_path = TEST_WORKERS_DIR / "file_access_test" / mounted_rel
    check("mounted file exists in worker input dir", mounted_path.is_file(), str(mounted_path))
    check("mounted file bytes match blob", mounted_path.read_bytes() == content, str(mounted_path))
    check(
        "worker opened mounted relative path",
        run.get("output", {}).get("raw_inputs", {}).get("body") == content.decode(),
        json.dumps(run.get("output", {}), default=str)[:500],
    )
    check(
        "worker saw mounted path in raw output",
        run.get("output", {}).get("raw_inputs", {}).get("upload") == mounted_rel,
        json.dumps(run.get("output", {}), default=str)[:500],
    )

    ref_count = db_scalar("SELECT ref_count FROM files WHERE id = ?", (expected_sha,))
    check("ref_count increments after reference resolution", ref_count == 1, f"ref_count={ref_count}")

    shutil.rmtree(MOUNTED_INPUTS_DIR, ignore_errors=True)
    if failures:
        print(f"\n{len(failures)} regression check(s) failed: {', '.join(failures)}")
        return 1
    print("\nfile_inputs_regression: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
