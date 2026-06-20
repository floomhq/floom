def test_run_perf_timer_logs_segments(monkeypatch):
    import run_service

    monkeypatch.setenv("WORKEROS_RUN_PERF_LOGS", "1")
    logs: list[tuple[str, str]] = []
    timer = run_service._RunPerfTimer()
    timer.mark("first")
    timer.mark("second")

    timer.log(lambda msg, level: logs.append((msg, level)), "test.timer")

    assert len(logs) == 1
    assert logs[0][1] == "debug"
    assert logs[0][0].startswith("[perf] test.timer total=")
    assert "first=" in logs[0][0]
    assert "second=" in logs[0][0]


def test_run_perf_timer_can_be_disabled(monkeypatch):
    import run_service

    monkeypatch.setenv("WORKEROS_RUN_PERF_LOGS", "0")
    logs: list[tuple[str, str]] = []
    timer = run_service._RunPerfTimer()
    timer.mark("first")

    timer.log(lambda msg, level: logs.append((msg, level)), "test.timer")

    assert logs == []


def test_async_log_flush_defaults_on_for_hosted_env(monkeypatch):
    import run_service

    monkeypatch.delenv("WORKEROS_ASYNC_LOG_FLUSH", raising=False)
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT", "production")

    assert run_service._async_log_flush_enabled() is True


def test_async_log_flush_explicit_off_wins(monkeypatch):
    import run_service

    monkeypatch.setenv("WORKEROS_ASYNC_LOG_FLUSH", "0")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT", "production")

    assert run_service._async_log_flush_enabled() is False


def test_db_manifest_files_attach_trusted_bundle_sha():
    import json

    from db.sqlite import _config_from_manifest

    manifest = {
        "id": "w",
        "name": "Worker",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "command": "python run.py"},
        "_files": {
            "worker.yml": "name: Worker\n",
            "run.py": "print('ok')\n",
        },
    }

    config = _config_from_manifest(
        worker_id="w",
        manifest_json=json.dumps(manifest),
        trigger_type="manual",
        cron_expr=None,
        cron_timezone=None,
        bundle_path="workers/w",
    )

    assert config is not None
    assert config.runtime.bundle_sha256
    assert len(config.runtime.bundle_sha256) == 64


def test_db_manifest_files_overwrite_stale_bundle_sha():
    import json

    from db.sqlite import _config_from_manifest

    manifest = {
        "id": "w",
        "name": "Worker",
        "trigger": {"type": "manual"},
        "runtime": {
            "type": "python",
            "command": "python run.py",
            "bundle_sha256": "0" * 64,
        },
        "_files": {
            "worker.yml": "name: Worker\n",
            "run.py": "print('fresh')\n",
        },
    }

    config = _config_from_manifest(
        worker_id="w",
        manifest_json=json.dumps(manifest),
        trigger_type="manual",
        cron_expr=None,
        cron_timezone=None,
        bundle_path="workers/w",
    )

    assert config is not None
    assert config.runtime.bundle_sha256
    assert config.runtime.bundle_sha256 != "0" * 64
