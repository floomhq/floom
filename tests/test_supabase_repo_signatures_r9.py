"""Contract + behavioral tests for the round-09 Supabase repo signature
reconciliation (#1470 perf + BE-EXPIRY / #798).

Round-09 added new kwargs to the engine's repository Protocol and router
callsites but only updated the SQLite impl. The Supabase impls (the cloud /
prod path) kept the old signatures, so the engine router calling e.g.
``repos.approvals.list_pending(owner_id=..., limit=...)`` raised
``TypeError: ... unexpected keyword argument 'limit'`` -> 500 on /api/approvals.

These tests assert the Supabase impls accept every parameter the engine
interface declares (so the cloud cannot 500 on a kwarg), and exercise the two
behaviors that the 500 + lazy-expiry fixes depend on.
"""

from __future__ import annotations

import inspect

import pytest

from apps.api.db.supabase_repos import (
    SupabaseApprovalRepository,
    SupabaseConnectionRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
)
from apps.api._engine import ensure_engine_api_path

ensure_engine_api_path()

from db.interface import (  # noqa: E402  (engine import requires path setup above)
    ApprovalRepository,
    ConnectionRepository,
    RunRepository,
    SecretRepository,
    WorkerRepository,
)


# ---------------------------------------------------------------------------
# Contract test: every Supabase method must accept every param the engine's
# Protocol declares for that method. Methods that accept **kwargs are exempt
# (they absorb any keyword). Methods the cloud impl does not provide at all are
# reported only when the engine router HARD-calls them; getattr()-guarded
# engine callers degrade gracefully, so a missing optional method is allowed.
# ---------------------------------------------------------------------------

_IMPL_FOR_PROTOCOL = [
    (ApprovalRepository, SupabaseApprovalRepository),
    (RunRepository, SupabaseRunRepository),
    (ConnectionRepository, SupabaseConnectionRepository),
    (SecretRepository, SupabaseSecretRepository),
    (WorkerRepository, SupabaseWorkerRepository),
]

# Engine methods the cloud intentionally does NOT implement on the Supabase
# path because every engine caller reaches them via getattr() and degrades
# (perf-only DB-side reimplementations / features the cloud doesn't store).
# Tracked as a known, documented gap (see fix/supabase-repo-signatures-r9).
_KNOWN_OPTIONAL_GAPS = {
    "SupabaseRunRepository": {"list_operator_visible"},
    "SupabaseSecretRepository": {
        "list_workspace_secrets",
        "get_workspace_secret",
        "set_workspace_secret",
        "delete_workspace_secret",
    },
}


def _protocol_methods(proto) -> dict[str, inspect.Signature]:
    out: dict[str, inspect.Signature] = {}
    for name in dir(proto):
        if name.startswith("_"):
            continue
        attr = getattr(proto, name)
        if callable(attr):
            try:
                out[name] = inspect.signature(attr)
            except (TypeError, ValueError):
                pass
    return out


@pytest.mark.parametrize("proto,impl", _IMPL_FOR_PROTOCOL, ids=lambda x: getattr(x, "__name__", str(x)))
def test_supabase_impl_accepts_every_interface_param(proto, impl):
    impl_name = impl.__name__
    gaps = _KNOWN_OPTIONAL_GAPS.get(impl_name, set())
    failures: list[str] = []

    for meth_name, proto_sig in _protocol_methods(proto).items():
        impl_meth = getattr(impl, meth_name, None)
        if impl_meth is None:
            if meth_name not in gaps:
                failures.append(f"{impl_name} is MISSING method {meth_name}")
            continue
        impl_sig = inspect.signature(impl_meth)
        impl_params = impl_sig.parameters
        accepts_var_kw = any(
            p.kind is inspect.Parameter.VAR_KEYWORD for p in impl_params.values()
        )
        if accepts_var_kw:
            continue
        for pname, p in proto_sig.parameters.items():
            if pname in {"self", "args", "kwargs"}:
                continue
            if p.kind in {inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD}:
                continue
            if pname not in impl_params:
                failures.append(
                    f"{impl_name}.{meth_name} does not accept '{pname}' "
                    f"(engine interface declares it -> TypeError/500 on call)"
                )

    assert not failures, "Signature drift between engine interface and Supabase impl:\n" + "\n".join(failures)


# ---------------------------------------------------------------------------
# Behavioral fakes — minimal PostgREST query-builder double extended with the
# operators expire_if_stale / list_pending(limit) use.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _FakeTable:
    def __init__(self, rows):
        self.rows = rows
        self.table_name = None
        self.filters: list[tuple[str, object]] = []
        self.in_filters: list[tuple[str, set]] = []
        self.lt_filters: list[tuple[str, object]] = []
        self.notnull_cols: list[str] = []
        self.limit_value = None
        self.update_values = None
        self._not = False

    def select(self, *_a, **_k):
        return self

    def update(self, values):
        self.update_values = values
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def in_(self, key, values):
        self.in_filters.append((key, set(values)))
        return self

    def lt(self, key, value):
        self.lt_filters.append((key, value))
        return self

    @property
    def not_(self):
        self._not = True
        return self

    def is_(self, key, _value):
        # Only used as `.not_.is_(col, "null")` -> require col IS NOT NULL.
        if self._not:
            self.notnull_cols.append(key)
            self._not = False
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def order(self, *_a, **_k):
        return self

    def _matches(self, row):
        for k, v in self.filters:
            if row.get(k) != v:
                return False
        for k, values in self.in_filters:
            if row.get(k) not in values:
                return False
        for k, v in self.lt_filters:
            rv = row.get(k)
            if rv is None or not (str(rv) < str(v)):
                return False
        for col in self.notnull_cols:
            if row.get(col) is None:
                return False
        return True

    def execute(self):
        matched = [r for r in self.rows if self._matches(r)]
        if self.update_values is not None:
            for r in matched:
                r.update(self.update_values)
            return _FakeResponse(matched)
        if self.limit_value is not None:
            matched = matched[: self.limit_value]
        return _FakeResponse(matched)


class _FakeClient:
    def __init__(self, rows_by_table):
        self.rows_by_table = rows_by_table
        self.table_ref = _FakeTable([])

    def table(self, name):
        self.table_ref = _FakeTable(self.rows_by_table.setdefault(name, []))
        self.table_ref.table_name = name
        return self.table_ref


def test_list_pending_accepts_and_applies_limit():
    """The 500 fix: GET /api/approvals calls list_pending(owner_id=, limit=)."""
    rows = [
        {"id": f"apr_{i}", "owner_id": "u1", "status": "pending", "run_id": f"r{i}"}
        for i in range(5)
    ]
    repo = SupabaseApprovalRepository(client=_FakeClient({"approvals": rows}))

    # Must not raise TypeError on the limit kwarg (the bug) ...
    out = repo.list_pending(owner_id="u1", limit=3)
    assert len(out) == 3  # ... and must actually apply the bound.

    # Out-of-range / bad values are clamped to 1..200, never crash.
    assert len(repo.list_pending(owner_id="u1", limit=99999)) == 5
    assert len(repo.list_pending(owner_id="u1", limit=0)) >= 1


def test_expire_if_stale_flips_stale_pending_and_clears_run():
    approvals = [
        {
            "id": "apr_stale",
            "owner_id": "u1",
            "run_id": "run_stale",
            "status": "pending",
            "expires_at": "2020-01-01T00:00:00+00:00",
        },
        {
            "id": "apr_fresh",
            "owner_id": "u1",
            "run_id": "run_fresh",
            "status": "pending",
            "expires_at": "2999-01-01T00:00:00+00:00",
        },
    ]
    runs = [{"id": "run_stale", "status": "pending_approval"}]
    client = _FakeClient({"approvals": approvals, "runs": runs})
    repo = SupabaseApprovalRepository(client=client)

    now = "2026-06-18T00:00:00+00:00"
    assert repo.expire_if_stale(approval_id="apr_stale", now_iso_str=now) is True
    assert approvals[0]["status"] == "expired"
    assert runs[0]["status"] == "failed"
    assert runs[0]["error_code"] == "approval_expired"

    # Idempotent: a second call flips nothing (guard requires status='pending').
    assert repo.expire_if_stale(approval_id="apr_stale", now_iso_str=now) is False
    # Fresh approval (expires in the future) is never expired.
    assert repo.expire_if_stale(approval_id="apr_fresh", now_iso_str=now) is False
    assert approvals[1]["status"] == "pending"


def test_list_artifacts_for_runs_groups_and_caps_per_run():
    artifacts = {
        "artifacts": [
            {"run_id": "r1", "name": "a", "user_id": "u1", "created_at": "1"},
            {"run_id": "r1", "name": "b", "user_id": "u1", "created_at": "2"},
            {"run_id": "r2", "name": "c", "user_id": "u1", "created_at": "1"},
        ]
    }
    repo = SupabaseRunRepository(client=_FakeClient(artifacts))
    grouped = repo.list_artifacts_for_runs(user_id="u1", run_ids=["r1", "r2", "r3"])
    assert set(grouped) == {"r1", "r2", "r3"}
    assert len(grouped["r1"]) == 2
    assert len(grouped["r2"]) == 1
    assert grouped["r3"] == []

    capped = repo.list_artifacts_for_runs(user_id="u1", run_ids=["r1"], limit_per_run=1)
    assert len(capped["r1"]) == 1
