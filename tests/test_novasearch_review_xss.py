"""Regression test for #218 — stored XSS in the NovaSearch review page.

`GET /novasearch/review/{query_id}` rendered attacker-controllable candidate
fields (name/title/company/score) and label `reason` directly into HTML via
f-strings. A candidate name like `<script>…</script>` (sourced from CRM /
LinkedIn / match payloads) therefore executed in the reviewer's browser.

This test mounts the real router with an authenticated reviewer and asserts the
dangerous markup is HTML-escaped.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import apps.api.routes.novasearch as nova
from auth import AuthContext, get_auth_context


class _FakeLabelsClient:
    """Minimal stand-in for the supabase client's labels query chain."""

    def table(self, _name):
        return self

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        return type("Resp", (), {"data": []})()


def _client(monkeypatch, *, query_row, labels_client=None):
    monkeypatch.setattr(nova, "_query_row_by_id", lambda _qid: query_row)
    monkeypatch.setattr(nova, "get_active_workspace_id", lambda: "ws_1")
    monkeypatch.setattr(nova, "new_supabase_service_client", lambda: labels_client or _FakeLabelsClient())
    app = FastAPI()
    app.include_router(nova.router, prefix="/api")
    app.dependency_overrides[get_auth_context] = lambda: AuthContext(
        user_id="reviewer-user",
        role="member",
        auth_method="session",
    )
    return TestClient(app)


VALID_ID = "a" * 32  # matches _REVIEW_ID_RE ^[0-9a-f]{32}$


def test_candidate_fields_are_html_escaped(monkeypatch):
    payload = "<script>alert('xss')</script>"
    query_row = {
        "workspace_id": "ws_1",
        "job_title": "<img src=x onerror=alert(1)>",
        "top_json": [
            {"rank": 1, "name": payload, "title": "Eng", "company": "Acme", "score": 9}
        ],
    }
    resp = _client(monkeypatch, query_row=query_row).get(f"/api/novasearch/review/{VALID_ID}")

    assert resp.status_code == 200
    body = resp.text
    # The raw script/img markup must NOT appear verbatim...
    assert "<script>alert('xss')</script>" not in body
    assert "<img src=x onerror=alert(1)>" not in body
    # ...it must be escaped instead.
    assert "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;" in body
    assert "&lt;img src=x onerror=alert(1)&gt;" in body
    # The page still renders the legitimate columns.
    assert "Acme" in body and "Eng" in body


def test_label_reason_is_html_escaped(monkeypatch):
    query_row = {
        "workspace_id": "ws_1",
        "job_title": "Backend role",
        "top_json": [{"rank": 1, "name": "Jane", "candidate_key": "k1"}],
    }

    class _LabelsWithReason(_FakeLabelsClient):
        def execute(self):
            return type(
                "Resp",
                (),
                {"data": [{"candidate_key": "k1", "worth_contact": True,
                           "reason": "<b onmouseover=alert(2)>bad</b>"}]},
            )()

    resp = _client(monkeypatch, query_row=query_row, labels_client=_LabelsWithReason()).get(
        f"/api/novasearch/review/{VALID_ID}"
    )

    assert resp.status_code == 200
    assert "<b onmouseover=alert(2)>bad</b>" not in resp.text
    assert "&lt;b onmouseover=alert(2)&gt;bad&lt;/b&gt;" in resp.text


def test_bad_id_still_404s(monkeypatch):
    # Guard the regex path is unaffected by the fix.
    resp = _client(monkeypatch, query_row=None).get("/api/novasearch/review/not-a-valid-id")
    assert resp.status_code == 404
