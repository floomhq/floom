from __future__ import annotations


def _phase_3() -> None:
    raise NotImplementedError("Phase 3")


class SupabaseWorkerRepository:
    def list(self, **kwargs):
        _phase_3()

    def get(self, **kwargs):
        _phase_3()

    def get_any(self, **kwargs):
        _phase_3()

    def create(self, **kwargs):
        _phase_3()

    def update(self, **kwargs):
        _phase_3()

    def delete(self, **kwargs):
        _phase_3()

    def list_recent_runs(self, **kwargs):
        _phase_3()

    def get_last_run(self, **kwargs):
        _phase_3()

    def stats_batch(self, **kwargs):
        _phase_3()

    def timeseries_batch(self, **kwargs):
        _phase_3()

    def get_owner(self, **kwargs):
        _phase_3()

    def list_scheduled(self, **kwargs):
        _phase_3()

    def get_schedule_state(self, **kwargs):
        _phase_3()

    def set_next_run_at(self, **kwargs):
        _phase_3()

    def mark_scheduled_run(self, **kwargs):
        _phase_3()

    def list_active_run_ids(self, **kwargs):
        _phase_3()

    def get_skill_version_ref_count(self, **kwargs):
        _phase_3()

    def delete_skill_version(self, **kwargs):
        _phase_3()

    def get_recipe(self, **kwargs):
        _phase_3()

    def upsert_webhook_secret_hash(self, **kwargs):
        _phase_3()

    def get_webhook_secret_hash(self, **kwargs):
        _phase_3()

    def delete_webhook_secret(self, **kwargs):
        _phase_3()


class SupabaseRunRepository:
    def list_for_worker(self, **kwargs):
        _phase_3()

    def list(self, **kwargs):
        _phase_3()

    def get(self, **kwargs):
        _phase_3()

    def get_any(self, **kwargs):
        _phase_3()

    def create(self, **kwargs):
        _phase_3()

    def update(self, **kwargs):
        _phase_3()

    def delete(self, **kwargs):
        _phase_3()

    def set_input_json(self, **kwargs):
        _phase_3()

    def update_status(self, **kwargs):
        _phase_3()

    def add_log(self, **kwargs):
        _phase_3()

    def list_logs(self, **kwargs):
        _phase_3()

    def add_artifact(self, **kwargs):
        _phase_3()

    def list_artifacts(self, **kwargs):
        _phase_3()

    def clear_all(self, **kwargs):
        _phase_3()

    def list_all_ids(self, **kwargs):
        _phase_3()

    def cancel(self, **kwargs):
        _phase_3()

    def count_running_for_worker(self, **kwargs):
        _phase_3()

    def set_bundle_snapshot_path(self, **kwargs):
        _phase_3()

    def get_bundle_snapshot_path(self, **kwargs):
        _phase_3()


class SupabaseConnectionRepository:
    def list(self, **kwargs):
        _phase_3()

    def get(self, **kwargs):
        _phase_3()

    def get_by_composio_connection_id(self, **kwargs):
        _phase_3()

    def upsert(self, **kwargs):
        _phase_3()

    def update(self, **kwargs):
        _phase_3()

    def delete(self, **kwargs):
        _phase_3()

    def list_all(self, **kwargs):
        _phase_3()


class SupabaseSecretRepository:
    def list(self, **kwargs):
        _phase_3()

    def get(self, **kwargs):
        _phase_3()

    def set(self, **kwargs):
        _phase_3()

    def delete(self, **kwargs):
        _phase_3()

    def read_value(self, **kwargs):
        _phase_3()

    def list_names(self, **kwargs):
        _phase_3()

    def resolve(self, **kwargs):
        _phase_3()


class SupabaseCliAuthRepository:
    def create_device(self, **kwargs):
        _phase_3()

    def verify_device(self, *args, **kwargs):
        _phase_3()

    def consume(self, *args, **kwargs):
        _phase_3()

    def list(self, **kwargs):
        _phase_3()

    def get(self, **kwargs):
        _phase_3()

    def get_by_device_code(self, **kwargs):
        _phase_3()

    def update(self, **kwargs):
        _phase_3()

    def delete(self, **kwargs):
        _phase_3()

    def prune_expired(self, **kwargs):
        _phase_3()
