-- Approvals: add annotations_json column.
--
-- The engine's ApprovalRepository.approve/reject pass annotations_json (engine
-- interface.py), but the cloud approvals table (0011) only had `reason`. Without
-- this column the Supabase approve/reject path raised a TypeError / unknown-column
-- error at decision time. Add it nullable so existing rows are unaffected.
ALTER TABLE public.approvals
    ADD COLUMN IF NOT EXISTS annotations_json TEXT;
