-- Migration 0032: worker_alerts — move alert registrations from SQLite to Supabase.
--
-- Previously stored only in the engine's local SQLite DB (worker_alerts table).
-- Problems: lost on server restart, no workspace isolation (all tenants share one DB).
-- This table is the cloud-authoritative store for webhook/email alert registrations.
--
-- alert_incidents (internal dedup tracking) stays in SQLite — losing it on restart
-- means at most one duplicate alert notification, which is acceptable.

CREATE TABLE IF NOT EXISTS worker_alerts (
    id           TEXT        PRIMARY KEY,          -- alrt_<uuid12>
    workspace_id TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    worker_id    TEXT        NOT NULL,
    url          TEXT,                              -- webhook URL (nullable)
    email_to     TEXT,                              -- JSON array of email addresses
    events       TEXT        NOT NULL DEFAULT 'failed',  -- comma-separated event types
    description  TEXT,
    created_at   TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_alerts_workspace_idx ON worker_alerts(workspace_id);
CREATE INDEX IF NOT EXISTS worker_alerts_worker_idx    ON worker_alerts(worker_id);

-- RLS: service role bypasses (backend only data path). Public/anon denied.
ALTER TABLE worker_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON worker_alerts
    USING (auth.role() = 'service_role');
