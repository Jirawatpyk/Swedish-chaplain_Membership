-- =========================================================================
-- 0145 — F6.1 (Feature 013 · T026 CR-1 fix): events.source CHECK extension
-- =========================================================================
--
-- Closes Review Round 1 CR-1 (review-toolkit code-reviewer).
--
-- Migration 0127 created `events` with constraint:
--   CHECK ("source" IN ('eventcreate'))
--
-- T026 added `'admin_manual'` as a new value to the `Source` TypeScript
-- union + `createEvent` use-case calls `eventsRepo.upsert({source:
-- 'admin_manual', ...})`. The DB CHECK was missed — every inline-create
-- modal submission would fail with a 500 / db_error on Postgres
-- constraint violation (smoke test would have caught this; TESTS-C-1 is
-- the companion fix that adds those tests).
--
-- Drop + recreate the CHECK to admit both values. Zero downtime —
-- DROP+ADD on a CHECK that's already satisfied by every existing row
-- (all current rows have source='eventcreate', within the new
-- domain).
-- =========================================================================

ALTER TABLE "events"
  DROP CONSTRAINT IF EXISTS "events_source_check";

ALTER TABLE "events"
  ADD CONSTRAINT "events_source_check"
  CHECK ("source" IN ('eventcreate', 'admin_manual'));
