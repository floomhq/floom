"""
Tests for T2-B WorkerContract display-metadata schema validators,
API projection, and all-12-stock-worker YAML round-trips.
"""

import os
import sys
import json
import pytest
import yaml
from pathlib import Path

# Make apps/api importable
REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

# Point worker_registry at the REAL repo workers dir before any import. This is
# an explicit override (not setdefault) because conftest pins a throwaway temp
# WORKERS_DIR for the suite; these stock-worker tests must see the real bundles.
# The module flag tells the conftest isolation fixture NOT to reset us back to
# the suite temp dir before each test in this module.
_USE_REAL_WORKERS_DIR = True
os.environ["FLOOM_WORKERS_DIR"] = str(REPO_ROOT / "workers")

from models import (
    WorkerContract,
    WorkerConfig,
    WorkerManifest,
    parse_worker_manifest,
)

WORKERS_DIR = REPO_ROOT / "workers"
# Non-stock test fixtures (input_types_test, etc.) were moved out of workers/
# into tests/fixtures/ (commit db255be) so they no longer ship as stock workers.
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _minimal_contract(**kwargs) -> dict:
    """Return a minimal valid WorkerContract dict, overrideable via kwargs."""
    base = {
        "schema_version": "0.3",
        "name": "test-worker",
        "title": "Test Worker",
        "description": "A test worker.",
        "version": "0.1.0",
        "exec": {
            "command": "python run.py",
            "runtime": "python311",
            "runner": "local",
            "inputs": [],
        },
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# Schema validator: long_description
# ---------------------------------------------------------------------------

class TestLongDescriptionValidator:
    def test_accepts_none(self):
        m = parse_worker_manifest(_minimal_contract())
        assert isinstance(m, WorkerContract)
        assert m.long_description is None

    def test_accepts_within_limit(self):
        m = parse_worker_manifest(_minimal_contract(long_description="x" * 2000))
        assert len(m.long_description) == 2000

    def test_rejects_over_2000_chars(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="2000"):
            parse_worker_manifest(_minimal_contract(long_description="x" * 2001))


# ---------------------------------------------------------------------------
# Schema validator: use_cases
# ---------------------------------------------------------------------------

class TestUseCasesValidator:
    def test_accepts_none(self):
        m = parse_worker_manifest(_minimal_contract())
        assert m.use_cases is None

    def test_accepts_three_items(self):
        cases = ["A", "B", "C"]
        m = parse_worker_manifest(_minimal_contract(use_cases=cases))
        assert m.use_cases == cases

    def test_accepts_five_items(self):
        cases = ["A", "B", "C", "D", "E"]
        m = parse_worker_manifest(_minimal_contract(use_cases=cases))
        assert len(m.use_cases) == 5

    def test_rejects_two_items(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="3 to 5"):
            parse_worker_manifest(_minimal_contract(use_cases=["A", "B"]))

    def test_rejects_six_items(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="3 to 5"):
            parse_worker_manifest(_minimal_contract(use_cases=["A", "B", "C", "D", "E", "F"]))

    def test_rejects_empty_item(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="non-empty"):
            parse_worker_manifest(_minimal_contract(use_cases=["A", "", "C"]))


# ---------------------------------------------------------------------------
# Schema validator: tags
# ---------------------------------------------------------------------------

class TestTagsValidator:
    def test_accepts_none(self):
        m = parse_worker_manifest(_minimal_contract())
        assert m.tags is None

    def test_accepts_up_to_eight(self):
        tags = [f"tag{i}" for i in range(8)]
        m = parse_worker_manifest(_minimal_contract(tags=tags))
        assert len(m.tags) == 8

    def test_rejects_more_than_eight(self):
        from pydantic import ValidationError
        tags = [f"tag{i}" for i in range(9)]
        with pytest.raises(ValidationError, match="8"):
            parse_worker_manifest(_minimal_contract(tags=tags))

    def test_rejects_tag_with_slash(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="flat"):
            parse_worker_manifest(_minimal_contract(tags=["recruiting/cv"]))

    def test_rejects_empty_tag(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="non-empty"):
            parse_worker_manifest(_minimal_contract(tags=["good", ""]))


# ---------------------------------------------------------------------------
# Schema validator: folder
# ---------------------------------------------------------------------------

class TestFolderValidator:
    def test_accepts_none(self):
        m = parse_worker_manifest(_minimal_contract())
        assert m.folder is None

    def test_accepts_simple_folder(self):
        m = parse_worker_manifest(_minimal_contract(folder="Recruiting"))
        assert m.folder == "Recruiting"

    def test_accepts_slash_nested_folder(self):
        m = parse_worker_manifest(_minimal_contract(folder="Operations/Reporting"))
        assert m.folder == "Operations/Reporting"

    def test_accepts_deeply_nested_folder(self):
        m = parse_worker_manifest(_minimal_contract(folder="Operations/Reporting/Weekly"))
        assert m.folder == "Operations/Reporting/Weekly"

    def test_rejects_folder_over_64_chars(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="64"):
            parse_worker_manifest(_minimal_contract(folder="A" * 65))

    def test_rejects_leading_slash(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="relative"):
            parse_worker_manifest(_minimal_contract(folder="/Recruiting"))

    def test_rejects_trailing_slash(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="relative"):
            parse_worker_manifest(_minimal_contract(folder="Recruiting/"))

    def test_rejects_double_dot_traversal(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="relative"):
            parse_worker_manifest(_minimal_contract(folder="Recruiting/../Admin"))

    def test_rejects_empty_path_segment(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError, match="non-empty"):
            parse_worker_manifest(_minimal_contract(folder="Recruiting//TeamB"))

    def test_exactly_64_chars_is_accepted(self):
        m = parse_worker_manifest(_minimal_contract(folder="A" * 64))
        assert len(m.folder) == 64


# ---------------------------------------------------------------------------
# Stock worker YAML round-trips
# ---------------------------------------------------------------------------

class TestStockWorkerManifests:
    @pytest.mark.parametrize("worker_id", sorted([
        d.name for d in WORKERS_DIR.iterdir()
        if d.is_dir() and (d / "worker.yml").is_file()
    ]))
    def test_manifest_roundtrip(self, worker_id):
        yml_path = WORKERS_DIR / worker_id / "worker.yml"
        raw = yaml.safe_load(yml_path.read_text())
        manifest = parse_worker_manifest(raw)
        # Must parse without error
        assert manifest is not None
        # schema_version 0.3 workers must produce WorkerContract
        if raw.get("schema_version") == "0.3":
            assert isinstance(manifest, WorkerContract)
            # new display fields must be accessible
            _ = manifest.long_description
            _ = manifest.use_cases
            _ = manifest.example_input
            _ = manifest.example_output
            _ = manifest.how_it_works
            _ = manifest.tags
            _ = manifest.folder

    def test_input_types_test_file_input_null(self):
        """input_types_test example_input must not contain a filename string for file_input."""
        raw = yaml.safe_load((FIXTURES_DIR / "input_types_test" / "worker.yml").read_text())
        m = parse_worker_manifest(raw)
        assert isinstance(m, WorkerContract)
        assert m.example_input is not None
        assert m.example_input.get("file_input") is None, (
            "file_input must be null in example_input to prevent base64 decode failure"
        )


# ---------------------------------------------------------------------------
# Unhappy-path: example_input edge cases (schema does NOT validate extra keys)
# ---------------------------------------------------------------------------

class TestExampleInputEdgeCases:
    def test_example_input_with_extra_keys_accepted(self):
        """WorkerContract schema accepts extra keys in example_input (open dict)."""
        data = _minimal_contract(example_input={"known_field": "value", "extra_field": 99})
        m = parse_worker_manifest(data)
        assert isinstance(m, WorkerContract)
        assert m.example_input["extra_field"] == 99

    def test_example_input_null_values_accepted(self):
        """Null values in example_input (for file fields) are valid."""
        data = _minimal_contract(example_input={"cv_file": None, "text": "hello"})
        m = parse_worker_manifest(data)
        assert m.example_input["cv_file"] is None


# ---------------------------------------------------------------------------
# Unhappy-path: 30 tags (over cap) — schema rejects with clear error
# ---------------------------------------------------------------------------

class TestTagsOverCapRejection:
    def test_30_tags_rejected_with_clear_error(self):
        from pydantic import ValidationError
        tags = [f"tag{i}" for i in range(30)]
        with pytest.raises(ValidationError) as exc_info:
            parse_worker_manifest(_minimal_contract(tags=tags))
        # Error message must mention the cap
        assert "8" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Unhappy-path: worker with no folder
# ---------------------------------------------------------------------------

class TestNoFolderField:
    def test_worker_without_folder_has_none(self):
        m = parse_worker_manifest(_minimal_contract())
        assert m.folder is None

    def test_worker_without_folder_round_trips(self):
        data = _minimal_contract()
        del data  # no 'folder' key
        data = _minimal_contract()
        data.pop("folder", None)
        m = parse_worker_manifest(data)
        assert m.folder is None


# ---------------------------------------------------------------------------
# API projection helpers (unit-level, no HTTP server needed)
# ---------------------------------------------------------------------------

class TestApiProjectionHelpers:
    """Verify discover_workers returns T2-B fields for filesystem workers."""

    def test_filesystem_workers_have_t2b_fields(self):
        """All filesystem-discovered workers expose T2-B metadata fields."""
        from worker_registry import discover_workers, invalidate_worker_cache
        invalidate_worker_cache()
        workers = discover_workers(use_cache=False)
        healthy = [w for w in workers if w.get("status") == "healthy"]
        assert len(healthy) >= 10, "Expect at least 10 healthy filesystem workers"
        for w in healthy:
            # Fields must exist (can be None, but must be present as keys)
            assert "long_description" in w, f"{w['id']} missing long_description"
            assert "use_cases" in w, f"{w['id']} missing use_cases"
            assert "example_input" in w, f"{w['id']} missing example_input"
            assert "example_output" in w, f"{w['id']} missing example_output"
            assert "how_it_works" in w, f"{w['id']} missing how_it_works"
            assert "tags" in w, f"{w['id']} missing tags"
            assert "folder" in w, f"{w['id']} missing folder"
            # tags must be a list (empty or populated)
            assert isinstance(w["tags"], list), f"{w['id']} tags must be list"
