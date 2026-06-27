from __future__ import annotations


def _manifest(worker_id: str, name: str, contexts: list[object]) -> dict[str, object]:
    return {
        "id": worker_id,
        "name": name,
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
        "contexts": contexts,
    }


def test_sqlite_worker_repository_context_worker_counts(repo_bundle):
    repos, _db, _base_manifest = repo_bundle
    repos.workers.upsert(
        user_id="user-a",
        worker_id="worker-a",
        name="Worker A",
        manifest_json=_manifest("worker-a", "Worker A", ["pack", {"name": "memory"}]),
        bundle_path="workers/worker-a",
    )
    repos.workers.upsert(
        user_id="user-a",
        worker_id="worker-b",
        name="Worker B",
        manifest_json=_manifest("worker-b", "Worker B", ["pack"]),
        bundle_path="workers/worker-b",
    )
    repos.workers.upsert(
        user_id="user-b",
        worker_id="worker-c",
        name="Worker C",
        manifest_json=_manifest("worker-c", "Worker C", ["other-pack"]),
        bundle_path="workers/worker-c",
    )

    counts = repos.workers.context_worker_counts(user_id="user-a")

    assert counts["memory"] == 1
    assert counts["pack"] == 2
    assert "other-pack" not in counts
