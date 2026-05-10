-- PR #24 deep-review fix — defence-in-depth CHECK constraint on
-- renewal_cycles to enforce the `expires_at = period_to` invariant.
--
-- Background: migration 0087 created `renewal_cycles` with both
-- `period_to timestamptz NOT NULL` and `expires_at timestamptz NOT NULL`,
-- with the invariant `expires_at = period_to` enforced ONLY by the
-- BEFORE INSERT/UPDATE trigger `renewal_cycles_sync_expires_at_fn`.
-- The pipeline + eligibility indexes both filter on `expires_at`, so
-- a divergence (caused by trigger bypass — pg_restore, ALTER TABLE
-- DISABLE TRIGGER, direct superuser write) silently mis-schedules
-- reminders or misses cycles entirely.
--
-- A column-level CHECK adds a second-layer enforcement at near-zero
-- cost. Postgres applies CHECK constraints regardless of whether
-- triggers fire, so any trigger-bypass scenario raises immediately
-- instead of corrupting the index-served read path.
--
-- Idempotent: wraps in DO block to skip if the constraint already
-- exists. Safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = current_schema()
      AND table_name = 'renewal_cycles'
      AND constraint_name = 'renewal_cycles_expires_at_eq_period_to_check'
  ) THEN
    ALTER TABLE "renewal_cycles"
      ADD CONSTRAINT "renewal_cycles_expires_at_eq_period_to_check"
      CHECK ("expires_at" = "period_to");
  END IF;
END $$;
