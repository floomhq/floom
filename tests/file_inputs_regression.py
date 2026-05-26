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
DB_PATH = Path("/tmp/workeros-t1d-file-inputs.db")
BLOBS_DIR = Path("/tmp/workeros-t1d-file-inputs-blobs")
MOUNTED_INPUTS_DIR = WORKERS_DIR / "input_types_test" / "inputs"


def reset_environment() -> None:
    DB_PATH.unlink(missing_ok=True)
    shutil.rmtree(BLOBS_DIR, ignore_errors=True)
    shutil.rmtree(MOUNTED_INPUTS_DIR, ignore_errors=True)
    os.environ["FLOOM_DB"] = str(DB_PATH)
    os.environ["FLOOM_BLOBS_DIR"] = str(BLOBS_DIR)
    os.environ["FLOOM_WORKERS_DIR"] = str(WORKERS_DIR)
    os.environ["FLOOM_ARTIFACTS_DIR"] = "/tmp/workeros-t1d-file-inputs-artifacts"
    sys.path.insert(0, str(API_DIR))


reset_environment()

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
        "/workers/input_types_test/runs",
        json={
            "inputs": {
                "text_input": "Hello",
                "textarea_input": "Notes",
                "number_input": 42,
                "select_input": "beta",
                "boolean_input": True,
                "file_input": expected_sha,
            },
            "trigger_source": "file_inputs_regression",
        },
    )
    check("file reference run starts", run_response.status_code == 200, run_response.text[:200])
    run_id = run_response.json()["run_id"]
    run = wait_for_run(run_id)
    check("file reference run completes", run.get("status") == "completed", json.dumps(run, default=str)[:500])

    mounted_rel = run.get("input", {}).get("file_input")
    check("run input is mounted relative file path", mounted_rel == "inputs/file_input.csv", str(mounted_rel))
    mounted_path = WORKERS_DIR / "input_types_test" / mounted_rel
    check("mounted file exists in worker input dir", mounted_path.is_file(), str(mounted_path))
    check("mounted file bytes match blob", mounted_path.read_bytes() == content, str(mounted_path))
    check(
        "worker saw mounted path in raw output",
        run.get("output", {}).get("raw_inputs", {}).get("file_input") == mounted_rel,
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
