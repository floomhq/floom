-- Migration 0011: approvals table for HITL (human-in-the-loop) approval flow.
-- Mirrors the engine's SQLite approvals schema, workspace-scoped for cloud.

CREATE TABLE IF NOT EXISTS public.approvals (
    id              TEXT        PRIMARY KEY,
    owner_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    workspace_id    TEXT        REFERENCES public.workspaces(id) ON DELETE CASCADE,
    run_id          TEXT        NOT NULL,
    worker_id       TEXT,
    status          TEXT        NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    label           TEXT,
    preview         TEXT,
    decision_input_json  TEXT,
    edited_output_json   TEXT,
    follow_up_run_id     TEXT,
    reason          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS approvals_owner_status_idx
    ON public.approvals (owner_id, status);

CREATE INDEX IF NOT EXISTS approvals_run_id_idx
    ON public.approvals (run_id);

-- RLS
ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "approvals: owner full access"
    ON public.approvals
    FOR ALL
    USING (auth.uid() = owner_id);
