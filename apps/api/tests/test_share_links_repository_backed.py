from __future__ import annotations


class _RepoBackedShareLinks:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    def create_standalone_share(
        self,
        *,
        entity_type: str,
        entity_id: str,
        file_path: str,
        owner_id: str,
        token_hash: str,
        created_at: str,
    ) -> dict:
        row = {
            "entity_type": entity_type,
            "entity_id": entity_id,
            "file_path": file_path,
            "owner_id": owner_id,
            "token_hash": token_hash,
            "created_at": created_at,
            "revoked_at": None,
        }
        self.rows[token_hash] = row
        return row

    def resolve_standalone_share(self, *, token_hash: str, now_iso_str: str) -> dict | None:
        row = self.rows.get(token_hash)
        if not row or row.get("revoked_at"):
            return None
        return dict(row)

    def revoke_standalone_share(
        self,
        *,
        entity_type: str,
        entity_id: str,
        file_path: str,
        owner_id: str,
        revoked_at: str,
    ) -> bool:
        for row in self.rows.values():
            if (
                row["entity_type"] == entity_type
                and row["entity_id"] == entity_id
                and row["file_path"] == file_path
                and row["owner_id"] == owner_id
                and row.get("revoked_at") is None
            ):
                row["revoked_at"] = revoked_at
                return True
        return False


class _Repos:
    def __init__(self):
        self.share_links = _RepoBackedShareLinks()


def test_standalone_share_link_uses_repository_backed_store():
    from services.share_links import (
        _create_or_get_standalone_share_link,
        _load_standalone_share_row,
        _revoke_standalone_share_link,
    )

    repos = _Repos()
    created = _create_or_get_standalone_share_link(
        entity_type="worker",
        entity_id="worker_spendready",
        owner_id="owner_a",
        repos=repos,
    )

    row = _load_standalone_share_row(created["token"], repos)
    assert row is not None
    assert row["entity_type"] == "worker"
    assert row["entity_id"] == "worker_spendready"
    assert row["owner_id"] == "owner_a"

    revoked = _revoke_standalone_share_link(
        entity_type="worker",
        entity_id="worker_spendready",
        owner_id="owner_a",
        repos=repos,
    )
    assert revoked == {"revoked": True}
    assert _load_standalone_share_row(created["token"], repos) is None
