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
