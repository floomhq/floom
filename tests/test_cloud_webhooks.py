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


# ---------------------------------------------------------------------------
# #277 — SupabaseWebhookDeliveryStore: durable + atomic inbound-webhook dedup.
# claim() returns True the first time a (source, delivery_id) is seen (process)
# and False on a redelivery (drop), backed by the composite-PK table instead of
# the engine's ephemeral SQLite. Fails OPEN (True) on a missing table / transient
# DB error so a Supabase hiccup never silently drops a legit webhook.
# ---------------------------------------------------------------------------

from apps.api.cloud_webhooks import SupabaseWebhookDeliveryStore


class _Resp:
    def __init__(self, data):
        self.data = data


class _FakePKTable:
    """Models a table with a composite PK on (source, delivery_id)."""

    def __init__(self, rows):
        self.rows = rows
        self._op = None
        self._values = None
        self._eq = []
        self._lte = []

    def insert(self, values):
        self._op, self._values = "insert", values
        return self

    def delete(self):
        self._op = "delete"
        return self

    def select(self, *_a, **_k):
        self._op = "select"
        return self

    def eq(self, key, value):
        self._eq.append((key, value))
        return self

    def lte(self, key, value):
        self._lte.append((key, value))
        return self

    def limit(self, _n):
        return self

    def _key(self, row):
        return (row["source"], row["delivery_id"])

    def execute(self):
        if self._op == "insert":
            if any(self._key(r) == self._key(self._values) for r in self.rows):
                raise Exception("duplicate key value violates unique constraint \"webhook_delivery_receipts_pkey\"")
            self.rows.append(dict(self._values))
            return _Resp([dict(self._values)])
        if self._op == "delete":
            keep = []
            for r in self.rows:
                eq_ok = all(r.get(k) == v for k, v in self._eq)
                lte_ok = all(str(r.get(k)) <= v for k, v in self._lte)
                if not (eq_ok and lte_ok):
                    keep.append(r)
            removed = len(self.rows) - len(keep)
            self.rows[:] = keep
            return _Resp([None] * removed)
        # select
        matched = [r for r in self.rows if all(r.get(k) == v for k, v in self._eq)]
        return _Resp(matched[:1])


class _FakeClient:
    def __init__(self, rows=None):
        self.rows = rows if rows is not None else []

    def table(self, _name):
        return _FakePKTable(self.rows)


class _RaisingClient:
    """insert() raises a non-conflict, non-missing-table error; select() is clean
    and returns no existing row -> store must fail OPEN (process, no dedup)."""

    def __init__(self):
        self.rows = []

    def table(self, _name):
        return _RaisingTable()


class _RaisingTable(_FakePKTable):
    def __init__(self):
        super().__init__([])

    def execute(self):
        if self._op == "insert":
            raise Exception("connection reset by peer")
        if self._op == "select":
            return _Resp([])  # no existing receipt
        return _Resp([])


class _MissingTableClient:
    def table(self, _name):
        return _MissingTable()


class _MissingTable(_FakePKTable):
    def __init__(self):
        super().__init__([])

    def execute(self):
        raise Exception('relation "webhook_delivery_receipts" does not exist')


def test_delivery_store_first_seen_then_duplicate():
    store = SupabaseWebhookDeliveryStore(client=_FakeClient())
    assert store.claim("webhook:worker-1", "evt-1") is True   # first -> process
    assert store.claim("webhook:worker-1", "evt-1") is False  # redelivery -> drop


def test_delivery_store_distinct_ids_both_processed():
    store = SupabaseWebhookDeliveryStore(client=_FakeClient())
    assert store.claim("webhook:worker-1", "evt-1") is True
    assert store.claim("webhook:worker-1", "evt-2") is True


def test_delivery_store_same_id_distinct_sources_both_processed():
    store = SupabaseWebhookDeliveryStore(client=_FakeClient())
    assert store.claim("webhook:worker-1", "dup") is True
    assert store.claim("composio:worker-1", "dup") is True


def test_delivery_store_fails_open_when_table_missing():
    store = SupabaseWebhookDeliveryStore(client=_MissingTableClient())
    # Missing table must NOT drop the webhook (#277 part A): process it.
    assert store.claim("webhook:worker-1", "evt-1") is True


def test_delivery_store_fails_open_on_transient_error():
    store = SupabaseWebhookDeliveryStore(client=_RaisingClient())
    # Transient DB error with no recorded receipt -> process, do not drop.
    assert store.claim("webhook:worker-1", "evt-1") is True
