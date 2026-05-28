import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

import run_service  # noqa: E402
import runner_sandbox.agent_driver as agent_module  # noqa: E402
from models import WorkerConfig, WorkerOutput, WorkerRuntime, WorkerTrigger  # noqa: E402
from runner_sandbox.agent_driver import AgentDriver  # noqa: E402


def _config(outputs):
    return WorkerConfig(
        id="quality-test",
        name="Quality Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="skill", entrypoint="SKILL.md", runner="e2b", mode="agent"),
        outputs=outputs,
    )


def _artifact(tmp_path, run_id, relative_path, content, media_type="text/plain"):
    path = tmp_path / "artifacts" / run_id / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return {
        "name": relative_path,
        "relative_path": relative_path,
        "type": media_type,
        "path": str(path),
        "size_bytes": path.stat().st_size,
    }


def test_file_output_too_small_fails(tmp_path, monkeypatch):
    run_id = "run_small"
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    config = _config([
        WorkerOutput(
            name="update",
            label="Update",
            type="file",
            kind="file",
            media_type="text/markdown",
            path="out/update.md",
        )
    ])
    artifact = _artifact(tmp_path, run_id, "out/update.md", "short", "text/markdown")

    error, warnings = run_service._validate_run_outputs(run_id, config, {"update": "short"}, [artifact])

    assert warnings == []
    assert "file is too small" in error


def test_file_output_content_is_materialized_before_validation(tmp_path, monkeypatch):
    run_id = "run_materialize"
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    config = _config([
        WorkerOutput(
            name="update",
            label="Update",
            type="file",
            kind="file",
            media_type="text/markdown",
            path="out/update.md",
        )
    ])
    outputs = {"update": "# Update\n\n" + ("real content " * 20)}
    artifacts = []

    run_service._materialize_declared_file_outputs(run_id, config, outputs, artifacts)
    error, warnings = run_service._validate_run_outputs(run_id, config, outputs, artifacts)

    assert error is None
    assert warnings == []
    assert artifacts[0]["name"] == "out/update.md"
    assert (tmp_path / "artifacts" / run_id / "out" / "update.md").is_file()


def test_optional_file_output_can_be_absent(tmp_path, monkeypatch):
    run_id = "run_optional_missing"
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    config = _config([
        WorkerOutput(
            name="preview_html",
            label="Preview HTML",
            type="file",
            kind="file",
            media_type="text/html",
            path="out/preview.html",
            required=False,
        )
    ])

    error, warnings = run_service._validate_run_outputs(run_id, config, {}, [])

    assert error is None
    assert warnings == []


def test_optional_file_output_is_validated_when_emitted(tmp_path, monkeypatch):
    run_id = "run_optional_emitted"
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    config = _config([
        WorkerOutput(
            name="preview_html",
            label="Preview HTML",
            type="file",
            kind="file",
            media_type="text/html",
            path="out/preview.html",
            required=False,
        )
    ])
    artifact = _artifact(tmp_path, run_id, "out/preview.html", "tiny", "text/html")

    error, warnings = run_service._validate_run_outputs(run_id, config, {"preview_html": "out/preview.html"}, [artifact])

    assert warnings == []
    assert "file is too small" in error


def test_json_file_output_must_parse(tmp_path, monkeypatch):
    run_id = "run_json"
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    config = _config([
        WorkerOutput(
            name="payload",
            label="Payload",
            type="file",
            kind="file",
            media_type="application/json",
            path="out/payload.json",
        )
    ])
    artifact = _artifact(tmp_path, run_id, "out/payload.json", "not json " * 20, "application/json")

    error, warnings = run_service._validate_run_outputs(run_id, config, {"payload": {}}, [artifact])

    assert warnings == []
    assert "JSON file is invalid" in error


def test_scalar_path_leak_fails():
    config = _config([
        WorkerOutput(name="update", label="Update", type="text", kind="scalar", required=True)
    ])

    error, warnings = run_service._validate_run_outputs("run_path", config, {"update": "out/update.md"}, [])

    assert warnings == []
    assert error == "output_validation_failed: update scalar output leaked a path string"


def test_placeholder_content_records_warning():
    config = _config([
        WorkerOutput(name="summary", label="Summary", type="text", kind="scalar", required=True)
    ])

    error, warnings = run_service._validate_run_outputs(
        "run_warning",
        config,
        {"summary": "I don't have access to the requested account."},
        [],
    )

    assert error is None
    assert warnings == ["summary: output looks like placeholder/apology content"]


def test_agent_driver_rejects_scalar_path_before_finalizing(tmp_path, monkeypatch):
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    monkeypatch.setattr(agent_module, "ARTIFACTS_DIR", artifacts_dir)
    config = _config([
        WorkerOutput(name="summary", label="Summary", type="text", kind="scalar", required=True)
    ])
    output_dir = artifacts_dir / "run_agent_path" / "outputs"
    output_dir.mkdir(parents=True)

    result = AgentDriver()._write_output(
        {"name": "summary", "content": "out/summary.md"},
        output_dir,
        {},
        [],
        config,
    )

    assert result["ok"] is False
    assert "looks like a file path" in result["error"]
