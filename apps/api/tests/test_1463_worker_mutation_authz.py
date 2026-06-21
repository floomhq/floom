from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from auth.context import AuthContext


def _request() -> Request:
    return Request({"type": "http", "headers": [(b"host", b"testserver")], "query_string": b""})


def _member_auth() -> AuthContext:
    return AuthContext(user_id="member-user", role="member", auth_method="session")


def _repos():
    workers = SimpleNamespace(update=lambda **_kwargs: (_ for _ in ()).throw(AssertionError("mutated worker")))
    return SimpleNamespace(workers=workers)


def test_pause_resume_denies_workspace_member_without_owner_or_admin(monkeypatch):
    import services.worker_mutation as mutation

    monkeypatch.setattr(mutation, "_worker_for_mutation", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        mutation._set_worker_enabled(
            "shared-worker",
            enabled=False,
            auth=_member_auth(),
            repos=_repos(),
            request=_request(),
        )

    assert exc.value.status_code == 404


def test_context_mutation_denies_workspace_member_without_owner_or_admin(monkeypatch):
    import services.worker_mutation as mutation

    monkeypatch.setattr(mutation, "_worker_for_mutation", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        mutation._mutate_worker_contexts(
            "shared-worker",
            lambda contexts: contexts,
            auth=_member_auth(),
            repos=_repos(),
            request=_request(),
        )

    assert exc.value.status_code == 404


def test_rollback_denies_workspace_member_before_mutation(monkeypatch):
    import routers.worker_versions as versions

    monkeypatch.setattr(versions, "_worker_for_mutation", lambda *_args, **_kwargs: {"id": "shared-worker"})

    with pytest.raises(HTTPException) as exc:
        versions.rollback_worker(
            "shared-worker",
            "deadbeef",
            _request(),
            auth=_member_auth(),
            repos=_repos(),
        )

    assert exc.value.status_code == 403


def test_webhook_secret_rotation_denies_workspace_member_without_owner_or_admin(monkeypatch):
    import main

    monkeypatch.setattr(main, "_worker_for_mutation", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        main.rotate_webhook_secret("shared-worker", auth=_member_auth(), repos=_repos())

    assert exc.value.status_code == 404


def test_patch_worker_denies_workspace_member_before_webhook_secret_rotate(monkeypatch):
    import main
    from models import WorkerUpdateRequest

    monkeypatch.setattr(main, "_worker_for_mutation", lambda *_args, **_kwargs: None)
    endpoint = next(
        route.endpoint
        for route in main.app.routes
        if getattr(route, "path", "") == "/workers/{worker_id}"
        and "PATCH" in getattr(route, "methods", set())
    )

    with pytest.raises(HTTPException) as exc:
        endpoint(
            "shared-worker",
            WorkerUpdateRequest(webhook_secret_rotate=True),
            _request(),
            auth=_member_auth(),
            repos=_repos(),
        )

    assert exc.value.status_code == 404


def test_star_denies_workspace_member_without_owner_or_admin(monkeypatch):
    import routers.worker_lifecycle as lifecycle

    monkeypatch.setattr(lifecycle, "_worker_for_mutation", lambda *_args, **_kwargs: None)

    with pytest.raises(HTTPException) as exc:
        lifecycle.toggle_worker_star("shared-worker", auth=_member_auth(), repos=_repos())

    assert exc.value.status_code == 404
