-- #277: durable, atomic inbound-webhook delivery-receipt store for the cloud.
--
-- The engine dedups webhook redeliveries (GitHub/Composio retry the same
-- delivery id) via _claim_webhook_delivery, which defaults to SQLite. On the
-- ephemeral, sometimes multi-instance Railway container that (A) raises
-- "database is locked" 500s that drop legit webhooks before run creation, and
-- (B) loses the receipt table on every redeploy so the dedup never fires.
--
-- Cloud registers a Supabase-backed store (SupabaseWebhookDeliveryStore) via the
-- engine's set_webhook_delivery_store seam. The composite primary key is the
-- atomic claim: the FIRST insert of a (source, delivery_id) wins; a redelivery
-- collides and is dropped. received_at drives TTL expiry (default 7d).
CREATE TABLE IF NOT EXISTS public.webhook_delivery_receipts (
    source       TEXT        NOT NULL,
    delivery_id  TEXT        NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source, delivery_id)
);

-- Supports the per-source TTL expiry sweep (DELETE ... WHERE source=? AND
-- received_at <= cutoff).
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_receipts_received_at
    ON public.webhook_delivery_receipts (received_at);

-- Internal dedup ledger: no end-user ever reads it; only the service_role
-- (BYPASSRLS) data path writes. Match the migration 0028 lockdown posture —
-- enable + FORCE RLS and revoke anon/public — so direct PostgREST access by
-- non-service roles is denied (no policies = zero rows for anon/authenticated).
ALTER TABLE public.webhook_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_delivery_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.webhook_delivery_receipts FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.webhook_delivery_receipts FROM public;
