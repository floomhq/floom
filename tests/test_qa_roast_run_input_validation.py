from __future__ import annotations

from fastapi.testclient import TestClient

from test_round8_worker_authz import AUTH, _load_api


def test_worker_run_rejects_non_object_inputs(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    headers = {**AUTH, "x-floom-user": "input-probe"}

    for malformed in ([], None):
        response = client.post(
            "/workers/any-worker/runs",
            headers=headers,
            json={"inputs": malformed, "trigger_source": "manual"},
        )

        assert response.status_code == 422, response.text

