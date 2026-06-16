from __future__ import annotations

from types import SimpleNamespace

from apps.api.db.supabase_repos import SupabaseRunRepository


class _RunsTable:
    def __init__(self):
        self.selected = ""
        self.count = None

    def select(self, columns, *, count=None):
        self.selected = columns
        self.count = count
        return self

    def eq(self, *_args):
        return self

    def in_(self, *_args):
        return self

    def gte(self, *_args):
        return self

    def lte(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def range(self, *_args):
        return self

    def execute(self):
        return SimpleNamespace(data=[], count=None)


class _Client:
    def __init__(self):
        self.runs = _RunsTable()

    def table(self, name):
        assert name == "runs"
        return self.runs


def test_run_list_projection_omits_heavy_detail_columns():
    client = _Client()
    repo = SupabaseRunRepository(client=client)

    rows, total = repo.list(user_id="user-a", include_total=False)

    assert rows == []
    assert total == 0
    assert "output_json" not in client.runs.selected
    assert "bundle_snapshot_path" not in client.runs.selected
    assert "cancel_requested" not in client.runs.selected
    assert client.runs.count is None
