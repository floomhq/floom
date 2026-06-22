from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerInput, WorkerRuntime, WorkerTrigger


def _config(inputs: list[WorkerInput]) -> WorkerConfig:
    return WorkerConfig(
        id="media-worker",
        name="Media Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", entrypoint="run.py", command="python run.py"),
        inputs=inputs,
    )


def _uploaded(file_id: str, filename: str = "clip.mp4") -> dict:
    return {
        "id": file_id,
        "sha256": file_id,
        "filename": filename,
        "media_type": "video/mp4",
        "size": 123,
        "url": f"/uploads/{file_id}?download_token=t",
    }


def test_inbox_maps_single_file_to_only_file_input():
    import main

    file_id = "a" * 64
    inputs = main._build_inbox_run_inputs(
        config=_config([WorkerInput(name="clip", label="Clip", type="file", required=True)]),
        uploaded_files=[_uploaded(file_id)],
        input_name=None,
        group_id="episode-1",
        metadata={"source": "shortcut"},
    )

    assert inputs["clip"] == file_id
    assert inputs["inbox"] == {
        "group_id": "episode-1",
        "file_count": 1,
        "metadata": {"source": "shortcut"},
    }


def test_inbox_groups_multiple_files_into_one_file_input_list():
    import main

    first = "a" * 64
    second = "b" * 64
    inputs = main._build_inbox_run_inputs(
        config=_config([WorkerInput(name="clips", label="Clips", type="file", required=True)]),
        uploaded_files=[_uploaded(first, "one.mp4"), _uploaded(second, "two.mp4")],
        input_name=None,
        group_id="episode-2",
        metadata={},
    )

    assert inputs["clips"] == [first, second]
    assert inputs["inbox"]["file_count"] == 2


def test_inbox_requires_input_name_when_file_input_is_ambiguous():
    import main

    with pytest.raises(HTTPException) as excinfo:
        main._build_inbox_run_inputs(
            config=_config(
                [
                    WorkerInput(name="intro", label="Intro", type="file", required=True),
                    WorkerInput(name="outro", label="Outro", type="file", required=True),
                ]
            ),
            uploaded_files=[_uploaded("a" * 64)],
            input_name=None,
            group_id=None,
            metadata={},
        )

    assert excinfo.value.status_code == 400
    assert "input_name is required" in str(excinfo.value.detail)


def test_file_input_validation_accepts_grouped_sha_list():
    import main

    config = _config([WorkerInput(name="clips", label="Clips", type="file", required=True)])
    main._validate_file_input_references(config, {"clips": ["a" * 64, "b" * 64]})


def test_file_input_validation_rejects_non_sha_inside_group():
    import main

    config = _config([WorkerInput(name="clips", label="Clips", type="file", required=True)])
    with pytest.raises(HTTPException) as excinfo:
        main._validate_file_input_references(config, {"clips": ["a" * 64, "not-a-sha"]})

    assert excinfo.value.status_code == 400
    assert "SHA-256 reference" in str(excinfo.value.detail)


def test_inbox_rate_limit_is_keyed_per_user_and_worker(monkeypatch):
    import main

    main._inbox_rate_store.clear()
    monkeypatch.setenv("FLOOM_INBOX_RATE_LIMIT", "1")
    monkeypatch.setenv("FLOOM_INBOX_RATE_WINDOW_SECONDS", "60")

    assert main._check_inbox_rate_limit("user:alice:worker:w1:inbox") is True
    assert main._check_inbox_rate_limit("user:alice:worker:w1:inbox") is False
    assert main._check_inbox_rate_limit("user:alice:worker:w2:inbox") is True
    assert main._check_inbox_rate_limit("user:bob:worker:w1:inbox") is True


def test_inbox_file_count_cap_is_configurable(monkeypatch):
    import main

    monkeypatch.setenv("FLOOM_INBOX_MAX_FILES", "3")
    assert main._inbox_file_limit() == 3
    monkeypatch.setenv("FLOOM_INBOX_MAX_FILES", "bad")
    assert main._inbox_file_limit() == 25


def test_inbox_route_checks_visibility_before_upload_storage():
    source = (API_DIR / "main.py").read_text(encoding="utf-8")
    route_start = source.index("async def upload_worker_inbox")
    route_end = source.index("return create_worker_run", route_start)
    route_body = source[route_start:route_end]
    visibility = route_body.index("_get_visible_worker")
    store = route_body.index("stored = await _store_uploaded_blob")
    assert visibility < store
