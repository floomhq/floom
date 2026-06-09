import importlib.util
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKER_DIR = ROOT / "workers" / "research_brief"


def _load_run_module():
    spec = importlib.util.spec_from_file_location(
        "research_brief_run",
        WORKER_DIR / "run.py",
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_research_brief_writes_declared_file_artifact(tmp_path):
    manifest = yaml.safe_load((WORKER_DIR / "worker.yml").read_text(encoding="utf-8"))
    declared = manifest["exec"]["outputs"][0]
    assert declared["name"] == "brief"
    assert declared["path"] == "out/brief.md"

    module = _load_run_module()
    logs: list[tuple[str, str]] = []

    result = module.run(
        {"topic": "AI agents in DACH", "audience": "executive", "depth": "overview"},
        {
            "artifact_dir": str(tmp_path),
            "secrets": {},
            "log": lambda message, level="info": logs.append((level, message)),
        },
    )

    artifact_path = tmp_path / "out" / "brief.md"
    assert result["status"] == "success"
    assert result["outputs"]["brief"] == "out/brief.md"
    assert artifact_path.is_file()
    assert artifact_path.read_text(encoding="utf-8").strip()
    assert result["artifacts"] == [
        {
            "name": "out/brief.md",
            "relative_path": "out/brief.md",
            "type": "text/markdown",
            "path": str(artifact_path),
            "size_bytes": artifact_path.stat().st_size,
        }
    ]
