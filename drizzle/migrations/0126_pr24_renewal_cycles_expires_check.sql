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

-- Round 8 review-fix — defensive backfill BEFORE adding the CHECK
-- constraint. The trigger has been live since migration 0087 so prod
-- rows always satisfy the invariant, but a dev/staging environment
-- that ever had the trigger disabled (pg_restore, ALTER TABLE DISABLE
-- TRIGGER, manual superuser write) could have divergent rows. Without
-- this UPDATE, ALTER TABLE ADD CONSTRAINT CHECK would raise
-- "constraint is violated by some row" and abort the migration. The
-- UPDATE is a no-op when the invariant already holds (zero-row write).
UPDATE "renewal_cycles"
   SET "expires_at" = "period_to"
 WHERE "expires_at" IS DISTINCT FROM "period_to";

-- Round 8 review-fix — idempotency check uses `pg_constraint.conname`
-- (schema-agnostic OID lookup) instead of `information_schema
-- .table_constraints WHERE constraint_schema = current_schema()`.
-- See migration 0125 header comment for full rationale.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'renewal_cycles_expires_at_eq_period_to_check'
  ) THEN
    ALTER TABLE "renewal_cycles"
      ADD CONSTRAINT "renewal_cycles_expires_at_eq_period_to_check"
      CHECK ("expires_at" = "period_to");
  END IF;
END $$;
