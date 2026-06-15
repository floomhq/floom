-- #280: enforce at most one PENDING approval per run (defense-in-depth).
--
-- The approve/reject TOCTOU is closed at the application layer: the conditional
-- `UPDATE ... WHERE status='pending'` is an atomic claim and the repo now
-- returns None to the route when it flips no row (so the 409 guard fires).
-- This partial unique index hardens the other amplifier — multiple concurrent
-- INSERTs creating several pending rows for the same run, which would let each
-- be decided independently. With the index, only one pending row per run can
-- exist; a duplicate pending insert fails fast instead of fanning out.
--
-- Dedupe any pre-existing duplicate pending rows first (keep newest, supersede
-- the rest) so the unique index can be created on dirty data. Idempotent.
UPDATE public.approvals a
SET status = 'superseded'
WHERE a.status = 'pending'
  AND a.id <> (
      SELECT b.id
      FROM public.approvals b
      WHERE b.run_id = a.run_id AND b.status = 'pending'
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_pending_per_run
    ON public.approvals (run_id)
    WHERE status = 'pending';
