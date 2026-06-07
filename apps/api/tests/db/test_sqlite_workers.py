from __future__ import annotations


def test_worker_repo_scopes_crud_by_user(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=manifest("worker-a", "Worker A"),
        bundle_path="workers/worker-a",
    )
    repos.workers.create(
        user_id="user-b",
        worker_id="worker-b",
        name="Worker B",
        manifest_json=manifest("worker-b", "Worker B"),
        bundle_path="workers/worker-b",
    )

    assert [item["id"] for item in repos.workers.list(user_id="user-a")] == ["worker-a"]
    assert [item["id"] for item in repos.workers.list(user_id="user-b")] == ["worker-b"]
    assert repos.workers.get(user_id="user-a", worker_id="worker-b") is None

    updated = repos.workers.update(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A Updated",
        trigger_type="schedule",
        cron_expr="0 9 * * *",
    )
    assert updated is not None
    assert updated["name"] == "Worker A Updated"
    assert updated["trigger_type"] == "schedule"

    assert repos.workers.delete(user_id="user-a", worker_id="worker-a") is True
    assert repos.workers.get(user_id="user-a", worker_id="worker-a") is None
    assert repos.workers.get(user_id="user-b", worker_id="worker-b") is not None


def test_worker_repo_treats_cron_alias_as_scheduled(repo_bundle):
    repos, _db, manifest = repo_bundle

    repos.workers.create(
        user_id="user-a",
        worker_id="cron-worker",
        name="Cron Worker",
        manifest_json=manifest("cron-worker", "Cron Worker"),
        bundle_path="workers/cron-worker",
        trigger_type="cron",
        cron_expr="0 7 * * *",
    )

    scheduled = repos.workers.list_scheduled()
    assert [item["id"] for item in scheduled] == ["cron-worker"]
    assert scheduled[0]["cron_expr"] == "0 7 * * *"
