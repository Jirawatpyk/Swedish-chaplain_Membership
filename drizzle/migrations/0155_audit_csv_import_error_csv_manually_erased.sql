-- ---------------------------------------------------------------------------
-- 0155 — F6.1 staff-review L-R3v2-6: audit_event_type enum extension
-- ---------------------------------------------------------------------------
--
-- Closes staff-review L-R3v2-6 (2026-05-16). The DSR-time manual
-- erasure procedure in `docs/runbooks/f6-manual-erasure.md § F6.1`
-- instructs DPOs to `INSERT INTO audit_log` with
-- `event_type = 'csv_import_error_csv_manually_erased'` after running
-- `scripts/erase-error-blob.ts`. Without this enum value, the INSERT
-- fails with Postgres `22P02 invalid input value for enum`, and the
-- DPO has no forensic record of the manual erasure — a PDPA Art. 30
-- record-of-processing breach.
--
-- The original R3 fix (commit `49eee647`) explicitly documented this
-- event type as "NOT in the canonical F6.1 audit-event taxonomy" with
-- the rationale that manual-erasure is a rare DPO-gated path. But the
-- TypeScript port doesn't need the value (no use-case emits it
-- programmatically); only the Postgres enum does, because the runbook
-- uses raw `INSERT INTO audit_log` via the Neon SQL editor.
--
-- Idempotent: `EXCEPTION WHEN duplicate_object THEN NULL` covers the
-- re-apply case (same pattern as migration 0141 which added the other
-- 3 F6.1 audit event types).
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'csv_import_error_csv_manually_erased';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
