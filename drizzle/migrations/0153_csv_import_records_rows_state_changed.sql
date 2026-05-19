-- ---------------------------------------------------------------------------
-- 0153 — F6.1 staff-review H-1: csv_import_records.rows_state_changed
-- ---------------------------------------------------------------------------
--
-- Closes staff-review finding H-1 (2026-05-16). The `importCsv` use-case
-- already computes `rowsStateChanged` as a first-class summary counter
-- (the number of rows on a re-upload whose state actually changed — e.g.
-- Notes-driven payment_status flip, Attending→Cancelled) and surfaces it
-- on the `csv_import_completed` audit payload. But the persistence path
-- forgot to write it back to `csv_import_records`, leaving the column
-- silently 0 in operator-facing history queries.
--
-- This migration adds the column with DEFAULT 0 so the migration is
-- zero-downtime (no rewrite of existing rows) and the existing rows
-- materialise the correct 0 value for pre-H-1 imports (where state-
-- change semantics did not yet apply).
--
-- Non-negative invariant matches the sibling row-count columns.
-- ---------------------------------------------------------------------------

ALTER TABLE "csv_import_records"
  ADD COLUMN "rows_state_changed" integer NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "csv_import_records"
  ADD CONSTRAINT "csv_import_records_rows_state_changed_check"
  CHECK ("rows_state_changed" >= 0);--> statement-breakpoint
