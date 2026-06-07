"""N4-1 regression: scheduled runs must resolve owner-scoped secrets.

Root cause this guards against
------------------------------
A scheduled worker (`ai-news-discord-digest`, `linkedin_engagements`) failed
every hour with "missing required credential" even though its declared secrets
(``NEWS_API_KEY``, ``DISCORD_BOT_TOKEN`` ...) were set under the worker's owner.

The secret VALUE and the secret DB row are backed by two different stores:

* DB row  -> ``WORKEROS_DB`` / ``FLOOM_DB`` (absolute, stable).
* value   -> the env file resolved by ``db.secret_store_env_path()`` which
  honors ``WORKEROS_API_ENV_FILE`` / ``FLOOM_API_ENV_FILE``.

The write path (``SqliteSecretRepository.set``) wrote the value to the
configured env file, but the run-time read path
(``run_service._load_runtime_env_files``) IGNORED ``WORKEROS_API_ENV_FILE`` and
only loaded a source-relative ``apps/api/.env`` + a hardcoded path. So a secret
set under the correct owner was invisible at run time and the gate failed
``missing_secret`` on every scheduled run.

These tests pin the invariant: a secret set under the worker's owner via the
public secrets API resolves at run time on the SCHEDULED path (owner taken from
``list_scheduled()`` — exactly what ``scheduler._tick`` uses), and a genuinely
unset required secret still fails the gate.
"""

from __future__ import annotations

import importlib
import os

import pytest


_SECRET_ENV_NAMES = ("NEWS_API_KEY", "DISCORD_BOT_TOKEN")


@pytest.fixture
def run_service(repo_bundle):
    """``run_service`` reloaded against the fixture's freshly-built db modules.

    ``repo_bundle`` pops ``db.*`` + ``models`` from ``sys.modules`` and
    reimports them, which gives a NEW ``WorkerConfig`` class object. A
    ``run_service`` imported earlier would hold the stale class and its
    ``isinstance(config, WorkerConfig)`` recipe check would fail. Reloading
    here keeps run_service bound to the same module objects the repos use.
    """
    import run_service as _run_service

    return importlib.reload(_run_service)


@pytest.fixture(autouse=True)
def _isolate_secret_env_vars():
    """Restore process env for the secret names around each test.

    ``_read_env_var`` consults ``os.environ`` first, and both ``secrets.set``
    and ``_load_runtime_env_files`` write the secret VALUES into ``os.environ``.
    In a long-lived prod process that is intended (set once, read many), but in
    the test process it would let one test's value leak into the next. We snap
    and restore so each test starts from a clean slate.
    """
    saved = {name: os.environ.get(name) for name in _SECRET_ENV_NAMES}
    for name in _SECRET_ENV_NAMES:
        os.environ.pop(name, None)
    try:
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def _scheduled_news_manifest(worker_id: str, name: str) -> dict[str, object]:
    return {
        "id": worker_id,
        "name": name,
        "trigger": {"type": "schedule"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": ["NEWS_API_KEY", "DISCORD_BOT_TOKEN"],
        "connections": [],
    }


def _gate_missing(config_secrets, resolved):
    """Mirror the execute_run secret gate: which declared secrets are unresolved."""
    return [s for s in config_secrets if s not in resolved]


def _simulate_fresh_process():
    """Drop the secret names from ``os.environ``.

    ``secrets.set`` writes the value to BOTH the configured env file AND
    ``os.environ`` (so the same long-lived process sees it immediately). The
    N4-1 failure happens across a process boundary: the API/scheduler that
    RUNS the worker is a different (or restarted) process whose ``os.environ``
    does NOT contain the value — it must be re-loaded from the configured env
    file by ``_load_runtime_env_files``. Clearing the env vars here forces
    resolution through that file-load path, which is exactly what the fix
    repairs (the old loader ignored WORKEROS_API_ENV_FILE and would resolve to
    "missing").
    """
    for name in _SECRET_ENV_NAMES:
        os.environ.pop(name, None)


def test_scheduled_run_resolves_owner_scoped_secrets(repo_bundle, run_service):
    repos, _db, _manifest = repo_bundle

    owner = "federico"
    worker_id = "ai-news-discord-digest"

    repos.workers.create(
        user_id=owner,
        worker_id=worker_id,
        name="AI News Discord Digest",
        manifest_json=_scheduled_news_manifest(worker_id, "AI News Discord Digest"),
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="0 * * * *",
    )

    # Both required secrets are SET under the worker's owner via the public
    # secrets API (the same write path the UI uses).
    repos.secrets.set(user_id=owner, name="NEWS_API_KEY", value="news-secret-123")
    repos.secrets.set(user_id=owner, name="DISCORD_BOT_TOKEN", value="discord-secret-456")

    # The scheduler determines a scheduled run's owner from list_scheduled().
    scheduled = repos.workers.list_scheduled()
    assert [w["id"] for w in scheduled] == [worker_id]
    scheduled_owner = scheduled[0]["owner_id"]
    # Owner-scope is consistent across the manual and scheduled paths.
    assert scheduled_owner == owner == repos.workers.get_owner(worker_id=worker_id)

    # Simulate the run happening in a fresh process (no value pre-loaded into
    # os.environ), so resolution MUST come from the configured env file.
    _simulate_fresh_process()

    # Run-time secret resolution must surface the configured secret-store env
    # file (regression: it previously ignored WORKEROS_API_ENV_FILE).
    run_service._load_runtime_env_files()

    # Resolve secrets exactly as execute_run does on the scheduled path:
    # owner_id == scheduled_owner.
    resolved = run_service.get_secrets_for_worker(
        worker_id, user_id=scheduled_owner, repos=repos
    )

    assert resolved.get("NEWS_API_KEY") == "news-secret-123"
    assert resolved.get("DISCORD_BOT_TOKEN") == "discord-secret-456"

    # The execute_run gate would NOT fail "missing_secret".
    config = run_service._get_worker_config_for_run(worker_id, repos)
    assert config is not None
    assert _gate_missing(config.secrets, resolved) == []


def test_scheduled_run_still_fails_when_secret_genuinely_missing(repo_bundle, run_service):
    repos, _db, _manifest = repo_bundle

    owner = "federico"
    worker_id = "ai-news-discord-digest"

    repos.workers.create(
        user_id=owner,
        worker_id=worker_id,
        name="AI News Discord Digest",
        manifest_json=_scheduled_news_manifest(worker_id, "AI News Discord Digest"),
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="0 * * * *",
    )

    # Only one of the two required secrets is set; the other is genuinely
    # missing and the gate must still reject it (security/correctness intact).
    repos.secrets.set(user_id=owner, name="NEWS_API_KEY", value="news-secret-123")

    run_service._load_runtime_env_files()
    resolved = run_service.get_secrets_for_worker(worker_id, user_id=owner, repos=repos)
    config = run_service._get_worker_config_for_run(worker_id, repos)

    assert resolved.get("NEWS_API_KEY") == "news-secret-123"
    assert "DISCORD_BOT_TOKEN" not in resolved
    assert _gate_missing(config.secrets, resolved) == ["DISCORD_BOT_TOKEN"]


def test_scheduled_secret_not_resolved_under_wrong_owner(repo_bundle, run_service):
    """Owner-scoping is preserved: a secret set under owner A does NOT leak to
    a worker owned by owner B. The fix corrects WHICH owner is used, it does
    not weaken owner isolation."""
    repos, _db, _manifest = repo_bundle

    worker_id = "ai-news-discord-digest"
    repos.workers.create(
        user_id="owner-b",
        worker_id=worker_id,
        name="AI News Discord Digest",
        manifest_json=_scheduled_news_manifest(worker_id, "AI News Discord Digest"),
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="0 * * * *",
    )

    # Secret set under a DIFFERENT owner.
    repos.secrets.set(user_id="owner-a", name="NEWS_API_KEY", value="a-only")

    run_service._load_runtime_env_files()
    resolved = run_service.get_secrets_for_worker(worker_id, user_id="owner-b", repos=repos)

    assert "NEWS_API_KEY" not in resolved
    config = run_service._get_worker_config_for_run(worker_id, repos)
    assert "NEWS_API_KEY" in _gate_missing(config.secrets, resolved)


def test_shared_worker_run_scopes_secrets_to_owner_not_runner(repo_bundle, run_service):
    """Members STEP 1 secret-scoping guard (Codex top risk).

    When a member RUNS a shared (workspace-visibility) worker, the run is created
    with the RUNNER's id as ``user_id``. Secrets MUST still resolve to the
    worker's OWNER, never the runner:

      * the owner's declared secret resolves (the run would otherwise fail), and
      * the runner's OWN identically-named private secret is NOT used (no leak of
        the runner's value into someone else's worker).
    """
    repos, _db, _manifest = repo_bundle

    owner = "owner-1"
    runner = "member-2"
    worker_id = "ai-news-discord-digest"

    repos.workers.create(
        user_id=owner,
        worker_id=worker_id,
        name="AI News Discord Digest",
        manifest_json=_scheduled_news_manifest(worker_id, "AI News Discord Digest"),
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="0 * * * *",
    )

    # Owner has the real value; the runner has a DIFFERENT value under the same
    # name in their own secret store.
    repos.secrets.set(user_id=owner, name="NEWS_API_KEY", value="owner-news-value")
    repos.secrets.set(user_id=owner, name="DISCORD_BOT_TOKEN", value="owner-discord-value")
    repos.secrets.set(user_id=runner, name="NEWS_API_KEY", value="RUNNER-LEAK-value")

    _simulate_fresh_process()
    run_service._load_runtime_env_files()

    # The run passes the RUNNER as user_id (as create_worker_run does).
    resolved = run_service.get_secrets_for_worker(
        worker_id, user_id=runner, repos=repos
    )

    # Resolved to the OWNER's values, never the runner's.
    assert resolved.get("NEWS_API_KEY") == "owner-news-value"
    assert resolved.get("DISCORD_BOT_TOKEN") == "owner-discord-value"
    assert resolved.get("NEWS_API_KEY") != "RUNNER-LEAK-value"


def test_secret_store_path_is_db_anchored_not_source_relative(monkeypatch, tmp_path):
    """The N4-1 root cause: the secret-value store must be anchored to the DB
    directory, NOT to the source tree. A source-relative path diverges across
    deploy directories (/root/workeros vs /opt/workeros-live) while the DB
    (absolute) is shared, orphaning secret values.

    With no explicit WORKEROS_API_ENV_FILE, the store must co-locate with the
    absolute DB path so two checkouts serving the same DB resolve to the SAME
    file.
    """
    import importlib
    import sys

    db_dir = tmp_path / "data"
    db_dir.mkdir()
    db_path = db_dir / "floom.db"

    monkeypatch.delenv("WORKEROS_API_ENV_FILE", raising=False)
    monkeypatch.delenv("FLOOM_API_ENV_FILE", raising=False)
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in ["db", "db.sqlite"]:
        sys.modules.pop(name, None)
    sqlite = importlib.import_module("db.sqlite")

    store = sqlite.secret_store_env_path()
    # Co-located with the DB, deploy-dir-independent.
    assert store == db_dir / "secrets.env"
    # NOT the source-relative apps/api/.env (the bug).
    assert store != sqlite._legacy_source_relative_env_path()

    # Reads still union the legacy source-relative file so pre-fix secrets
    # written into a deploy tree's apps/api/.env are not lost.
    read_paths = sqlite.secret_store_read_paths()
    assert store == read_paths[0]
    assert sqlite._legacy_source_relative_env_path() in read_paths


def test_secret_value_survives_deploy_directory_change(monkeypatch, tmp_path):
    """End-to-end of the N4-1 fix: a secret SET while serving an absolute DB is
    READABLE after the serving process restarts from a different checkout
    (different source tree), because the store is DB-anchored, not
    source-relative."""
    import importlib
    import sys

    db_dir = tmp_path / "data"
    db_dir.mkdir()
    db_path = db_dir / "floom.db"

    monkeypatch.delenv("WORKEROS_API_ENV_FILE", raising=False)
    monkeypatch.delenv("FLOOM_API_ENV_FILE", raising=False)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models",
    ]:
        sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    repos = db.get_repositories()

    repos.secrets.set(user_id="federico", name="NEWS_API_KEY", value="news-xyz")

    # The value landed in the DB-anchored store, not a source-relative file.
    assert (db_dir / "secrets.env").is_file()
    assert "NEWS_API_KEY=news-xyz" in (db_dir / "secrets.env").read_text()

    # Simulate a restart from a *different* deploy directory: clear os.environ
    # of the loaded value and rebuild the db module objects (new __file__ would
    # point at a different tree, but the DB anchor is unchanged).
    import os
    os.environ.pop("NEWS_API_KEY", None)
    for name in ["db", "db.sqlite"]:
        sys.modules.pop(name, None)
    sqlite2 = importlib.import_module("db.sqlite")

    assert sqlite2._read_env_var("NEWS_API_KEY") == "news-xyz"
