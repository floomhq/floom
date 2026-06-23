from __future__ import annotations

from apps.api.db.supabase_repos import _upload_run_artifact_to_storage


class _Bucket:
    def __init__(self) -> None:
        self.uploaded: dict[str, bytes] = {}

    def upload(self, key: str, data: bytes) -> None:
        self.uploaded[key] = data


class _Storage:
    def __init__(self, bucket: _Bucket) -> None:
        self.bucket = bucket
        self.bucket_name = ""

    def from_(self, name: str) -> _Bucket:
        self.bucket_name = name
        return self.bucket


class _Client:
    def __init__(self) -> None:
        self.bucket = _Bucket()
        self.storage = _Storage(self.bucket)


def test_run_artifact_upload_returns_supabase_path(tmp_path):
    artifact = tmp_path / "report.csv"
    artifact.write_bytes(b"name,value\nfloom,1\n")
    client = _Client()

    stored = _upload_run_artifact_to_storage(
        client,
        user_id="user@example.com",
        run_id="run/1",
        artifact_id="art:1",
        name="report.csv",
        path=str(artifact),
    )

    assert stored is not None
    assert stored.startswith("supabase://workeros-run-artifacts/")
    assert client.storage.bucket_name == "workeros-run-artifacts"
    assert list(client.bucket.uploaded.values()) == [b"name,value\nfloom,1\n"]
