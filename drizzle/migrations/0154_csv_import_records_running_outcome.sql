-- ---------------------------------------------------------------------------
-- 0154 — F6.1 staff-review M-5: csv_import_records.outcome 'running' literal
-- ---------------------------------------------------------------------------
--
-- Closes staff-review finding M-5 (2026-05-16) + spec US5 AS3 ("in-progress
-- imports shown as Running…"). Migration 0139 created the table with a
-- CHECK constraint that did NOT admit a 'running' value, so the initial
-- placeholder INSERT was forced to use 'unexpected_error' — admins
-- refreshing /admin/events/import/history during an active upload saw
-- their own in-flight import as "failed" until the use-case committed.
--
-- Zero-downtime: DROP + ADD the CHECK with the new value in the closed
-- set. Existing rows all use one of the terminal values so the new
-- constraint is satisfied by every existing row at apply time.
-- ---------------------------------------------------------------------------

ALTER TABLE "csv_import_records"
  DROP CONSTRAINT IF EXISTS "csv_import_records_outcome_check";--> statement-breakpoint

ALTER TABLE "csv_import_records"
  ADD CONSTRAINT "csv_import_records_outcome_check"
  CHECK ("outcome" IN (
    'running',
    'completed',
    'timeout',
    'partial_failure',
    'invalid_header',
    'event_not_found',
    'event_not_owned_by_tenant',
    'unexpected_error'
  ));--> statement-breakpoint
