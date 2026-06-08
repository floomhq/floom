from __future__ import annotations

import pytest

from db.factory import (
    Repositories,
    _repositories_factories,
    get_repositories,
    register_repositories,
)
from db.sqlite import SqliteWorkerRepository


class _FakeWorkerRepo:
    pass


def _fake_repos() -> Repositories:
    return Repositories(
        workers=_FakeWorkerRepo(),  # type: ignore[arg-type]
        runs=_FakeWorkerRepo(),  # type: ignore[arg-type]
        connections=_FakeWorkerRepo(),  # type: ignore[arg-type]
        secrets=_FakeWorkerRepo(),  # type: ignore[arg-type]
        cli_auth=_FakeWorkerRepo(),  # type: ignore[arg-type]
        approvals=_FakeWorkerRepo(),  # type: ignore[arg-type]
        alerts=_FakeWorkerRepo(),  # type: ignore[arg-type]
        mcp_tools=_FakeWorkerRepo(),  # type: ignore[arg-type]
    )


@pytest.fixture(autouse=True)
def _restore_registry(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    snapshot = dict(_repositories_factories)
    get_repositories.cache_clear()
    yield
    _repositories_factories.clear()
    _repositories_factories.update(snapshot)
    get_repositories.cache_clear()


def test_local_deploy_returns_sqlite_repositories(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    repos = get_repositories()

    assert isinstance(repos.workers, SqliteWorkerRepository)


def test_cloud_without_registered_repositories_raises(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    with pytest.raises(
        RuntimeError,
        match="No Repositories registered for WORKEROS_DEPLOY='cloud'",
    ):
        get_repositories()


def test_register_repositories_enables_lookup(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    register_repositories("cloud", _fake_repos)

    repos = get_repositories()
    assert isinstance(repos.workers, _FakeWorkerRepo)


def test_register_repositories_clears_cache(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    first = get_repositories()
    assert isinstance(first.workers, SqliteWorkerRepository)

    register_repositories("local", _fake_repos)

    second = get_repositories()
    assert isinstance(second.workers, _FakeWorkerRepo)


def test_unknown_deploy_value_raises(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "mystery")

    with pytest.raises(
        RuntimeError,
        match="No Repositories registered for WORKEROS_DEPLOY='mystery'",
    ):
        get_repositories()
