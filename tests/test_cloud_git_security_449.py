from __future__ import annotations

from cryptography.fernet import Fernet

from apps.api import cloud_git


def test_git_pat_is_encrypted_for_storage_and_decrypted_on_read(monkeypatch):
    monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))
    from apps.api.db import _secret_crypto

    _secret_crypto._fernet.cache_clear()

    fields = cloud_git.storage_fields({
        "github_pat": "ghp_plaintext_secret",
        "repo_full_name": "octo/repo",
    })

    stored = fields["github_pat"]
    assert stored.startswith("fernet:")
    assert "ghp_plaintext_secret" not in stored

    cfg = cloud_git.plaintext_cfg(fields)
    assert cfg is not None
    assert cfg["github_pat"] == "ghp_plaintext_secret"


def test_legacy_plaintext_pat_still_reads_during_migration():
    assert cloud_git.plaintext_cfg({"github_pat": "ghp_legacy"})["github_pat"] == "ghp_legacy"


def test_remote_url_credentials_are_not_stored():
    fields = cloud_git.storage_fields({
        "remote_url": "https://ghp_plaintext_secret@github.com/octo/repo.git",
    })

    assert fields["remote_url"] == "https://github.com/octo/repo.git"
    assert "ghp_plaintext_secret" not in fields["remote_url"]
