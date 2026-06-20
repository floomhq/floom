-- Migration 0048: add per-run cost accounting columns to runs.
--
-- The engine computes total_tokens (from the run transcript) and total_cost_usd
-- (a blended estimate) at terminal status. It used to persist them with a raw
-- sqlite write, which never reached the cloud's Supabase runs table, so every
-- cloud run showed null total_tokens / total_cost_usd and the monthly-spend
-- aggregate was always 0. The engine now routes that write through
-- repos.runs.update, and the Supabase runs repo allow-lists these two columns;
-- this migration adds the columns they target.
--
-- total_cost_usd defaults to 0.0 to match the engine's sqlite "no cost recorded
-- yet" sentinel (RunDetail hides 0.0 as "not recorded"). total_tokens stays
-- nullable (script-only runs have no LLM tokens).

ALTER TABLE public.runs
    ADD COLUMN IF NOT EXISTS total_tokens   INTEGER,
    ADD COLUMN IF NOT EXISTS total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0.0;
