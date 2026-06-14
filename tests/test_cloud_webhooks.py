from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

from apps.api.cloud_webhooks import build_webhook_url, verify_webhook_token
from apps.api.db.supabase_repos import SupabaseWorkerRepository
from webhook_service import derive_webhook_token


class _Workers:
    def __init__(self) -> None:
        self.secret_hash: str | None = None

    def get_webhook_secret_hash(self, *, worker_id: str) -> str | None:
        assert worker_id == "worker-1"
        return self.secret_hash

    def upsert_webhook_secret_hash(
        self,
        *,
        worker_id: str,
        secret_hash: str,
        created_at: str,
        rotated_at: str,
    ) -> None:
        assert worker_id == "worker-1"
        assert created_at
        assert rotated_at
        self.secret_hash = secret_hash

    def delete_webhook_secret(self, *, worker_id: str) -> bool:
        assert worker_id == "worker-1"
        existed = self.secret_hash is not None
        self.secret_hash = None
        return existed


class _Repos:
    def __init__(self) -> None:
        self.workers = _Workers()


def test_cloud_webhook_url_uses_engine_token_model(monkeypatch):
    monkeypatch.setenv("WORKEROS_API_BASE", "https://workeros-api.example.test")
    repos = _Repos()

    url = build_webhook_url("worker-1", repos=repos)
    parsed = urlparse(url)
    token = parse_qs(parsed.query)["token"][0]

    assert parsed.scheme == "https"
    assert parsed.netloc == "workeros-api.example.test"
    assert parsed.path == "/api/webhooks/worker-1"
    assert repos.workers.secret_hash is not None
    assert token == derive_webhook_token("worker-1", repos.workers.secret_hash)
    assert verify_webhook_token("worker-1", token, repos=repos) is True
    assert verify_webhook_token("worker-1", "wrong-token", repos=repos) is False


class _Response:
    def __init__(self, data: list[dict[str, Any]]) -> None:
        self.data = data


class _Table:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.filters: list[tuple[str, Any]] = []
        self.limit_value: int | None = None

    def select(self, _columns: str) -> "_Table":
        return self

    def eq(self, key: str, value: Any) -> "_Table":
        self.filters.append((key, value))
        return self

    def limit(self, value: int) -> "_Table":
        self.limit_value = value
        return self

    def execute(self) -> _Response:
        matched = [
            row
            for row in self.rows
            if all(row.get(key) == value for key, value in self.filters)
        ]
        if self.limit_value is not None:
            matched = matched[: self.limit_value]
        return _Response(matched)


class _Client:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def table(self, name: str) -> _Table:
        assert name == "workers"
        return _Table(self.rows)


def test_supabase_webhook_secret_hash_matches_engine_str_contract():
    stored = bytes.fromhex("ab" * 32)
    repo = SupabaseWorkerRepository(
        _Client([{"id": "worker-1", "webhook_secret_hash": "\\x" + stored.hex()}])
    )

    assert repo.get_webhook_secret_hash(worker_id="worker-1") == stored.hex()
