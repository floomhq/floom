"""#2265 regression: file-input workers must be runnable over MCP.

Pre-fix dead-end (P0): workers.sample_input returned a file input's example as
inline text, but workers.run only accepted SHA-256 references minted by the
browser-only multipart ``POST /uploads`` form — and no MCP tool could mint one.
Every worker with a ``type: file`` input was therefore unrunnable via MCP, and
the documented sample_input → run happy path was guaranteed to fail.

Covered here:
  - files.upload MCP tool (via /mcp-tools/serve) returns a valid SHA-256 ref
    and workers.run (via /mcp-tools/serve) accepts it end-to-end.
  - workers.sample_input's file-input example passes workers.run unchanged
    (inline text transparently uploaded; staged file content matches).
  - Inline {content|content_base64, filename} object form works.
  - base64 binary uploads round-trip.
  - Security contract NOT weakened: blocked extensions still rejected,
    unknown SHA refs still 404, hex-like typo'd SHAs rejected with a clear
    error instead of being silently uploaded as content, exactly-one-of
    content/content_base64 enforced.
"""

from __future__ import annotations

import base64
import hashlib
import sys
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from test_round8_worker_authz import _headers, _load_api

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SAMPLE_TEXT = "# Notes\ninline sample body for #2265\n"


def _file_worker_yml(name: str, *, accepts: str = "text/plain") -> str:
    return f"""schema_version: "0.3"
name: "{name}"
title: "File Input 2265 Probe"
description: "file input inline content test worker"
version: "0.1.0"
targets: [generic]
example_input:
  source_materials: |
    {SAMPLE_TEXT.splitlines()[0]}
    {SAMPLE_TEXT.splitlines()[1]}
  topic: quarterly report
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs:
  - name: source_materials
    kind: file
    type: file
    media_type: {accepts}
    accepts:
    - {accepts}
    max_size_mb: 1
    required: true
    label: Source materials
  - name: topic
    kind: scalar
    type: string
    required: true
    label: Topic
  outputs: []
trigger:
  type: manual
"""


def _create_file_worker(client: TestClient, *, accepts: str = "text/plain") -> str:
    worker_id = f"t2265-{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/workers",
        headers=_headers("user-a"),
        json={
            "worker_yml": _file_worker_yml(worker_id, accepts=accepts),
            "run_py": (
                "def run(inputs, context):\n"
                "    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
            ),
        },
    )
    assert created.status_code == 200, created.text
    return worker_id


def _serve(client: TestClient, name: str, arguments: dict, rpc_id: int = 1) -> dict:
    resp = client.post(
        "/mcp-tools/serve",
        headers=_headers("user-a"),
        json={
            "jsonrpc": "2.0",
            "id": rpc_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "result" in body, body
    return body["result"]


def _staged_input_path(tmp_path: Path, run_id: str, filename: str) -> Path:
    return tmp_path / "artifacts" / run_id / "inputs" / filename


def test_files_upload_tool_listed_and_returns_valid_ref(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    listed = client.post(
        "/mcp-tools/serve",
        headers=_headers("user-a"),
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    )
    assert listed.status_code == 200, listed.text
    names = {t["name"] for t in listed.json()["result"]["tools"]}
    assert "files.upload" in names

    result = _serve(client, "files.upload", {"filename": "notes.txt", "content": SAMPLE_TEXT})
    assert result.get("isError") is False, result
    stored = result["structuredContent"]
    expected_sha = hashlib.sha256(SAMPLE_TEXT.encode("utf-8")).hexdigest()
    assert stored["sha256"] == expected_sha
    assert stored["id"] == expected_sha
    assert stored["media_type"] == "text/plain"
    assert stored["size"] == len(SAMPLE_TEXT.encode("utf-8"))
    assert "usage" in stored

    # The ref is a real /uploads blob owned by the caller.
    with main.get_db() as conn:
        row = conn.execute("SELECT uploaded_by FROM files WHERE id = ?", (expected_sha,)).fetchone()
    assert row is not None
    assert row["uploaded_by"] == "user-a"


def test_mcp_only_happy_path_files_upload_then_workers_run(monkeypatch, tmp_path):
    """End-to-end MCP-only: files.upload → workers.run with the returned ref."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    worker_id = _create_file_worker(client)

    upload = _serve(client, "files.upload", {"filename": "notes.txt", "content": SAMPLE_TEXT})
    assert upload.get("isError") is False, upload
    sha = upload["structuredContent"]["sha256"]

    run_result = _serve(
        client,
        "workers.run",
        {"id": worker_id, "inputs": {"source_materials": sha, "topic": "quarterly report"}},
        rpc_id=2,
    )
    assert run_result.get("isError") is False, run_result
    run_id = run_result["structuredContent"]["run_id"]

    staged = _staged_input_path(tmp_path, run_id, "source_materials.txt")
    assert staged.is_file(), f"staged input missing at {staged}"
    assert staged.read_text(encoding="utf-8") == SAMPLE_TEXT


def test_sample_input_example_is_directly_runnable(monkeypatch, tmp_path):
    """THE #2265 repro: workers.sample_input output must pass workers.run as-is."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    worker_id = _create_file_worker(client)

    sample = client.get(f"/workers/{worker_id}/sample-input", headers=_headers("user-a"))
    assert sample.status_code == 200, sample.text
    sample_inputs = sample.json()
    assert isinstance(sample_inputs.get("source_materials"), str)
    assert not sample_inputs["source_materials"].strip().startswith("sha256")

    # Pre-fix this returned 400 "value must be a SHA-256 reference from
    # /uploads, got non-SHA value". It must now start a run.
    run_result = _serve(client, "workers.run", {"id": worker_id, "inputs": sample_inputs})
    assert run_result.get("isError") is False, run_result
    run_id = run_result["structuredContent"]["run_id"]

    staged = _staged_input_path(tmp_path, run_id, "source_materials.txt")
    assert staged.is_file()
    assert staged.read_text(encoding="utf-8") == sample_inputs["source_materials"]


def test_inline_content_object_form_and_accepts_extension(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    # Object form with explicit filename (worker accepts text/markdown).
    worker_id = _create_file_worker(client, accepts="text/markdown")
    resp = client.post(
        f"/workers/{worker_id}/runs",
        headers=_headers("user-a"),
        json={
            "inputs": {
                "source_materials": {"content": SAMPLE_TEXT, "filename": "brief.md"},
                "topic": "t",
            }
        },
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["run_id"]
    staged = _staged_input_path(tmp_path, run_id, "source_materials.md")
    assert staged.is_file()
    assert staged.read_text(encoding="utf-8") == SAMPLE_TEXT

    # A text/csv input maps inline text to a .csv filename so the input's own
    # accepts constraint is satisfied (csv_enricher-style sample inputs).
    csv_worker = _create_file_worker(client, accepts="text/csv")
    csv_text = "name,company\nJordan Lee,Acme Inc\n"
    resp = client.post(
        f"/workers/{csv_worker}/runs",
        headers=_headers("user-a"),
        json={"inputs": {"source_materials": csv_text, "topic": "t"}},
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["run_id"]
    staged = _staged_input_path(tmp_path, run_id, "source_materials.csv")
    assert staged.is_file()
    assert staged.read_text(encoding="utf-8") == csv_text


def test_files_upload_base64_binary_roundtrip(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    payload = bytes(range(256))
    result = _serve(
        client,
        "files.upload",
        {"filename": "blob.zip", "content_base64": base64.b64encode(payload).decode("ascii")},
    )
    assert result.get("isError") is False, result
    stored = result["structuredContent"]
    assert stored["sha256"] == hashlib.sha256(payload).hexdigest()
    assert stored["size"] == len(payload)

    import files as files_mod

    assert files_mod.blob_path(stored["sha256"]).read_bytes() == payload


def test_security_contract_not_weakened(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    worker_id = _create_file_worker(client)

    # Blocked executable extension still rejected on the MCP path.
    blocked = _serve(client, "files.upload", {"filename": "evil.sh", "content": "echo pwned"})
    assert blocked.get("isError") is True, blocked

    # Exactly one of content / content_base64.
    both = _serve(
        client,
        "files.upload",
        {"filename": "a.txt", "content": "x", "content_base64": "eA=="},
        rpc_id=2,
    )
    assert both.get("isError") is True, both
    neither = _serve(client, "files.upload", {"filename": "a.txt"}, rpc_id=3)
    assert neither.get("isError") is True, neither

    # Invalid base64 rejected.
    bad_b64 = _serve(
        client,
        "files.upload",
        {"filename": "a.txt", "content_base64": "not base64!!"},
        rpc_id=4,
    )
    assert bad_b64.get("isError") is True, bad_b64

    # A valid-shape SHA that was never uploaded still 404s at run time.
    ghost_sha = "a" * 64
    resp = client.post(
        f"/workers/{worker_id}/runs",
        headers=_headers("user-a"),
        json={"inputs": {"source_materials": ghost_sha, "topic": "t"}},
    )
    assert resp.status_code == 404, resp.text

    # A hex-like typo'd SHA is rejected with a clear message, NOT silently
    # uploaded as inline content.
    for typo in ("b" * 63, "C" * 64):
        resp = client.post(
            f"/workers/{worker_id}/runs",
            headers=_headers("user-a"),
            json={"inputs": {"source_materials": typo, "topic": "t"}},
        )
        assert resp.status_code == 400, resp.text
        assert "malformed SHA-256" in resp.text

    # Per-input accepts still enforced for inline object form: a .zip into a
    # text/plain input is rejected at upload time.
    resp = client.post(
        f"/workers/{worker_id}/runs",
        headers=_headers("user-a"),
        json={
            "inputs": {
                "source_materials": {
                    "content_base64": base64.b64encode(b"PK\x03\x04").decode("ascii"),
                    "filename": "archive.zip",
                },
                "topic": "t",
            }
        },
    )
    assert resp.status_code == 400, resp.text
