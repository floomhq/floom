grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.users enable row level security;
alter table public.skill_versions enable row level security;
alter table public.workers enable row level security;
alter table public.worker_webhook_secrets enable row level security;
alter table public.runs enable row level security;
alter table public.run_logs enable row level security;
alter table public.artifacts enable row level security;
alter table public.connections enable row level security;
alter table public.secrets enable row level security;
alter table public.cli_auth_devices enable row level security;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users
    for select to authenticated
    using (auth.uid() = id);
drop policy if exists users_insert_own on public.users;
create policy users_insert_own on public.users
    for insert to authenticated
    with check (auth.uid() = id);
drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users
    for update to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id);
drop policy if exists users_delete_own on public.users;
create policy users_delete_own on public.users
    for delete to authenticated
    using (auth.uid() = id);

drop policy if exists skill_versions_select_own on public.skill_versions;
create policy skill_versions_select_own on public.skill_versions
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists skill_versions_insert_own on public.skill_versions;
create policy skill_versions_insert_own on public.skill_versions
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists skill_versions_update_own on public.skill_versions;
create policy skill_versions_update_own on public.skill_versions
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists skill_versions_delete_own on public.skill_versions;
create policy skill_versions_delete_own on public.skill_versions
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists workers_select_own on public.workers;
create policy workers_select_own on public.workers
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists workers_insert_own on public.workers;
create policy workers_insert_own on public.workers
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists workers_update_own on public.workers;
create policy workers_update_own on public.workers
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists workers_delete_own on public.workers;
create policy workers_delete_own on public.workers
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists worker_webhook_secrets_select_own on public.worker_webhook_secrets;
create policy worker_webhook_secrets_select_own on public.worker_webhook_secrets
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists worker_webhook_secrets_insert_own on public.worker_webhook_secrets;
create policy worker_webhook_secrets_insert_own on public.worker_webhook_secrets
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists worker_webhook_secrets_update_own on public.worker_webhook_secrets;
create policy worker_webhook_secrets_update_own on public.worker_webhook_secrets
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists worker_webhook_secrets_delete_own on public.worker_webhook_secrets;
create policy worker_webhook_secrets_delete_own on public.worker_webhook_secrets
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists runs_select_own on public.runs;
create policy runs_select_own on public.runs
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists runs_insert_own on public.runs;
create policy runs_insert_own on public.runs
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists runs_update_own on public.runs;
create policy runs_update_own on public.runs
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists runs_delete_own on public.runs;
create policy runs_delete_own on public.runs
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists run_logs_select_own on public.run_logs;
create policy run_logs_select_own on public.run_logs
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists run_logs_insert_own on public.run_logs;
create policy run_logs_insert_own on public.run_logs
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists run_logs_update_own on public.run_logs;
create policy run_logs_update_own on public.run_logs
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists run_logs_delete_own on public.run_logs;
create policy run_logs_delete_own on public.run_logs
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists artifacts_select_own on public.artifacts;
create policy artifacts_select_own on public.artifacts
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists artifacts_insert_own on public.artifacts;
create policy artifacts_insert_own on public.artifacts
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists artifacts_update_own on public.artifacts;
create policy artifacts_update_own on public.artifacts
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists artifacts_delete_own on public.artifacts;
create policy artifacts_delete_own on public.artifacts
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists connections_select_own on public.connections;
create policy connections_select_own on public.connections
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists connections_insert_own on public.connections;
create policy connections_insert_own on public.connections
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists connections_update_own on public.connections;
create policy connections_update_own on public.connections
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists connections_delete_own on public.connections;
create policy connections_delete_own on public.connections
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists secrets_select_own on public.secrets;
create policy secrets_select_own on public.secrets
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists secrets_insert_own on public.secrets;
create policy secrets_insert_own on public.secrets
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists secrets_update_own on public.secrets;
create policy secrets_update_own on public.secrets
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists secrets_delete_own on public.secrets;
create policy secrets_delete_own on public.secrets
    for delete to authenticated
    using (auth.uid() = user_id);

drop policy if exists cli_auth_devices_select_own on public.cli_auth_devices;
create policy cli_auth_devices_select_own on public.cli_auth_devices
    for select to authenticated
    using (auth.uid() = user_id);
drop policy if exists cli_auth_devices_insert_own on public.cli_auth_devices;
create policy cli_auth_devices_insert_own on public.cli_auth_devices
    for insert to authenticated
    with check (auth.uid() = user_id);
drop policy if exists cli_auth_devices_update_own on public.cli_auth_devices;
create policy cli_auth_devices_update_own on public.cli_auth_devices
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
drop policy if exists cli_auth_devices_delete_own on public.cli_auth_devices;
create policy cli_auth_devices_delete_own on public.cli_auth_devices
    for delete to authenticated
    using (auth.uid() = user_id);
