CREATE TABLE IF NOT EXISTS agent_tokens (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read-write', 'publish-only')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(hash);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_user_revoked
  ON agent_tokens(user_id, revoked_at);

PRAGMA user_version = 15;
