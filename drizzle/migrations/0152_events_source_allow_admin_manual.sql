-- =========================================================================
-- 0152 — F6.1 (Feature 013 · T026 CR-1 fix): events.source CHECK extension
-- =========================================================================
--
-- Renumbered from 0145 → 0152 to close staff-review B-1 (2026-05-16): two
-- migrations claimed `idx:145` in `_journal.json` — F4's `0145_audit_
-- receipt_prefix_changed` was authored first, so drizzle-kit would record
-- idx:145 as applied and SKIP this F6.1 migration entirely. Result on
-- production: events.source CHECK stays at `('eventcreate')` only, and
-- every inline-create modal POST (T026) fails with Postgres 23514
-- check_violation. Renumber + journal patch keeps the migration intent
-- intact while making it apply correctly.
--
-- Original review tag: Round 1 CR-1 (review-toolkit code-reviewer).
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
