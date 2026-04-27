CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  manifest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  docker_image TEXT,
  code_path TEXT NOT NULL,
  category TEXT,
  author TEXT,
  icon TEXT,
  app_type TEXT NOT NULL DEFAULT 'docker',
  base_url TEXT,
  auth_type TEXT,
  auth_config TEXT,
  openapi_spec_url TEXT,
  openapi_spec_cached TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  link_share_token TEXT,
  link_share_requires_auth BOOLEAN NOT NULL DEFAULT false,
  review_submitted_at TIMESTAMPTZ,
  review_decided_at TIMESTAMPTZ,
  review_decided_by TEXT,
  review_comment TEXT,
  is_async BOOLEAN NOT NULL DEFAULT false,
  webhook_url TEXT,
  timeout_ms INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  async_mode TEXT,
  max_run_retention_days INTEGER,
  workspace_id TEXT NOT NULL DEFAULT 'local',
  memory_keys TEXT,
  featured BOOLEAN NOT NULL DEFAULT false,
  avg_run_ms INTEGER,
  publish_status TEXT NOT NULL DEFAULT 'pending_review',
  thumbnail_url TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  hero BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug);
CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category);
CREATE INDEX IF NOT EXISTS idx_apps_featured_avg ON apps(featured, avg_run_ms);
CREATE INDEX IF NOT EXISTS idx_apps_publish_status ON apps(publish_status);
CREATE INDEX IF NOT EXISTS idx_apps_workspace ON apps(workspace_id);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS link_share_token TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS link_share_requires_auth BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_decided_at TIMESTAMPTZ;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_decided_by TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_comment TEXT;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  thread_id TEXT,
  action TEXT NOT NULL,
  inputs JSONB,
  outputs JSONB,
  logs TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  error_type TEXT,
  upstream_status INTEGER,
  duration_ms INTEGER,
  workspace_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT,
  device_id TEXT,
  is_public BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app_id);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_user ON runs(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_runs_device ON runs(device_id) WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  input_json JSONB,
  output_json JSONB,
  error_json JSONB,
  run_id TEXT,
  webhook_url TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  max_retries INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  per_call_secrets_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_slug_status ON jobs(slug, status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_unique
  ON secrets(name, COALESCE(app_id, '__global__'));

CREATE TABLE IF NOT EXISTS run_threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  workspace_id TEXT NOT NULL DEFAULT 'local',
  user_id TEXT,
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_threads_workspace_user ON run_threads(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_threads_device ON run_threads(device_id) WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES run_threads(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(thread_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_run_turns_thread ON run_turns(thread_id, turn_index);
WITH ranked AS (
  SELECT id,
         (ROW_NUMBER() OVER (
           PARTITION BY thread_id
           ORDER BY turn_index ASC, created_at ASC, id ASC
         ) - 1)::integer AS new_turn_index
    FROM run_turns
)
UPDATE run_turns
   SET turn_index = ranked.new_turn_index
  FROM ranked
 WHERE run_turns.id = ranked.id
   AND run_turns.turn_index <> ranked.new_turn_index;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_run_turns_thread_turn_index ON run_turns(thread_id, turn_index);

CREATE TABLE IF NOT EXISTS embeddings (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  vector BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'oss',
  wrapped_dek TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT,
  name TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  auth_subject TEXT,
  image TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  delete_at TEXT,
  composio_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth
  ON users(auth_provider, auth_subject)
  WHERE auth_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS app_invites (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  invited_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  invited_email TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending_email', 'pending_accept', 'accepted', 'revoked', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_app_invites_app_user
  ON app_invites(app_id, invited_user_id);
CREATE INDEX IF NOT EXISTS idx_app_invites_email
  ON app_invites(invited_email);

CREATE TABLE IF NOT EXISTS app_visibility_audit (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_visibility_audit_app_created
  ON app_visibility_audit(app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'admin',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read-write', 'publish-only')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(hash);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user_revoked
  ON agent_tokens(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS app_memory (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_slug TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, app_slug, user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_app_memory_device
  ON app_memory(device_id)
  WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_memory_user
  ON app_memory(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS user_secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  encrypted_dek TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, key)
);

CREATE TABLE IF NOT EXISTS encrypted_secrets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  encrypted_dek TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('device', 'user')),
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  composio_connection_id TEXT NOT NULL,
  composio_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_kind, owner_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections(workspace_id, owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_connections_provider ON connections(workspace_id, provider);
CREATE INDEX IF NOT EXISTS idx_connections_composio ON connections(composio_connection_id);

CREATE TABLE IF NOT EXISTS stripe_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL DEFAULT 'express' CHECK (account_type IN ('express', 'standard')),
  country TEXT,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  requirements_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_stripe_accounts_workspace ON stripe_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_stripe_accounts_user ON stripe_accounts(workspace_id, user_id);

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  livemode BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type ON stripe_webhook_events(event_type);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  invited_by_user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invites_workspace ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invites_email ON workspace_invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_token ON workspace_invites(token);

CREATE TABLE IF NOT EXISTS user_active_workspace (
  user_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, app_slug, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_reviews_slug ON app_reviews(app_slug);
CREATE INDEX IF NOT EXISTS idx_app_reviews_user ON app_reviews(user_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  user_id TEXT,
  device_id TEXT,
  email TEXT,
  url TEXT,
  text TEXT NOT NULL,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  deploy_repo_url TEXT,
  deploy_intent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_lower ON waitlist_signups(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist_signups(created_at);

CREATE TABLE IF NOT EXISTS app_secret_policies (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('user_vault', 'creator_override')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, key)
);
CREATE INDEX IF NOT EXISTS idx_app_secret_policies_app ON app_secret_policies(app_id);

CREATE TABLE IF NOT EXISTS app_creator_secrets (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  encrypted_dek TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, key)
);
CREATE INDEX IF NOT EXISTS idx_app_creator_secrets_app ON app_creator_secrets(app_id);
CREATE INDEX IF NOT EXISTS idx_app_creator_secrets_workspace ON app_creator_secrets(workspace_id);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'webhook')),
  cron_expression TEXT,
  tz TEXT,
  webhook_secret TEXT,
  webhook_url_path TEXT,
  next_run_at BIGINT,
  last_fired_at BIGINT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  retry_policy JSONB,
  created_at BIGINT NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint,
  updated_at BIGINT NOT NULL DEFAULT (floor(extract(epoch from now()) * 1000))::bigint
);
CREATE INDEX IF NOT EXISTS idx_triggers_schedule ON triggers(trigger_type, enabled, next_run_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_webhook_path
  ON triggers(webhook_url_path)
  WHERE webhook_url_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_triggers_app ON triggers(app_id);
CREATE INDEX IF NOT EXISTS idx_triggers_user ON triggers(user_id);

CREATE TABLE IF NOT EXISTS trigger_webhook_deliveries (
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  received_at BIGINT NOT NULL,
  PRIMARY KEY (trigger_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_trigger_deliveries_received
  ON trigger_webhook_deliveries(received_at);

INSERT INTO workspaces (id, slug, name, plan)
VALUES ('local', 'local', 'Local', 'oss')
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, workspace_id, email, name, auth_provider)
VALUES ('local', 'local', NULL, '', 'local')
ON CONFLICT (id) DO UPDATE SET name = CASE WHEN users.name = 'Local User' THEN '' ELSE users.name END;

INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ('local', 'local', 'admin')
ON CONFLICT (workspace_id, user_id) DO NOTHING;
