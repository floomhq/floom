from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import apps.api.routes.novasearch as nova


VALID_ID = "a" * 32
WORKSPACE_ID = "ws_test"
QUERY_OWNER_ID = "query_owner"
REVIEWER_ID = "reviewer_user"

QUERY_ROW = {
    "id": VALID_ID,
    "workspace_id": WORKSPACE_ID,
    "user_id": QUERY_OWNER_ID,
    "job_title": "Backend Engineer",
    "top_json": [
        {
            "rank": 1,
            "name": "Alice",
            "title": "Senior Engineer",
            "company": "Acme",
            "score": 91,
            "candidate_key": "candidate-1",
        }
    ],
}


class _FakeSupabaseClient:
    last_payload: dict[str, Any] | None = None
    table_name: str | None = None

    def table(self, name: str) -> "_FakeSupabaseClient":
        self.table_name = name
        return self

    def select(self, *_args: Any, **_kwargs: Any) -> "_FakeSupabaseClient":
        return self

    def eq(self, *_args: Any, **_kwargs: Any) -> "_FakeSupabaseClient":
        return self

    def upsert(self, payload: dict[str, Any], **_kwargs: Any) -> "_FakeSupabaseClient":
        self.last_payload = dict(payload)
        return self

    def execute(self) -> Any:
        return type("Response", (), {"data": []})()


def _client(
    monkeypatch,
    *,
    auth_user_id: str | None,
    active_workspace_id: str | None = WORKSPACE_ID,
    active_member_role: str | None = "member",
    query_row: dict[str, Any] | None = QUERY_ROW,
    supabase: _FakeSupabaseClient | None = None,
) -> TestClient:
    from auth import AuthContext, get_auth_context

    monkeypatch.setattr(nova, "_query_row_by_id", lambda _query_id: query_row)
    monkeypatch.setattr(nova, "get_active_workspace_id", lambda: active_workspace_id)
    monkeypatch.setattr(nova, "get_active_member_role", lambda: active_member_role)
    monkeypatch.setattr(nova, "new_supabase_service_client", lambda: supabase or _FakeSupabaseClient())

    app = FastAPI()
    app.include_router(nova.router, prefix="/api")

    if auth_user_id is None:
        def _deny() -> None:
            raise HTTPException(status_code=401, detail="unauthorized")

        app.dependency_overrides[get_auth_context] = _deny
    else:
        app.dependency_overrides[get_auth_context] = lambda: AuthContext(
            user_id=auth_user_id,
            role="member",
            auth_method="session",
        )

    return TestClient(app, raise_server_exceptions=False)


def test_review_page_requires_auth(monkeypatch):
    client = _client(monkeypatch, auth_user_id=None)

    response = client.get(f"/api/novasearch/review/{VALID_ID}")

    assert response.status_code == 401


def test_review_page_requires_active_workspace_match(monkeypatch):
    client = _client(
        monkeypatch,
        auth_user_id=REVIEWER_ID,
        active_workspace_id="ws_other",
    )

    response = client.get(f"/api/novasearch/review/{VALID_ID}")

    assert response.status_code == 404


def test_review_page_rejects_non_owner_member(monkeypatch):
    client = _client(monkeypatch, auth_user_id=REVIEWER_ID, active_member_role="member")

    response = client.get(f"/api/novasearch/review/{VALID_ID}")

    assert response.status_code == 403


def test_review_page_renders_for_query_owner(monkeypatch):
    client = _client(monkeypatch, auth_user_id=QUERY_OWNER_ID, active_member_role="member")

    response = client.get(f"/api/novasearch/review/{VALID_ID}")

    assert response.status_code == 200
    assert "Backend Engineer" in response.text
    assert "Alice" in response.text


def test_review_page_renders_for_workspace_admin(monkeypatch):
    client = _client(monkeypatch, auth_user_id=REVIEWER_ID, active_member_role="admin")

    response = client.get(f"/api/novasearch/review/{VALID_ID}")

    assert response.status_code == 200
    assert "Backend Engineer" in response.text
    assert "Alice" in response.text


def test_review_page_rejects_malformed_query_id_before_lookup(monkeypatch):
    client = _client(monkeypatch, auth_user_id=REVIEWER_ID)
    called = False

    def _query_row_by_id(_query_id: str) -> None:
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(nova, "_query_row_by_id", _query_row_by_id)

    response = client.get("/api/novasearch/review/not-a-valid-id")

    assert response.status_code == 404
    assert called is False


def test_review_label_requires_auth(monkeypatch):
    client = _client(monkeypatch, auth_user_id=None)

    response = client.post(
        f"/api/novasearch/review/{VALID_ID}/label",
        json={"candidate_key": "candidate-1", "worth_contact": True},
    )

    assert response.status_code == 401


def test_review_label_requires_active_workspace_match(monkeypatch):
    client = _client(
        monkeypatch,
        auth_user_id=REVIEWER_ID,
        active_workspace_id="ws_other",
    )

    response = client.post(
        f"/api/novasearch/review/{VALID_ID}/label",
        json={"candidate_key": "candidate-1", "worth_contact": True},
    )

    assert response.status_code == 404


def test_review_label_rejects_non_owner_member(monkeypatch):
    client = _client(monkeypatch, auth_user_id=REVIEWER_ID, active_member_role="member")

    response = client.post(
        f"/api/novasearch/review/{VALID_ID}/label",
        json={"candidate_key": "candidate-1", "worth_contact": True},
    )

    assert response.status_code == 403


def test_review_label_records_authenticated_query_owner(monkeypatch):
    supabase = _FakeSupabaseClient()
    client = _client(monkeypatch, auth_user_id=QUERY_OWNER_ID, active_member_role="member", supabase=supabase)

    response = client.post(
        f"/api/novasearch/review/{VALID_ID}/label",
        json={
            "candidate_key": "candidate-1",
            "rank": 1,
            "source": "review",
            "worth_contact": True,
            "reason": "Strong fit",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert supabase.table_name == "novasearch_match_labels"
    assert supabase.last_payload is not None
    assert supabase.last_payload["workspace_id"] == WORKSPACE_ID
    assert supabase.last_payload["user_id"] == QUERY_OWNER_ID
    assert supabase.last_payload["candidate_key"] == "candidate-1"


def test_review_label_allows_workspace_admin(monkeypatch):
    supabase = _FakeSupabaseClient()
    client = _client(monkeypatch, auth_user_id=REVIEWER_ID, active_member_role="admin", supabase=supabase)

    response = client.post(
        f"/api/novasearch/review/{VALID_ID}/label",
        json={"candidate_key": "candidate-1", "worth_contact": True},
    )

    assert response.status_code == 200
    assert supabase.last_payload is not None
    assert supabase.last_payload["user_id"] == REVIEWER_ID


def test_review_label_requires_candidate_key(monkeypatch):
    client = _client(monkeypatch, auth_user_id=QUERY_OWNER_ID)

    response = client.post(
        f"/api/novasearch/review/{VALID_ID}/label",
        json={"worth_contact": True},
    )

    assert response.status_code == 400
