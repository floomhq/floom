-- Migration 0033: worker_feedback — per-worker feedback comments (SPEC §12).
--
-- The engine added a worker-feedback feature (SqliteFeedbackRepository); the
-- cloud Supabase repositories never implemented one, so repos.feedback was None
-- and POST/GET/DELETE /workers/{id}/feedback returned 503 "feedback not
-- available". This table is the cloud-authoritative store, workspace-scoped for
-- tenant isolation. Mirrors the worker_alerts pattern (0032).
--
-- Feedback is immutable once written (no update path) and attributed to the
-- author; anyone who can SEE the worker may comment, surfaced to the owner.

CREATE TABLE IF NOT EXISTS worker_feedback (
    id           TEXT        PRIMARY KEY,          -- fdbk_<uuid12>
    workspace_id TEXT        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    worker_id    TEXT        NOT NULL,
    author_id    TEXT        NOT NULL,             -- user_id who left the comment
    author_name  TEXT,                              -- denormalized display name (nullable)
    content      TEXT        NOT NULL,
    created_at   TEXT        NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_feedback_workspace_idx ON worker_feedback(workspace_id);
CREATE INDEX IF NOT EXISTS worker_feedback_worker_idx    ON worker_feedback(worker_id);

-- RLS: service role bypasses (backend only data path). Public/anon denied.
ALTER TABLE worker_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON worker_feedback
    USING (auth.role() = 'service_role');
