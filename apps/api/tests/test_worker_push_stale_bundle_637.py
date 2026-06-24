from __future__ import annotations

from pathlib import Path


def test_same_skill_version_update_rematerializes_changed_worker_files(monkeypatch, tmp_path):
    from apps.api.db import supabase_repos

    workers_dir = tmp_path / "workers"
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    supabase_repos._materialized_versions.clear()

    try:
        version_key = "stale-worker::sv_stale_worker_0_1_0"
        supabase_repos._materialize_worker_files(
            "stale-worker",
            {
                "worker.yml": "name: stale-worker\nversion: 0.1.0\n",
                "run.py": "print('old')\n",
            },
            version_key=version_key,
        )
        supabase_repos._materialize_worker_files(
            "stale-worker",
            {
                "worker.yml": "name: stale-worker\nversion: 0.1.0\n",
                "run.py": "print('new marker floomhq-workeros-cloud-637')\n",
            },
            version_key=version_key,
        )

        run_py = Path(workers_dir, "stale-worker", "run.py")
        assert run_py.read_text(encoding="utf-8") == "print('new marker floomhq-workeros-cloud-637')\n"
    finally:
        supabase_repos._materialized_versions.clear()


def test_bundle_sha_changes_when_worker_file_content_changes():
    from apps.api.db.supabase_repos import _bundle_sha256_from_worker_files

    first = _bundle_sha256_from_worker_files(
        {
            "worker.yml": "name: stale-worker\nversion: 0.1.0\n",
            "run.py": "print('old')\n",
        }
    )
    second = _bundle_sha256_from_worker_files(
        {
            "worker.yml": "name: stale-worker\nversion: 0.1.0\n",
            "run.py": "print('new marker floomhq-workeros-cloud-637')\n",
        }
    )

    assert first
    assert second
    assert first != second
