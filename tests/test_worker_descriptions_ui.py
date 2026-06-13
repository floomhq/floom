"""
UI behavior tests for T2-B worker descriptions.

Strategy: fetch-based tests against the FastAPI app via httpx.AsyncClient
for behaviors that touch the API, plus pure-logic tests for folder-tree
grouping and sample-button rules (mirrored from the frontend logic).

These tests do NOT require a running server — they use ASGI transport.
"""

import os
import sys
import json
import asyncio
from pathlib import Path
import pytest
import yaml

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

# Point worker_registry at the repo workers dir
# Explicit override (not setdefault): conftest pins a temp WORKERS_DIR for the
# suite, but these stock-worker tests must discover the real repo bundles. The
# module flag tells the conftest isolation fixture not to reset us each test.
_USE_REAL_WORKERS_DIR = True
os.environ["FLOOM_WORKERS_DIR"] = str(REPO_ROOT / "workers")

from models import parse_worker_manifest

# ---------------------------------------------------------------------------
# Pure-logic: new-worker YAML generator (mirrors frontend buildYaml)
# ---------------------------------------------------------------------------

def _yaml_string(value: str) -> str:
    return json.dumps(value)


def _yaml_block(value: str, indent: str = "") -> list[str]:
    return [f"{indent}{line}" for line in value.split("\n")]


def _yaml_scalar(value: str | int | bool | None) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _yaml_string(value)
    return str(value)


def _sample_value_for_input(input_row: dict) -> str | int | bool | None:
    if input_row["type"] == "number":
        return 1
    if input_row["type"] == "boolean":
        return True
    if input_row["type"] == "file":
        return None
    if input_row["type"] == "select":
        options = [option.strip() for option in input_row.get("options", "").split(",") if option.strip()]
        return options[0] if options else "option"
    if input_row["type"] == "textarea":
        return f"Sample {input_row.get('label') or input_row['name']} with enough detail for a realistic run."
    return f"Sample {input_row.get('label') or input_row['name']}"


def _build_new_worker_yaml(
    worker_id: str,
    name: str,
    description: str,
    inputs: list[dict],
    outputs: list[dict],
    secrets: str,
    approvals_required: bool,
) -> str:
    """Python mirror of the frontend buildYaml function."""
    slug = (worker_id or "my-worker").replace("_", "-")
    title = name or "My Worker"
    secret_names = [s.strip() for s in secrets.split(",") if s.strip()]
    lines: list[str] = []
    lines.append('schema_version: "0.3"')
    lines.append(f"name: {slug}")
    lines.append(f"title: {_yaml_string(title)}")
    lines.append(f"description: {_yaml_string(description or 'Custom Workeros worker.')}")
    lines.append("long_description: |")
    lines.extend(_yaml_block(f"  Explain what {title} does, when to run it, and what a trustworthy result looks like."))
    lines.append("use_cases:")
    lines.append("- Replace this with a concrete operator workflow.")
    lines.append("- Replace this with a second realistic use case.")
    lines.append("- Replace this with a third realistic use case.")
    if inputs:
        lines.append("example_input:")
        for inp in inputs:
            if not inp.get("name"):
                continue
            sample = _sample_value_for_input(inp)
            if isinstance(sample, str) and "\n" in sample:
                lines.append(f"  {inp['name']}: |")
                lines.extend(_yaml_block(sample, "    "))
            else:
                lines.append(f"  {inp['name']}: {_yaml_scalar(sample)}")
    else:
        lines.append("example_input: {}")
    lines.append("example_output: |")
    lines.extend(_yaml_block("  ## Example output\n\n  Replace this markdown with the worker's expected result shape."))
    lines.append("how_it_works: |")
    lines.extend(_yaml_block("  Input\n    -> validate fields\n    -> run worker logic\n    -> return structured output"))
    lines.append(f"folder: {_yaml_string('Custom')}")
    lines.append('tags: ["custom", "template"]')
    lines.append('version: "0.1.0"')
    lines.append("entrypoint: SKILL.md")
    lines.append("targets: [generic]")
    lines.append("")
    lines.append("exec:")
    lines.append("  command: python run.py")
    lines.append("  runtime: python311")
    lines.append("  runner: e2b")
    if inputs:
        lines.append("  inputs:")
        for inp in inputs:
            if not inp.get("name"):
                continue
            is_file = inp["type"] == "file"
            scalar_type = "string" if inp["type"] in {"text", "textarea"} else inp["type"]
            lines.append(f"  - name: {inp['name']}")
            lines.append(f"    kind: {'file' if is_file else 'scalar'}")
            if is_file:
                lines.append("    media_type: application/octet-stream")
                lines.append(f"    path: inputs/{inp['name']}")
            else:
                lines.append(f"    type: {scalar_type}")
            lines.append(f"    required: {_yaml_scalar(inp['required'])}")
            lines.append(f"    label: {_yaml_string(inp.get('label') or inp['name'])}")
    else:
        lines.append("  inputs: []")
    lines.append(f"  secrets: [{', '.join(secret_names)}]")
    if outputs:
        lines.append("  outputs:")
        for out in outputs:
            if not out.get("name"):
                continue
            lines.append(f"  - name: {out['name']}")
            lines.append("    kind: scalar")
            lines.append("    type: string")
            lines.append("    required: true")
            lines.append(f"    label: {_yaml_string(out.get('label') or out['name'])}")
    else:
        lines.append("  outputs: []")
    lines.append("")
    lines.append("capabilities:")
    lines.append(f"  secrets: [{', '.join(secret_names)}]")
    lines.append(f"  network: {{ egress: {_yaml_scalar(bool(secret_names))} }}")
    lines.append("")
    lines.append("approvals:")
    lines.append(f"  required: {_yaml_scalar(approvals_required)}")
    lines.append("")
    lines.append("trigger:")
    lines.append("  type: manual")
    return "\n".join(lines)


class TestNewWorkerYamlGenerator:
    def test_file_input_example_round_trips_as_null(self):
        manifest_yaml = _build_new_worker_yaml(
            worker_id="custom-file-worker",
            name="Custom File Worker",
            description="Processes an uploaded file.",
            inputs=[
                {
                    "name": "source_file",
                    "label": "Source file",
                    "type": "file",
                    "required": True,
                    "placeholder": "",
                    "description": "",
                    "options": "",
                },
                {
                    "name": "instruction",
                    "label": "Instruction",
                    "type": "text",
                    "required": True,
                    "placeholder": "",
                    "description": "",
                    "options": "",
                },
            ],
            outputs=[],
            secrets="",
            approvals_required=False,
        )
        raw = yaml.safe_load(manifest_yaml)
        manifest = parse_worker_manifest(raw)
        assert manifest.example_input["source_file"] is None
        assert manifest.example_input["instruction"] == "Sample Instruction"
        assert "source_file: null" in manifest_yaml


# ---------------------------------------------------------------------------
# Pure-logic: folder tree grouping (mirrors frontend buildFolderTree)
# ---------------------------------------------------------------------------

def build_folder_tree(workers: list[dict]) -> list[dict]:
    """Python mirror of the frontend buildFolderTree function."""
    roots: list[dict] = []
    by_path: dict[str, dict] = {}

    for worker in workers:
        folder = worker.get("folder")
        if not folder:
            continue
        parts = [p for p in folder.split("/") if p]
        path = ""
        siblings = roots
        for part in parts:
            path = f"{path}/{part}" if path else part
            if path not in by_path:
                node = {"name": part, "path": path, "count": 0, "children": []}
                by_path[path] = node
                siblings.append(node)
                siblings.sort(key=lambda n: n["name"])
            by_path[path]["count"] += 1
            siblings = by_path[path]["children"]

    return roots


class TestFolderTreeGrouping:
    """Verify the folder tree groups workers correctly with /‑nested folders."""

    def _workers(self):
        return [
            {"id": "cv_writeup", "folder": "Recruiting/NovaSearch"},
            {"id": "reverse_match_crm", "folder": "Recruiting/NovaSearch"},
            {"id": "dach_compliance", "folder": "Recruiting/Compliance"},
            {"id": "csv_enricher", "folder": "Operations/Data"},
            {"id": "weekly_update", "folder": "Operations/Reporting"},
            {"id": "gmail_intake_brief", "folder": "Operations/Inbox"},
            {"id": "e2b_test", "folder": "DevX/Sandbox"},
            {"id": "input_types_test", "folder": "DevX/Fixtures"},
            {"id": "schedule_test", "folder": "DevX/Scheduler"},
            {"id": "webhook_test", "folder": "DevX/Webhooks"},
            {"id": "webhook_secret_test", "folder": "DevX/Webhooks"},
            {"id": "research_brief", "folder": "Research"},
            {"id": "no_folder_worker", "folder": None},
        ]

    def test_roots_are_top_level_only(self):
        tree = build_folder_tree(self._workers())
        root_names = {n["name"] for n in tree}
        assert root_names == {"DevX", "Operations", "Recruiting", "Research"}

    def test_nested_folders_are_children(self):
        tree = build_folder_tree(self._workers())
        recruiting = next(n for n in tree if n["name"] == "Recruiting")
        child_names = {c["name"] for c in recruiting["children"]}
        assert child_names == {"Compliance", "NovaSearch"}

    def test_count_aggregates_all_workers_under_path(self):
        tree = build_folder_tree(self._workers())
        recruiting = next(n for n in tree if n["name"] == "Recruiting")
        # Recruiting itself = 3 (cv_writeup + reverse_match_crm + dach_compliance)
        assert recruiting["count"] == 3
        nova = next(c for c in recruiting["children"] if c["name"] == "NovaSearch")
        assert nova["count"] == 2

    def test_worker_without_folder_not_in_tree(self):
        tree = build_folder_tree(self._workers())
        all_ids = [n["path"] for n in tree]
        assert "no_folder_worker" not in all_ids

    def test_deeply_nested_folder_renders_correctly(self):
        workers = [{"id": "w1", "folder": "Operations/Reporting/Weekly"}]
        tree = build_folder_tree(workers)
        assert len(tree) == 1
        ops = tree[0]
        assert ops["name"] == "Operations"
        reporting = ops["children"][0]
        assert reporting["name"] == "Reporting"
        weekly = reporting["children"][0]
        assert weekly["name"] == "Weekly"
        assert weekly["path"] == "Operations/Reporting/Weekly"

    def test_webhooks_folder_has_two_workers(self):
        tree = build_folder_tree(self._workers())
        devx = next(n for n in tree if n["name"] == "DevX")
        webhooks = next(c for c in devx["children"] if c["name"] == "Webhooks")
        assert webhooks["count"] == 2

    def test_tree_sorted_alphabetically(self):
        tree = build_folder_tree(self._workers())
        root_names = [n["name"] for n in tree]
        assert root_names == sorted(root_names)


# ---------------------------------------------------------------------------
# Pure-logic: sample button behavior (mirrors frontend applyExampleInput)
# ---------------------------------------------------------------------------

def apply_example_input(
    current_inputs: dict,
    example_input: dict,
    file_input_names: set[str],
) -> tuple[dict, list[dict], bool]:
    """
    Python mirror of the frontend applyExampleInput logic.

    Returns (next_inputs, file_uploads, unfillable_file_fields).
    """
    next_inputs = dict(current_inputs)
    file_uploads: list[dict] = []
    unfillable_file_fields = False
    for key, value in example_input.items():
        if key in file_input_names:
            if isinstance(value, str) and value.strip():
                file_uploads.append({"name": key, "content": value})
            elif value is not None:
                unfillable_file_fields = True
            continue
        next_inputs[key] = value
    return next_inputs, file_uploads, unfillable_file_fields


class TestSampleButtonBehavior:
    """Verify sample-button populates form correctly for non-file inputs."""

    def test_non_file_inputs_populated(self):
        example = {"text_field": "hello", "number_field": 42}
        next_inputs, uploads, unfillable = apply_example_input({}, example, set())
        assert next_inputs["text_field"] == "hello"
        assert next_inputs["number_field"] == 42
        assert uploads == []
        assert not unfillable

    def test_file_input_with_null_value_not_copied_no_skip_flag(self):
        """Null file field leaves input empty and does NOT raise skip flag."""
        example = {"cv_file": None, "client_brief": "N26 brief"}
        file_inputs = {"cv_file"}
        next_inputs, uploads, unfillable = apply_example_input({}, example, file_inputs)
        assert "cv_file" not in next_inputs
        assert next_inputs["client_brief"] == "N26 brief"
        assert uploads == []
        assert not unfillable

    def test_file_input_with_inline_string_becomes_upload(self):
        """Inline file content in example_input is staged as an upload."""
        example = {"cv_file": "Anna CV text", "client_brief": "brief"}
        file_inputs = {"cv_file"}
        next_inputs, uploads, unfillable = apply_example_input({}, example, file_inputs)
        assert "cv_file" not in next_inputs
        assert next_inputs["client_brief"] == "brief"
        assert uploads == [{"name": "cv_file", "content": "Anna CV text"}]
        assert not unfillable

    def test_mixed_inputs_with_file_field_null(self):
        """Non-file fields get populated even when a file field has null sample."""
        example = {
            "cv_file": None,
            "client_brief": "Test client",
            "target_format": "branded_markdown",
        }
        file_inputs = {"cv_file"}
        next_inputs, uploads, unfillable = apply_example_input({}, example, file_inputs)
        assert "cv_file" not in next_inputs
        assert next_inputs["client_brief"] == "Test client"
        assert next_inputs["target_format"] == "branded_markdown"
        assert uploads == []
        assert not unfillable

    def test_extra_keys_not_in_inputs_schema_are_still_copied(self):
        """Extra keys in example_input (not in worker's declared inputs) are copied."""
        example = {"text": "hi", "unknown_extra": "val"}
        file_inputs = set()
        next_inputs, uploads, unfillable = apply_example_input({}, example, file_inputs)
        assert next_inputs["unknown_extra"] == "val"
        assert uploads == []
        assert not unfillable

    def test_existing_inputs_preserved_for_fields_not_in_example(self):
        """Fields not in example_input are left untouched."""
        current = {"existing_field": "keep_me"}
        example = {"new_field": "new_val"}
        next_inputs, _, _ = apply_example_input(current, example, set())
        assert next_inputs["existing_field"] == "keep_me"
        assert next_inputs["new_field"] == "new_val"


# ---------------------------------------------------------------------------
# Tag filter logic (mirrors frontend filteredWorkers)
# ---------------------------------------------------------------------------

def filter_workers(
    workers: list[dict],
    tag_filter: str | None,
    folder_filter: str | None,
) -> list[dict]:
    """Mirror of frontend filteredWorkers filter."""
    result = []
    for w in workers:
        tags = w.get("tags") or []
        folder = w.get("folder")
        matches_tag = tag_filter is None or tag_filter in tags
        matches_folder = (
            folder_filter is None
            or folder == folder_filter
            or (folder is not None and folder.startswith(f"{folder_filter}/"))
        )
        if matches_tag and matches_folder:
            result.append(w)
    return result


class TestTagChipFiltering:
    def _workers(self):
        return [
            {"id": "cv_writeup", "tags": ["recruiting", "cv", "novasearch"], "folder": "Recruiting/NovaSearch"},
            {"id": "research_brief", "tags": ["research", "brief"], "folder": "Research"},
            {"id": "weekly_update", "tags": ["reporting", "operations"], "folder": "Operations/Reporting"},
        ]

    def test_no_filter_returns_all(self):
        result = filter_workers(self._workers(), None, None)
        assert len(result) == 3

    def test_tag_filter_matches_correct_workers(self):
        result = filter_workers(self._workers(), "recruiting", None)
        assert len(result) == 1
        assert result[0]["id"] == "cv_writeup"

    def test_tag_filter_no_match_returns_empty(self):
        result = filter_workers(self._workers(), "finance", None)
        assert len(result) == 0

    def test_folder_filter_top_level_includes_children(self):
        """Filtering on 'Recruiting' includes Recruiting/NovaSearch workers."""
        result = filter_workers(self._workers(), None, "Recruiting")
        assert len(result) == 1
        assert result[0]["id"] == "cv_writeup"

    def test_folder_filter_exact_subfolder(self):
        result = filter_workers(self._workers(), None, "Recruiting/NovaSearch")
        assert len(result) == 1

    def test_combined_tag_and_folder_filter(self):
        result = filter_workers(self._workers(), "cv", "Recruiting")
        assert len(result) == 1
        assert result[0]["id"] == "cv_writeup"

    def test_combined_tag_folder_mismatch_returns_empty(self):
        result = filter_workers(self._workers(), "research", "Recruiting")
        assert len(result) == 0


# ---------------------------------------------------------------------------
# API integration: GET /workers and GET /workers/{id} expose T2-B fields
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    """Provide a fresh temp SQLite DB for API integration tests."""
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("FLOOM_DB", str(db_file))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-descriptions-ui")
    # Force re-import of db module with the new env
    import importlib
    import db as _db
    monkeypatch.setattr(_db, "DB_PATH", str(db_file))
    _db.init_db()
    return db_file


def test_api_workers_list_exposes_t2b_fields(tmp_db, monkeypatch):
    """GET /workers returns T2-B metadata for filesystem-discovered workers.

    Uses the synchronous fastapi TestClient (the suite has no pytest-asyncio
    plugin, so the former async def / httpx.AsyncClient version never actually
    ran and was collected as a failure).
    """
    from fastapi.testclient import TestClient
    import main as _main

    from worker_registry import invalidate_worker_cache
    invalidate_worker_cache()

    client = TestClient(_main.app)
    resp = client.get("/workers", headers={"x-floom-secret": "test-secret-descriptions-ui"})
    assert resp.status_code == 200, resp.text
    workers = resp.json()
    assert isinstance(workers, list)
    # csv_enricher: cv_writeup was curated out of the stock sets by #940
    # (tenant-specific), so it no longer appears for users; csv_enricher is a
    # genuine ship-with-product template with the same T2-B metadata shape.
    cv = next((w for w in workers if w["id"] == "csv_enricher"), None)
    assert cv is not None, "csv_enricher must appear in GET /workers"
    assert "folder" in cv
    assert cv["folder"] == "Operations/Data"
    assert isinstance(cv.get("tags"), list)
    example = cv.get("example_input") or {}
    assert example.get("instruction")


def test_api_worker_detail_exposes_t2b_fields(tmp_db, monkeypatch):
    """GET /workers/{id} returns T2-B metadata for a filesystem worker.

    Synchronous TestClient version (see the list test above for why).
    """
    from fastapi.testclient import TestClient
    import main as _main

    from worker_registry import invalidate_worker_cache
    invalidate_worker_cache()

    client = TestClient(_main.app)
    resp = client.get("/workers/csv_enricher", headers={"x-floom-secret": "test-secret-descriptions-ui"})
    assert resp.status_code == 200, resp.text
    w = resp.json()
    assert w["folder"] == "Operations/Data"
    assert isinstance(w.get("tags"), list)
    assert "csv" in w["tags"]
    assert w.get("long_description") is not None
    example = w.get("example_input") or {}
    assert example.get("instruction")


# ---------------------------------------------------------------------------
# Unhappy-path: example_input missing required input => sample button disabled
# ---------------------------------------------------------------------------

class TestMissingRequiredInputSample:
    """
    Verify the rule: if example_input is missing a required input,
    the effective button state should signal 'incomplete'.
    """

    def _has_complete_sample(
        self,
        required_inputs: list[str],
        example_input: dict,
        file_input_names: set[str],
    ) -> bool:
        """
        Returns True if all required non-file inputs are present in example_input
        (mirrors a frontend canApplySample check).
        """
        for inp_name in required_inputs:
            if inp_name in file_input_names:
                continue  # file fields are excluded from sample completeness check
            if example_input.get(inp_name) is None:
                return False
        return True

    def test_complete_sample_returns_true(self):
        result = self._has_complete_sample(
            required_inputs=["client_brief", "target_format"],
            example_input={"client_brief": "N26 brief", "target_format": "branded_markdown"},
            file_input_names={"cv_file"},
        )
        assert result is True

    def test_missing_required_non_file_input_returns_false(self):
        result = self._has_complete_sample(
            required_inputs=["client_brief", "target_format"],
            example_input={"target_format": "branded_markdown"},
            file_input_names={"cv_file"},
        )
        assert result is False

    def test_null_file_field_does_not_block_sample(self):
        """A null file field (no sample) does NOT make the button disabled."""
        result = self._has_complete_sample(
            required_inputs=["cv_file", "client_brief"],
            example_input={"cv_file": None, "client_brief": "brief"},
            file_input_names={"cv_file"},
        )
        assert result is True
