-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C verify-run remediation (D1) — set DB-level default
-- on `membership_plans.renewal_tier_bucket`.
--
-- Wave C-6 / migration 0094 added the column with `NOT NULL` + a CHECK
-- constraint, but the ALTER TABLE statement did NOT include a
-- `SET DEFAULT 'regular'` clause. The Drizzle schema declares
-- `.default('regular')` which only emits the default in `CREATE TABLE`
-- statements, NOT in retroactive ALTER COLUMN — so the live DB column
-- has NO default.
--
-- Existing F2 + F3 + integration test fixtures that INSERT into
-- `membership_plans` without explicitly setting `renewal_tier_bucket`
-- have been quietly failing with Postgres NOT NULL violation 23502
-- (mis-classified as Upstash rate-limit transients in Wave C-6 verify).
-- This migration syncs the DB default with the Drizzle schema so all
-- existing call sites continue to work without per-call-site changes.
--
-- Idempotent: re-running is safe (Postgres treats SET DEFAULT as a
-- write to pg_attrdef; same value on re-apply is a no-op).
-- ---------------------------------------------------------------------------

ALTER TABLE "membership_plans"
  ALTER COLUMN "renewal_tier_bucket" SET DEFAULT 'regular';--> statement-breakpoint
