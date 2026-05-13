-- F6 round-6 staff-review fix W5 (2026-05-13) — add audit event type
-- `webhook_ingest_precondition_failed` so pre-tx failures (config load
-- DB error, tenant resolution anomaly) stop polluting the
-- `webhook_rolled_back` forensic taxonomy.
--
-- The `webhook_rolled_back` event was previously emitted for BOTH
-- genuine strict-tx rollbacks AND for config-load failures — making
-- SRE dashboards filtering on `webhook_rolled_back` see spurious
-- rows from Neon connectivity blips and diluting legitimate rollback
-- signals. The new distinct event keeps the two failure modes
-- queryable independently.
--
-- Idempotent DO-block — survives partial-replay (Postgres restriction:
-- enum extensions cannot live in the same tx as their first use). Same
-- pattern as the 35 F6 enum additions in migration 0132 + the
-- `webhook_secret_force_expired` follow-up in 0135.

DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'webhook_ingest_precondition_failed'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
