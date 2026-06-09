#!/usr/bin/env python3
"""Regression tests for content-hashed file input bindings.

Runs against an isolated SQLite database and blob directory.

Scenarios covered:
  - Happy path: upload, dedup, run with file input
  - Upload exceeding ceiling: 400, no partial blob persisted, temp cleaned up
  - Bind a stricter input post-upload: bind-time reject (media_type mismatch)
  - Concurrent uploads of identical content: single dedup row, no double-write
  - 10 same-loop async uploads: all succeed and dedup by SHA
  - 5 concurrent runs of same worker with different file SHAs: each sees only its own file
  - Optional file omitted in run 2 after run 1: run 2 inputs dir is clean
  - POST /runs with non-SHA file input values: 400 and no worker execution
  - Bind non-existent SHA: 404 and no orphan queued run
  - File-size revalidation: upload over worker limit, bind rejected with 400
"""

import asyncio
import concurrent.futures
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "apps" / "api"
WORKERS_DIR = ROOT / "workers"
TMP_ROOT = Path(
    os.environ.get("WORKEROS_FILE_INPUTS_TMPDIR")
    or tempfile.mkdtemp(prefix=f"workeros-t1d-file-inputs-{os.getpid()}-")
)
TEST_WORKERS_DIR = TMP_ROOT / "workers"
DB_PATH = TMP_ROOT / "floom.db"
BLOBS_DIR = TMP_ROOT / "blobs"
ARTIFACTS_DIR = TMP_ROOT / "artifacts"
TEST_SECRET = "test-secret-file-inputs"
AUTH_HEADERS = {"x-floom-secret": TEST_SECRET}
TEST_WORKER_ID = "file-access-test"


def reset_environment() -> None:
    shutil.rmtree(TMP_ROOT, ignore_errors=True)
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    os.environ["FLOOM_DB"] = str(DB_PATH)
    os.environ["FLOOM_BLOBS_DIR"] = str(BLOBS_DIR)
    os.environ["FLOOM_WORKERS_DIR"] = str(TEST_WORKERS_DIR)
    os.environ["FLOOM_ARTIFACTS_DIR"] = str(ARTIFACTS_DIR)
    os.environ["FLOOM_SECRET"] = TEST_SECRET
    os.environ["WORKEROS_RUN_CREATE_RATE_LIMIT"] = "0"
    sys.path.insert(0, str(API_DIR))


def write_test_worker() -> None:
    """Worker with one required and one optional file input."""
    worker_dir = TEST_WORKERS_DIR / TEST_WORKER_ID
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
  runner: e2b
  inputs:
  - name: upload
    kind: file
    type: file
    media_type: text/csv
    accepts:
    - text/csv
    max_size_mb: 1
    path: inputs/upload
    required: true
    label: Upload
  - name: optional_doc
    kind: file
    type: file
    media_type: text/plain
    accepts:
    - text/plain
    max_size_mb: 1
    path: inputs/optional_doc
    required: false
    label: Optional Doc
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
  - optional_doc
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
    optional_body = None
    if inputs.get("optional_doc"):
        optional_path = Path(inputs["optional_doc"])
        if optional_path.exists():
            optional_body = optional_path.read_text()
    return {
        "status": "success",
        "outputs": {
            "summary": f"# File Access Test\\n\\n{body}",
            "raw_inputs": {
                "upload": inputs["upload"],
                "optional_doc": inputs.get("optional_doc"),
                "body": body,
                "optional_body": optional_body,
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
import main as api_main  # noqa: E402
import models  # noqa: E402
import run_service  # noqa: E402
from main import app, upload_file as api_upload_file  # noqa: E402


class _FakeDriver:
    def run(self, **kwargs):
        inputs = kwargs["inputs"]
        upload_path = Path(inputs["upload"])
        body = upload_path.read_text()
        optional_body = None
        if inputs.get("optional_doc"):
            optional_path = Path(inputs["optional_doc"])
            if optional_path.exists():
                optional_body = optional_path.read_text()
        return models.WorkerResult(
            status="success",
            outputs={
                "summary": (
                    "# File Access Test\n\n"
                    f"Mounted upload path: {inputs['upload']}\n\n"
                    f"File body:\n{body}\n\n"
                    "Validated staged file input path and content integrity.\n"
                    "Validated staged file input path and content integrity.\n"
                ),
                "raw_inputs": {
                    "upload": inputs["upload"],
                    "optional_doc": inputs.get("optional_doc"),
                    "body": body,
                    "optional_body": optional_body,
                    "cwd": str(Path.cwd()),
                },
            },
            artifacts=[],
        )


run_service.get_sandbox_driver = lambda *_args, **_kwargs: _FakeDriver()

client: TestClient | None = None
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
    if client is None:
        raise RuntimeError("TestClient not initialized")
    data: dict[str, str] = {"max_size_mb": str(max_size_mb)}
    if accepts is not None:
        data["accepts"] = json.dumps(accepts)
    return client.post(
        "/uploads",
        files={"file": (filename, content, media_type)},
        data=data,
    )


def wait_for_run(run_id: str) -> dict[str, Any]:
    if client is None:
        raise RuntimeError("TestClient not initialized")
    for _ in range(200):
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


def db_row(query: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(query, params).fetchone()


class AsyncBytesUpload:
    def __init__(self, filename: str, content: bytes, media_type: str) -> None:
        self.filename = filename
        self.content_type = media_type
        self._content = content
        self._offset = 0

    async def read(self, size: int = -1) -> bytes:
        await asyncio.sleep(0)
        if self._offset >= len(self._content):
            return b""
        if size is None or size < 0:
            size = len(self._content) - self._offset
        chunk = self._content[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk


async def async_upload_bytes(content: bytes, index: int) -> Any:
    request = SimpleNamespace(headers={})
    file = AsyncBytesUpload(f"async-{index}.csv", content, "text/csv")
    auth = api_main.AuthContext(user_id="federico", email=None, scopes=("admin",))
    return await api_upload_file(request, auth=auth, file=file, max_size_mb=1, accepts=None)


async def run_async_uploads(content: bytes, count: int) -> list[Any]:
    return await asyncio.gather(*(async_upload_bytes(content, i) for i in range(count)))


def _main_body() -> int:
    db.init_db()
    reload_response = client.post("/workers/reload")
    check("worker reload succeeds", reload_response.status_code == 200, reload_response.text[:200])

    content = b"name,score\nAda,98\nGrace,97\n"
    expected_sha = hashlib.sha256(content).hexdigest()

    # --- Basic upload ---
    print("\n[section] Basic upload")
    upload_response = post_upload(content)
    check("upload returns 200", upload_response.status_code == 200, upload_response.text[:200])
    upload = upload_response.json()
    check("upload response id is sha256", upload.get("id") == expected_sha, str(upload))
    check("upload response sha256 matches content", upload.get("sha256") == expected_sha, str(upload))
    check("upload response size matches content", upload.get("size") == len(content), str(upload))
    check("upload response media_type is text/csv", upload.get("media_type") == "text/csv", str(upload))

    blob_file = BLOBS_DIR / expected_sha[:2] / expected_sha
    check("blob path exists", blob_file.is_file(), str(blob_file))
    check("blob bytes match upload", blob_file.read_bytes() == content, str(blob_file))

    # --- Dedup ---
    print("\n[section] Dedup")
    dedup_response = post_upload(content, filename="same-content.csv")
    check("dedup upload returns 200", dedup_response.status_code == 200, dedup_response.text[:200])
    check("dedup upload returns same hash", dedup_response.json().get("sha256") == expected_sha, dedup_response.text[:200])
    row_count = db_scalar("SELECT COUNT(*) FROM files WHERE id = ?", (expected_sha,))
    check("dedup keeps one files row", row_count == 1, f"count={row_count}")

    # --- Upload exceeding ceiling ---
    print("\n[section] Upload exceeding ceiling")
    oversize_content = b"x" * 2048
    oversize_sha = hashlib.sha256(oversize_content).hexdigest()
    oversize_response = post_upload(oversize_content, filename="too-big.csv", max_size_mb=0.001)
    check("max_size_mb rejected at upload: 400", oversize_response.status_code == 400, oversize_response.text[:200])
    # No partial blob should be persisted
    oversize_blob = BLOBS_DIR / oversize_sha[:2] / oversize_sha
    check("400 upload leaves no blob on disk", not oversize_blob.exists(), str(oversize_blob))
    # No stale temp files
    tmp_files = list(BLOBS_DIR.rglob("*.tmp*"))
    check("400 upload leaves no temp files", len(tmp_files) == 0, str(tmp_files))

    # --- Bind-time revalidation: wrong media_type ---
    print("\n[section] Bind-time revalidation: wrong media_type")
    pdf_content = b"%PDF-1.4 fake pdf"
    pdf_sha = hashlib.sha256(pdf_content).hexdigest()
    pdf_upload = client.post(
        "/uploads",
        files={"file": ("doc.pdf", pdf_content, "application/pdf")},
        data={"max_size_mb": "1"},
    )
    check("pdf upload succeeds", pdf_upload.status_code == 200, pdf_upload.text[:200])
    # Try to bind a PDF to a text/csv file input — should fail at run creation
    bad_bind_response = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
        json={
            "inputs": {"upload": pdf_sha},
            "trigger_source": "file_inputs_regression",
        },
    )
    check(
        "bind wrong media_type rejected with 400",
        bad_bind_response.status_code == 400,
        bad_bind_response.text[:300],
    )

    # --- Non-SHA file input values are rejected before worker execution ---
    print("\n[section] Non-SHA file input rejection")
    for raw_value in ("/etc/hosts", "not-a-sha"):
        trigger = f"non_sha_{raw_value.replace('/', '_').replace('-', '_')}"
        response = client.post(
            f"/workers/{TEST_WORKER_ID}/runs",
            json={
                "inputs": {"upload": raw_value},
                "trigger_source": trigger,
            },
        )
        check(
            f"non-SHA value {raw_value!r} rejected with 400",
            response.status_code == 400,
            response.text[:300],
        )
        row = db_row(
            """
            SELECT status, output_json, error
            FROM runs
            WHERE trigger_source = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (trigger,),
        )
        check(
            f"non-SHA value {raw_value!r} did not execute worker",
            row is None,
            dict(row) if row else "no run row",
        )

    # --- Bind non-existent SHA: 404 ---
    print("\n[section] Bind non-existent SHA")
    fake_sha = "a" * 64
    bad_sha_response = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
        json={
            "inputs": {"upload": fake_sha},
            "trigger_source": "file_inputs_regression",
        },
    )
    check(
        "bind non-existent SHA rejected with 404",
        bad_sha_response.status_code == 404,
        bad_sha_response.text[:300],
    )
    queued_count = db_scalar("SELECT COUNT(*) FROM runs WHERE status = 'queued'")
    check("missing SHA leaves zero queued runs", queued_count == 0, f"queued={queued_count}")
    missing_row = db_row(
        """
        SELECT status, error
        FROM runs
        WHERE trigger_source = 'file_inputs_regression'
          AND input_json LIKE ?
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (f"%{fake_sha}%",),
    )
    check(
        "missing SHA run row is marked failed",
        missing_row is not None
        and missing_row["status"] == "failed"
        and "Uploaded file not found" in (missing_row["error"] or ""),
        dict(missing_row) if missing_row else "no run row",
    )

    # --- File-size revalidation at bind time ---
    print("\n[section] Bind-time revalidation: max_size_mb")
    large_content = b"a,b\n" + (b"x,y\n" * (3 * 1024 * 1024 // 4))
    large_sha = hashlib.sha256(large_content).hexdigest()
    large_upload = post_upload(large_content, filename="large.csv", max_size_mb=5)
    check("3MB upload succeeds with larger upload limit", large_upload.status_code == 200, large_upload.text[:200])
    check("3MB upload hash matches", large_upload.json().get("sha256") == large_sha, large_upload.text[:200])
    large_bind = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
        json={
            "inputs": {"upload": large_sha},
            "trigger_source": "file_inputs_regression_large",
        },
    )
    check(
        "3MB file rejected by worker max_size_mb=1 at bind",
        large_bind.status_code == 400,
        large_bind.text[:300],
    )

    # --- Non-HTTP bind failure cleanup ---
    print("\n[section] Non-HTTP bind failure cleanup")
    ref_fail_content = b"refcount,failure\n1,2\n"
    ref_fail_sha = hashlib.sha256(ref_fail_content).hexdigest()
    ref_fail_upload = post_upload(ref_fail_content, filename="ref-fail.csv")
    check("ref-count failure fixture upload succeeds", ref_fail_upload.status_code == 200, ref_fail_upload.text[:200])
    original_resolve = api_main._resolve_file_input_references

    def fail_bind(*args, **kwargs):
        raise RuntimeError("synthetic bind failure")

    api_main._resolve_file_input_references = fail_bind
    try:
        ref_fail_bind = client.post(
            f"/workers/{TEST_WORKER_ID}/runs",
            json={
                "inputs": {"upload": ref_fail_sha},
                "trigger_source": "file_inputs_regression_ref_fail",
            },
        )
    finally:
        api_main._resolve_file_input_references = original_resolve

    check("non-HTTP bind failure returns 500", ref_fail_bind.status_code == 500, ref_fail_bind.text[:300])
    ref_fail_row = db_row(
        """
        SELECT status, error
        FROM runs
        WHERE trigger_source = 'file_inputs_regression_ref_fail'
        ORDER BY created_at DESC
        LIMIT 1
        """
    )
    check(
        "non-HTTP bind failure run row is marked failed",
        ref_fail_row is not None
        and ref_fail_row["status"] == "failed"
        and "synthetic bind failure" in (ref_fail_row["error"] or ""),
        dict(ref_fail_row) if ref_fail_row else "no run row",
    )

    # --- Multi-file bind failure does not increment earlier refs ---
    print("\n[section] Multi-file bind failure ref_count rollback")
    multi_content = b"multi,file\n1,2\n"
    multi_sha = hashlib.sha256(multi_content).hexdigest()
    multi_upload = post_upload(multi_content, filename="multi.csv")
    check("multi-file fixture upload succeeds", multi_upload.status_code == 200, multi_upload.text[:200])
    multi_ref_before = db_scalar("SELECT ref_count FROM files WHERE id = ?", (multi_sha,))
    missing_optional_sha = "b" * 64
    multi_bind = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
        json={
            "inputs": {"upload": multi_sha, "optional_doc": missing_optional_sha},
            "trigger_source": "file_inputs_regression_multi_fail",
        },
    )
    check("later missing optional SHA rejected with 404", multi_bind.status_code == 404, multi_bind.text[:300])
    multi_ref_after = db_scalar("SELECT ref_count FROM files WHERE id = ?", (multi_sha,))
    check(
        "failed multi-file bind leaves earlier ref_count unchanged",
        multi_ref_after == multi_ref_before,
        f"before={multi_ref_before} after={multi_ref_after}",
    )

    # --- Concurrent uploads of identical content: single dedup row ---
    print("\n[section] Concurrent uploads identical content")
    dup_content = b"concurrent,dedup\n1,2\n"
    dup_sha = hashlib.sha256(dup_content).hexdigest()

    def do_upload(i: int) -> int:
        r = client.post(
            "/uploads",
            files={"file": (f"dup{i}.csv", dup_content, "text/csv")},
            data={"max_size_mb": "1"},
        )
        return r.status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        statuses = list(executor.map(do_upload, range(5)))
    check("all 5 concurrent uploads return 200", all(s == 200 for s in statuses), str(statuses))
    dup_count = db_scalar("SELECT COUNT(*) FROM files WHERE id = ?", (dup_sha,))
    check("5 concurrent uploads produce one files row", dup_count == 1, f"count={dup_count}")

    # --- Same-event-loop async uploads: unique temp files ---
    print("\n[section] 10 async uploads same event loop")
    async_content = b"async,dedup\n1,2\n"
    async_sha = hashlib.sha256(async_content).hexdigest()
    async_results = asyncio.run(run_async_uploads(async_content, 10))
    async_success = all(
        isinstance(result, dict) and result.get("sha256") == async_sha
        for result in async_results
    )
    check("all 10 async uploads return matching SHA", async_success, str(async_results))
    async_count = db_scalar("SELECT COUNT(*) FROM files WHERE id = ?", (async_sha,))
    check("10 async uploads produce one files row", async_count == 1, f"count={async_count}")
    async_tmp_files = list(BLOBS_DIR.rglob(".upload.*.tmp"))
    check("10 async uploads leave no upload temp files", len(async_tmp_files) == 0, str(async_tmp_files))

    # --- Happy-path run: file is staged per-run ---
    print("\n[section] Happy-path run with file input")
    run_response = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
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

    mounted_abs = run.get("output", {}).get("raw_inputs", {}).get("upload")
    # Resolved value must now be an absolute path (not relative) for isolation.
    check("run input is an absolute path", mounted_abs is not None and Path(mounted_abs).is_absolute(), str(mounted_abs))
    mounted_path = Path(mounted_abs)
    check("mounted file exists at absolute path", mounted_path.is_file(), str(mounted_path))
    check("mounted file is under artifacts/<run_id>/inputs/", str(ARTIFACTS_DIR / run_id / "inputs") in str(mounted_path), str(mounted_path))
    check("mounted file bytes match blob", mounted_path.read_bytes() == content, str(mounted_path))
    check(
        "worker read correct file content",
        run.get("output", {}).get("raw_inputs", {}).get("body") == content.decode(),
        json.dumps(run.get("output", {}), default=str)[:500],
    )
    check(
        "worker input path matches stored absolute path",
        run.get("output", {}).get("raw_inputs", {}).get("upload") == mounted_abs,
        json.dumps(run.get("output", {}), default=str)[:500],
    )

    ref_count = db_scalar("SELECT ref_count FROM files WHERE id = ?", (expected_sha,))
    check("ref_count increments after reference resolution", ref_count >= 1, f"ref_count={ref_count}")

    # --- 5 concurrent runs: each sees only its own file ---
    print("\n[section] 5 concurrent runs isolation")
    run_contents = [f"run{i},val{i}\n".encode() for i in range(5)]
    run_shas = []
    for rc in run_contents:
        r = post_upload(rc, filename="run-data.csv")
        check("concurrent run upload ok", r.status_code == 200, r.text[:100])
        run_shas.append(r.json()["sha256"])

    def launch_run(sha: str) -> dict[str, Any]:
        r = client.post(
            f"/workers/{TEST_WORKER_ID}/runs",
            json={
                "inputs": {"upload": sha},
                "trigger_source": "concurrent_test",
            },
        )
        if r.status_code != 200:
            return {"error": r.text}
        return {"run_id": r.json()["run_id"], "sha": sha}

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        launched = list(executor.map(launch_run, run_shas))

    concurrent_ok = True
    for item in launched:
        if "error" in item:
            concurrent_ok = False
            break
        run_id_c = item["run_id"]
        sha_c = item["sha"]
        run_c = wait_for_run(run_id_c)
        if run_c.get("status") != "completed":
            concurrent_ok = False
            continue
        # Each run's mounted file must contain only that run's content.
        body = run_c.get("output", {}).get("raw_inputs", {}).get("body", "")
        expected_body = run_contents[run_shas.index(sha_c)].decode()
        if body != expected_body:
            concurrent_ok = False

    check("5 concurrent runs each see only their own file", concurrent_ok)

    # --- Optional file omitted in run 2 ---
    print("\n[section] Optional file omitted in run 2")
    opt_content = b"optional,data\nhello\n"
    opt_sha = hashlib.sha256(opt_content).hexdigest()
    opt_upload = post_upload(opt_content, filename="opt.txt", media_type="text/plain",
                             accepts=["text/plain"])
    check("optional file upload ok", opt_upload.status_code == 200, opt_upload.text[:100])

    # Run 1: with optional file
    run1_resp = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
        json={
            "inputs": {"upload": expected_sha, "optional_doc": opt_sha},
            "trigger_source": "optional_test",
        },
    )
    check("run1 (with optional) starts", run1_resp.status_code == 200, run1_resp.text[:100])
    run1 = wait_for_run(run1_resp.json()["run_id"])
    check("run1 completes", run1.get("status") == "completed", str(run1.get("error")))
    run1_opt = run1.get("output", {}).get("raw_inputs", {}).get("optional_doc")
    check("run1 has optional_doc", run1_opt is not None and run1_opt != "", str(run1_opt))

    # Run 2: without optional file
    run2_resp = client.post(
        f"/workers/{TEST_WORKER_ID}/runs",
        json={
            "inputs": {"upload": expected_sha},
            "trigger_source": "optional_test",
        },
    )
    check("run2 (without optional) starts", run2_resp.status_code == 200, run2_resp.text[:100])
    run2_id = run2_resp.json()["run_id"]
    run2 = wait_for_run(run2_id)
    check("run2 completes", run2.get("status") == "completed", str(run2.get("error")))

    # Run 2's per-run inputs dir must NOT contain the optional file from run 1.
    run2_inputs_dir = ARTIFACTS_DIR / run2_id / "inputs"
    run2_opt_files = [f for f in run2_inputs_dir.iterdir() if "optional" in f.name] if run2_inputs_dir.exists() else []
    check("run2 inputs dir has no optional_doc stale file", len(run2_opt_files) == 0, str(run2_opt_files))

    # --- csv_enricher contract: csv_file must be kind:file, media_type:text/csv ---
    print("\n[section] csv_enricher contract regression")
    import yaml as _yaml
    csv_enricher_yml_path = ROOT / "workers" / "csv_enricher" / "worker.yml"
    check(
        "csv_enricher worker.yml exists",
        csv_enricher_yml_path.is_file(),
        str(csv_enricher_yml_path),
    )
    if csv_enricher_yml_path.is_file():
        csv_enricher_manifest = _yaml.safe_load(csv_enricher_yml_path.read_text())
        exec_inputs = csv_enricher_manifest.get("exec", {}).get("inputs", [])
        csv_field = next((f for f in exec_inputs if f.get("name") == "csv_file"), None)
        check(
            "csv_enricher has csv_file input (not csv_text)",
            csv_field is not None,
            f"inputs found: {[f.get('name') for f in exec_inputs]}",
        )
        if csv_field:
            check(
                "csv_enricher csv_file is kind:file",
                csv_field.get("kind") == "file",
                f"kind={csv_field.get('kind')}",
            )
            check(
                "csv_enricher csv_file media_type is text/csv",
                csv_field.get("media_type") == "text/csv",
                f"media_type={csv_field.get('media_type')}",
            )
            check(
                "csv_enricher csv_file is required",
                csv_field.get("required") is True,
                f"required={csv_field.get('required')}",
            )
        # Verify no field named csv_text remains
        old_field = next((f for f in exec_inputs if f.get("name") == "csv_text"), None)
        check(
            "csv_enricher has no legacy csv_text input",
            old_field is None,
            f"csv_text field still present: {old_field}",
        )

    if failures:
        print(f"\n{len(failures)} regression check(s) failed: {', '.join(failures)}")
        return 1
    print("\nfile_inputs_regression: all checks passed")
    return 0


def main() -> int:
    global client
    with TestClient(app, raise_server_exceptions=False) as tc:
        tc.headers.update(AUTH_HEADERS)
        client = tc
        try:
            return _main_body()
        finally:
            client = None


def test_file_inputs_regression() -> None:
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())
