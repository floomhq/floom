from __future__ import annotations

import time
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from apps.api.auth.workspace_context import active_workspace
from apps.api.config import new_supabase_anon_client, new_supabase_service_client
from apps.api.db._secret_crypto import encrypt_secret
from apps.api.db.supabase_repos import (
    SupabaseApprovalRepository,
    SupabaseCliAuthRepository,
    SupabaseConnectionRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
    _bytea_literal,
)


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, rows):
        self.rows = rows
        self.table_name = None
        self.filters: list[tuple[str, str]] = []
        self.in_filters: list[tuple[str, set[str]]] = []
        self.or_filters: list[str] = []
        self.limit_value = None
        self.selected = None
        self.update_values = None

    def select(self, value, **_kwargs):
        self.selected = value
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

    def or_(self, value):
        self.or_filters.append(value)
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = self.rows
        for key, value in self.filters:
            rows = [row for row in rows if row.get(key) == value]
        for key, values in self.in_filters:
            rows = [row for row in rows if row.get(key) in values]
        for value in self.or_filters:
            clauses = [clause.split(".", 2) for clause in value.split(",")]
            rows = [
                row
                for row in rows
                if any(_matches_or_clause(row, clause) for clause in clauses)
            ]
        if self.update_values is not None:
            # UPDATE: mutate the matching rows in place (so a sibling table()
            # handle / get_by_run_id sees the change) and return only the rows
            # actually affected — postgrest's return=representation semantics.
            # This models the #280 atomic claim: a conditional UPDATE filtering
            # status='pending' flips no row (returns []) once the row is decided.
            for row in rows:
                row.update(self.update_values)
            return _FakeResponse(rows)
        if self.limit_value is not None:
            rows = rows[: self.limit_value]
        return _FakeResponse(rows)


class _FakeClient:
    def __init__(self, rows, *, rpc_results=None):
        self.rows_by_table = rows if isinstance(rows, dict) else None
        self.rows = rows
        self.table_ref = _FakeTable([])
        self.rpc_results = rpc_results or {}
        self.rpc_calls: list[tuple[str, dict]] = []

    def table(self, name):
        rows = self.rows_by_table.get(name, []) if self.rows_by_table is not None else self.rows
        self.table_ref = _FakeTable(rows)
        self.table_ref.table_name = name
        return self.table_ref

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return _FakeRpc(self.rpc_results.get(name))


class _FakeRpc:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return _FakeResponse(self.data)


def test_approval_repository_get_public_loads_by_id_without_owner_scope():
    approval = {
        "id": "apr_test",
        "run_id": "run_test",
        "owner_id": "user_test",
        "status": "pending",
    }
    client = _FakeClient([approval])
    repo = SupabaseApprovalRepository(client=client)

    assert repo.get_public(approval_id="apr_test") == approval
    assert client.table_ref.table_name == "approvals"
    assert ("id", "apr_test") in client.table_ref.filters


def test_worker_get_falls_back_to_owned_exact_id_when_workspace_cookie_is_stale():
    now_iso = _now_iso()
    worker_id = "granola-hubspot-meeting-actions"
    skill_version_id = "sv_granola"
    client = _FakeClient(
        {
            "workers": [
                {
                    "id": worker_id,
                    "user_id": "user_fede",
                    "workspace_id": "ws_fede_production",
                    "skill_version_id": skill_version_id,
                    "name": "Granola to HubSpot Daily Meeting Action Items",
                    "trigger_type": "manual",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                }
            ],
            "skill_versions": [
                {
                    "id": skill_version_id,
                    "user_id": "user_fede",
                    "name": worker_id,
                    "version": "0.1.0",
                    "manifest_json": _manifest(worker_id, "Granola to HubSpot Daily Meeting Action Items"),
                    "bundle_path": f"workers/{worker_id}",
                    "created_at": now_iso,
                }
            ],
        }
    )

    with active_workspace("ws_default", "admin"):
        result = SupabaseWorkerRepository(client=client).get(
            user_id="user_fede",
            worker_id=worker_id,
        )

    assert result is not None
    assert result["id"] == worker_id


def test_worker_get_exposes_archive_fields_from_manifest_json():
    now_iso = _now_iso()
    worker_id = "archive-ready-worker"
    skill_version_id = "sv_archive_ready"
    manifest = _manifest(worker_id, "Archive Ready Worker")
    manifest["archived"] = True
    manifest["archive_reason"] = "No longer needed"
    client = _FakeClient(
        {
            "workers": [
                {
                    "id": worker_id,
                    "user_id": "user_fede",
                    "workspace_id": "ws_fede_production",
                    "skill_version_id": skill_version_id,
                    "name": "Archive Ready Worker",
                    "trigger_type": "manual",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                }
            ],
            "skill_versions": [
                {
                    "id": skill_version_id,
                    "user_id": "user_fede",
                    "name": worker_id,
                    "version": "0.1.0",
                    "manifest_json": manifest,
                    "bundle_path": f"workers/{worker_id}",
                    "created_at": now_iso,
                }
            ],
        }
    )

    result = SupabaseWorkerRepository(client=client).get(
        user_id="user_fede",
        worker_id=worker_id,
    )

    assert result is not None
    assert result["archived"] is True
    assert result["archive_reason"] == "No longer needed"


def test_secret_resolve_batches_vault_reads_and_last_used_updates():
    vault_a = str(uuid4())
    vault_b = str(uuid4())
    now_iso = _now_iso()
    rows = [
        {
            "user_id": "owner",
            "workspace_id": "ws_default",
            "name": "OPENAI_API_KEY",
            "value": None,
            "vault_secret_id": vault_a,
            "last_used_at": None,
        },
        {
            "user_id": "owner",
            "workspace_id": "ws_default",
            "name": "AWS_SECRET_ACCESS_KEY",
            "value": None,
            "vault_secret_id": vault_b,
            "last_used_at": None,
        },
        {
            "user_id": "owner",
            "workspace_id": "ws_default",
            "name": "LEGACY_TOKEN",
            "value": _bytea_literal(encrypt_secret("legacy-value")),
            "vault_secret_id": None,
            "last_used_at": None,
        },
        {
            "user_id": "owner",
            "workspace_id": "ws_other",
            "name": "OPENAI_API_KEY",
            "value": None,
            "vault_secret_id": str(uuid4()),
            "last_used_at": now_iso,
        },
    ]
    client = _FakeClient(
        {"secrets": rows},
        rpc_results={
            "workeros_vault_read_secrets": [
                {"id": vault_a, "secret": "sk-openai"},
                {"id": vault_b, "secret": "aws-secret"},
            ]
        },
    )

    with active_workspace("ws_default", "admin"):
        resolved = SupabaseSecretRepository(client=client).resolve(
            user_id="owner",
            names=[
                "OPENAI_API_KEY",
                "AWS_SECRET_ACCESS_KEY",
                "LEGACY_TOKEN",
                "MISSING",
                "OPENAI_API_KEY",
            ],
        )

    assert resolved == {
        "OPENAI_API_KEY": "sk-openai",
        "AWS_SECRET_ACCESS_KEY": "aws-secret",
        "LEGACY_TOKEN": "legacy-value",
    }
    assert client.rpc_calls == [
        (
            "workeros_vault_read_secrets",
            {"p_ids": [vault_a, vault_b]},
        )
    ]
    assert rows[0]["last_used_at"] is not None
    assert rows[1]["last_used_at"] is not None
    assert rows[2]["last_used_at"] is not None
    assert rows[3]["last_used_at"] == now_iso


def test_run_get_falls_back_to_owned_exact_id_when_workspace_cookie_is_stale():
    now_iso = _now_iso()
    run_id = "run_8290101e249b"
    worker_id = "granola-hubspot-meeting-sync"
    client = _FakeClient(
        {
            "runs": [
                {
                    "id": run_id,
                    "user_id": "user_fede",
                    "workspace_id": "ws_fede_production",
                    "worker_id": worker_id,
                    "status": "failed",
                    "trigger_source": "schedule",
                    "runner": "local",
                    "input_json": {},
                    "output_json": {},
                    "error": "Server disconnected",
                    "created_at": now_iso,
                }
            ],
            "workers": [
                {
                    "id": worker_id,
                    "user_id": "user_fede",
                    "workspace_id": "ws_fede_production",
                    "skill_version_id": None,
                    "name": "Granola to HubSpot Daily Meeting Sync",
                    "trigger_type": "manual",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                }
            ],
            "skill_versions": [],
        }
    )

    with active_workspace("ws_default", "admin"):
        result = SupabaseRunRepository(client=client).get(
            user_id="user_fede",
            run_id=run_id,
        )

    assert result is not None
    assert result["id"] == run_id
    assert result["worker_id"] == worker_id


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _manifest(worker_id: str, name: str) -> dict[str, object]:
    return {
        "id": worker_id,
        "name": name,
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }


def _create_auth_user(service_client, prefix: str, timestamp: int) -> dict[str, str]:
    email = f"test-user-{prefix}+{timestamp}@workeros.test"
    password = f"P@ssw0rd-{uuid4().hex}"
    response = service_client.auth.admin.create_user(
        {
            "email": email,
            "password": password,
            "email_confirm": True,
        }
    )
    user = response.user
    if user is None:
        raise RuntimeError("Supabase admin create_user returned no user")
    return {"id": str(user.id), "email": email, "password": password}


def _signed_in_client(email: str, password: str):
    client = new_supabase_anon_client()
    response = client.auth.sign_in_with_password({"email": email, "password": password})
    assert response.session is not None
    return client


def test_supabase_repositories_enforce_rls_between_users():
    service = new_supabase_service_client()
    timestamp = time.time_ns()
    now_iso = _now_iso()
    secret_name = "OPENAI_API_KEY"
    user_a: dict[str, str] | None = None
    user_b: dict[str, str] | None = None

    try:
        try:
            user_a = _create_auth_user(service, "a", timestamp)
            user_b = _create_auth_user(service, "b", timestamp)
        except Exception as exc:
            pytest.skip(f"Supabase admin user creation failed: {exc}")

        service.table("users").upsert(
            [
                {"id": user_a["id"], "email": user_a["email"], "updated_at": now_iso},
                {"id": user_b["id"], "email": user_b["email"], "updated_at": now_iso},
            ],
            on_conflict="id",
        ).execute()

        skill_version_a = f"sv-{uuid4().hex}"
        skill_version_b = f"sv-{uuid4().hex}"
        worker_a = f"worker-{uuid4().hex}"
        worker_b = f"worker-{uuid4().hex}"
        workspace_a = f"ws_{uuid4().hex[:14]}"
        workspace_b = f"ws_{uuid4().hex[:14]}"
        run_a = f"run-{uuid4().hex}"
        run_b = f"run-{uuid4().hex}"
        connection_a = f"conn-{uuid4().hex}"
        connection_b = f"conn-{uuid4().hex}"
        composio_connection_id_a = f"composio-{uuid4().hex}"
        composio_connection_id_b = f"composio-{uuid4().hex}"
        device_a = f"device-{uuid4().hex}"
        device_b = f"device-{uuid4().hex}"
        user_code_a = f"A{uuid4().hex[:3]}-A{uuid4().hex[:3]}".upper()
        user_code_b = f"B{uuid4().hex[:3]}-B{uuid4().hex[:3]}".upper()

        service.table("workspaces").insert(
            [
                {
                    "id": workspace_a,
                    "owner_user_id": user_a["id"],
                    "name": "User A workspace",
                    "created_at": now_iso,
                },
                {
                    "id": workspace_b,
                    "owner_user_id": user_b["id"],
                    "name": "User B workspace",
                    "created_at": now_iso,
                },
            ]
        ).execute()

        service.table("skill_versions").insert(
            [
                {
                    "id": skill_version_a,
                    "user_id": user_a["id"],
                    "name": "worker-a",
                    "version": "0.1.0",
                    "manifest_json": _manifest(worker_a, "Worker A"),
                    "bundle_path": "workers/worker-a",
                    "created_at": now_iso,
                },
                {
                    "id": skill_version_b,
                    "user_id": user_b["id"],
                    "name": "worker-b",
                    "version": "0.1.0",
                    "manifest_json": _manifest(worker_b, "Worker B"),
                    "bundle_path": "workers/worker-b",
                    "created_at": now_iso,
                },
            ]
        ).execute()
        service.table("workers").insert(
            [
                {
                    "id": worker_a,
                    "user_id": user_a["id"],
                    "skill_version_id": skill_version_a,
                    "name": "Worker A",
                    "trigger_type": "manual",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                    "workspace_id": workspace_a,
                },
                {
                    "id": worker_b,
                    "user_id": user_b["id"],
                    "skill_version_id": skill_version_b,
                    "name": "Worker B",
                    "trigger_type": "manual",
                    "grants_json": {},
                    "input_values_json": {},
                    "triggers_json": [],
                    "enabled": True,
                    "created_at": now_iso,
                    "workspace_id": workspace_b,
                },
            ]
        ).execute()
        service.table("runs").insert(
            [
                {
                    "id": run_a,
                    "user_id": user_a["id"],
                    "worker_id": worker_a,
                    "status": "completed",
                    "trigger_source": "manual",
                    "runner": "local",
                    "input_json": {},
                    "output_json": {},
                    "created_at": now_iso,
                    "workspace_id": workspace_a,
                },
                {
                    "id": run_b,
                    "user_id": user_b["id"],
                    "worker_id": worker_b,
                    "status": "completed",
                    "trigger_source": "manual",
                    "runner": "local",
                    "input_json": {},
                    "output_json": {},
                    "created_at": now_iso,
                    "workspace_id": workspace_b,
                },
            ]
        ).execute()
        service.table("connections").insert(
            [
                {
                    "id": connection_a,
                    "user_id": user_a["id"],
                    "app_name": "gmail",
                    "composio_connection_id": composio_connection_id_a,
                    "composio_user_id": user_a["id"],
                    "status": "active",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "scopes_json": ["gmail.read"],
                    "workspace_id": workspace_a,
                },
                {
                    "id": connection_b,
                    "user_id": user_b["id"],
                    "app_name": "github",
                    "composio_connection_id": composio_connection_id_b,
                    "composio_user_id": user_b["id"],
                    "status": "active",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "scopes_json": ["repo"],
                    "workspace_id": workspace_b,
                },
            ]
        ).execute()
        service.table("secrets").insert(
            [
                {
                    "user_id": user_a["id"],
                    "name": secret_name,
                    "value": _bytea_literal(encrypt_secret("sk-user-a")),
                    "status": "set",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "workspace_id": workspace_a,
                },
                {
                    "user_id": user_b["id"],
                    "name": secret_name,
                    "value": _bytea_literal(encrypt_secret("sk-user-b")),
                    "status": "set",
                    "created_at": now_iso,
                    "updated_at": now_iso,
                    "workspace_id": workspace_b,
                },
            ]
        ).execute()
        service.table("cli_auth_devices").insert(
            [
                {
                    "device_code": device_a,
                    "user_id": user_a["id"],
                    "user_code": user_code_a,
                    "status": "approved",
                    "secret": "refresh-a",
                    "client_name": "workeros-cli",
                    "scopes_json": [],
                    "created_at": 1000.0,
                    "expires_at": 9999999999.0,
                    "approved_at": 1001.0,
                },
                {
                    "device_code": device_b,
                    "user_id": user_b["id"],
                    "user_code": user_code_b,
                    "status": "approved",
                    "secret": "refresh-b",
                    "client_name": "workeros-cli",
                    "scopes_json": [],
                    "created_at": 1000.0,
                    "expires_at": 9999999999.0,
                    "approved_at": 1001.0,
                },
            ]
        ).execute()

        user_a_client = _signed_in_client(user_a["email"], user_a["password"])
        user_b_client = _signed_in_client(user_b["email"], user_b["password"])

        workers_a = SupabaseWorkerRepository(client=user_a_client)
        runs_a = SupabaseRunRepository(client=user_a_client)
        connections_a = SupabaseConnectionRepository(client=user_a_client)
        secrets_a = SupabaseSecretRepository(client=user_a_client)
        cli_auth_a = SupabaseCliAuthRepository(client=user_a_client)

        workers_b = SupabaseWorkerRepository(client=user_b_client)

        assert [row["id"] for row in workers_a.list(user_id=user_a["id"])] == [worker_a]
        assert workers_a.list(user_id=user_b["id"]) == []
        assert workers_a.get(user_id=user_a["id"], worker_id=worker_b) is None
        assert workers_a.get_any(worker_id=worker_b) is None
        assert workers_b.get_any(worker_id=worker_a) is None

        runs_rows, runs_total = runs_a.list(user_id=user_a["id"])
        assert runs_total == 1
        assert [row["id"] for row in runs_rows] == [run_a]
        assert runs_a.get(user_id=user_a["id"], run_id=run_b) is None
        assert runs_a.get_any(run_id=run_b) is None

        assert [row["id"] for row in connections_a.list(user_id=user_a["id"])] == [connection_a]
        assert connections_a.list(user_id=user_b["id"]) == []
        assert connections_a.get_by_composio_connection_id(
            composio_connection_id=composio_connection_id_b
        ) is None

        secret_row = secrets_a.get(user_id=user_a["id"], name=secret_name)
        assert secret_row is not None
        assert secret_row["value"] == "sk-user-a"
        assert secrets_a.get(user_id=user_b["id"], name=secret_name) is None
        assert secrets_a.read_value(user_id=user_a["id"], name=secret_name) == "sk-user-a"
        assert secrets_a.read_value(user_id=user_b["id"], name=secret_name) is None
        assert secrets_a.list_names(user_id=user_a["id"]) == {secret_name}

        assert [row["device_code"] for row in cli_auth_a.list(user_id=user_a["id"])] == [device_a]
        assert cli_auth_a.list(user_id=user_b["id"]) == []
        assert cli_auth_a.get(user_id=user_a["id"], device_code=device_b) is None
        assert cli_auth_a.verify_device(user_code_b) is None
    finally:
        user_ids = [user["id"] for user in (user_a, user_b) if user is not None]
        if user_ids:
            service.table("cli_auth_devices").delete().in_("user_id", user_ids).execute()
            service.table("connections").delete().in_("user_id", user_ids).execute()
            service.table("secrets").delete().in_("user_id", user_ids).execute()
            service.table("runs").delete().in_("user_id", user_ids).execute()
            service.table("workers").delete().in_("user_id", user_ids).execute()
            service.table("skill_versions").delete().in_("user_id", user_ids).execute()
            service.table("workspaces").delete().in_("owner_user_id", user_ids).execute()
            service.table("users").delete().in_("id", user_ids).execute()
        for user in (user_a, user_b):
            if user is None:
                continue
            try:
                service.auth.admin.delete_user(user["id"])
            except Exception:
                pass


# ---------------------------------------------------------------------------
# #280 — approval-decision TOCTOU: approve()/reject() MUST return None when the
# conditional UPDATE flips no pending row, so the engine route's `claimed is
# None` 409 guard fires instead of letting a race loser spawn a follow-up run
# (double-spend) or execute a rejected HITL run. The cloud repo previously
# returned get_by_run_id() unconditionally, defeating the gate.
# ---------------------------------------------------------------------------


def _matches_or_clause(row: dict, clause: list[str]) -> bool:
    if len(clause) != 3:
        return False
    key, op, value = clause
    if op == "eq":
        return str(row.get(key)) == value
    if op == "is" and value == "null":
        return row.get(key) is None
    if op == "gte":
        actual = row.get(key)
        return actual is not None and str(actual) >= value
    return False


def _pending_approval(run_id="run_280", owner_id="user_280", expires_at=None):
    return {
        "id": "apr_280",
        "run_id": run_id,
        "owner_id": owner_id,
        "workspace_id": "ws_280",
        "worker_id": "wk_280",
        "status": "pending",
        "created_at": _now_iso(),
        "expires_at": expires_at,
    }


def test_approve_returns_row_when_it_wins_the_claim():
    client = _FakeClient([_pending_approval()])
    repo = SupabaseApprovalRepository(client=client)

    claimed = repo.approve(owner_id="user_280", run_id="run_280", decided_at=_now_iso())

    assert claimed is not None
    assert claimed["status"] == "approved"


def test_second_decision_returns_none_after_approve_wins():
    # approve wins the claim; a concurrent reject must lose -> None (else the
    # rejected run would still proceed). Same row, already flipped to approved.
    client = _FakeClient([_pending_approval()])
    repo = SupabaseApprovalRepository(client=client)

    assert repo.approve(owner_id="user_280", run_id="run_280", decided_at=_now_iso()) is not None
    lost = repo.reject(owner_id="user_280", run_id="run_280", decided_at=_now_iso())

    assert lost is None  # status no longer 'pending' -> conditional UPDATE flips nothing


def test_double_approve_second_call_returns_none():
    client = _FakeClient([_pending_approval()])
    repo = SupabaseApprovalRepository(client=client)

    assert repo.approve(owner_id="user_280", run_id="run_280", decided_at=_now_iso()) is not None
    second = repo.approve(owner_id="user_280", run_id="run_280", decided_at=_now_iso())

    assert second is None  # no second follow-up run / double-spend


def test_reject_then_approve_returns_none():
    client = _FakeClient([_pending_approval()])
    repo = SupabaseApprovalRepository(client=client)

    assert repo.reject(owner_id="user_280", run_id="run_280", decided_at=_now_iso()) is not None
    racing_approve = repo.approve(owner_id="user_280", run_id="run_280", decided_at=_now_iso())

    assert racing_approve is None  # an approve cannot win after a reject already decided


def test_approve_refuses_expired_pending_approval_atomically():
    client = _FakeClient([_pending_approval(expires_at="2020-01-01T00:00:00+00:00")])
    repo = SupabaseApprovalRepository(client=client)

    claimed = repo.approve(
        owner_id="user_280",
        run_id="run_280",
        decided_at="2026-06-18T00:00:00+00:00",
    )

    assert claimed is None
    assert client.rows[0]["status"] == "pending"


def test_reject_refuses_expired_pending_approval_atomically():
    client = _FakeClient([_pending_approval(expires_at="2020-01-01T00:00:00+00:00")])
    repo = SupabaseApprovalRepository(client=client)

    claimed = repo.reject(
        owner_id="user_280",
        run_id="run_280",
        decided_at="2026-06-18T00:00:00+00:00",
    )

    assert claimed is None
    assert client.rows[0]["status"] == "pending"


def test_approve_allows_unexpired_or_null_expiry():
    for expiry in (None, "2999-01-01T00:00:00+00:00"):
        client = _FakeClient([_pending_approval(expires_at=expiry)])
        repo = SupabaseApprovalRepository(client=client)

        claimed = repo.approve(
            owner_id="user_280",
            run_id="run_280",
            decided_at="2026-06-18T00:00:00+00:00",
        )

        assert claimed is not None
        assert claimed["status"] == "approved"


def test_attach_follow_up_records_run_id_on_approved_row():
    client = _FakeClient([_pending_approval()])
    repo = SupabaseApprovalRepository(client=client)

    repo.approve(owner_id="user_280", run_id="run_280", decided_at=_now_iso())
    updated = repo.attach_follow_up(
        owner_id="user_280", run_id="run_280", follow_up_run_id="run_followup"
    )

    assert updated is not None
    assert updated["follow_up_run_id"] == "run_followup"
