from __future__ import annotations


def test_cli_auth_repo_scopes_device_rows(repo_bundle):
    repos, _db, _manifest = repo_bundle

    repos.cli_auth.create_device(
        user_id="user-a",
        device_code="device-a",
        user_code="AAAA-BBBB",
        client_name="CLI A",
        scopes=["workers:read"],
        created_ip="127.0.0.1",
        created_at=100.0,
        expires_at=200.0,
    )
    repos.cli_auth.create_device(
        user_id="user-b",
        device_code="device-b",
        user_code="CCCC-DDDD",
        client_name="CLI B",
        scopes=["workers:write"],
        created_ip="127.0.0.2",
        created_at=110.0,
        expires_at=210.0,
    )

    assert [row["device_code"] for row in repos.cli_auth.list(user_id="user-a")] == ["device-a"]
    assert [row["device_code"] for row in repos.cli_auth.list(user_id="user-b")] == ["device-b"]
    assert repos.cli_auth.get(user_id="user-a", device_code="device-b") is None

    verified = repos.cli_auth.verify_device("CCCC-DDDD")
    assert verified is not None
    assert verified["user_id"] == "user-b"

    consumed = repos.cli_auth.consume("device-b")
    assert consumed is not None
    assert consumed["user_id"] == "user-b"
    assert repos.cli_auth.get(user_id="user-b", device_code="device-b") is None
