from __future__ import annotations


def test_secret_repo_scopes_values_per_user(repo_bundle):
    repos, _db, _manifest = repo_bundle

    repos.secrets.set(user_id="user-a", name="OPENAI_API_KEY", value="sk-user-a")
    repos.secrets.set(user_id="user-b", name="OPENAI_API_KEY", value="sk-user-b")

    secret_a = repos.secrets.get(user_id="user-a", name="OPENAI_API_KEY")
    secret_b = repos.secrets.get(user_id="user-b", name="OPENAI_API_KEY")

    assert secret_a is not None
    assert secret_b is not None
    assert secret_a["value"] == "sk-user-a"
    assert secret_b["value"] == "sk-user-b"
    assert [row["name"] for row in repos.secrets.list(user_id="user-a")] == ["OPENAI_API_KEY"]
    assert [row["name"] for row in repos.secrets.list(user_id="user-b")] == ["OPENAI_API_KEY"]

    assert repos.secrets.delete(user_id="user-a", name="OPENAI_API_KEY") is True
    assert repos.secrets.get(user_id="user-a", name="OPENAI_API_KEY") is None
    assert repos.secrets.get(user_id="user-b", name="OPENAI_API_KEY")["value"] == "sk-user-b"
