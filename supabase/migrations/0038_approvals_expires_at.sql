-- Migration 0038: approvals.expires_at for lazy expiry (BE-EXPIRY / #798).
--
-- The engine's ApprovalRepository now stores expires_at on create (sqlite.py
-- #798) and flips any pending approval past expires_at to status='expired' via
-- expire_if_stale() on every read/action of /approvals. The cloud approvals
-- table (0011) had no expires_at column and no 'expired' status, so the lazy
-- expiry path was a silent no-op on cloud. Add the column nullable so existing
-- rows are unaffected; SupabaseApprovalRepository.expire_if_stale() guards on
-- it. The status column stays TEXT (no CHECK constraint in 0011), so 'expired'
-- needs no enum/constraint change — only the column comment is updated for
-- documentation.
ALTER TABLE public.approvals
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

COMMENT ON COLUMN public.approvals.status IS
    'pending | approved | rejected | expired';

-- Speeds up the lazy-expiry guarded UPDATE (status='pending' AND expires_at < now).
CREATE INDEX IF NOT EXISTS approvals_pending_expires_idx
    ON public.approvals (status, expires_at)
    WHERE status = 'pending';
