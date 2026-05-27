from __future__ import annotations


def test_connection_repo_scopes_rows_by_user(repo_bundle):
    repos, _db, _manifest = repo_bundle

    repos.connections.upsert(
        user_id="user-a",
        id="conn-a",
        app_name="gmail",
        composio_connection_id="ca-a",
        status="active",
    )
    repos.connections.upsert(
        user_id="user-b",
        id="conn-b",
        app_name="slack",
        composio_connection_id="ca-b",
        status="initiated",
    )

    assert [row["id"] for row in repos.connections.list(user_id="user-a")] == ["conn-a"]
    assert [row["id"] for row in repos.connections.list(user_id="user-b")] == ["conn-b"]
    assert repos.connections.get(user_id="user-a", composio_id="conn-b") is None

    updated = repos.connections.update(
        user_id="user-a",
        composio_id="conn-a",
        status="expired",
        account_label="alice@example.com",
    )
    assert updated is not None
    assert updated["status"] == "expired"
    assert updated["account_label"] == "alice@example.com"

    assert repos.connections.delete(user_id="user-a", composio_id="conn-a") is True
    assert repos.connections.get(user_id="user-a", composio_id="conn-a") is None
