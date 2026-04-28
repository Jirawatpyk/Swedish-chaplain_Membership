-- ---------------------------------------------------------------------------
-- F5 staff-review #4 round 2026-04-29 (A3.1 + A3.2 closure) — extend the
-- BEFORE-INSERT retention-default trigger from migration 0055 to cover
-- 3 additional F4 tax-document-touching event types that were tagged 10y
-- in `F4_AUDIT_RETENTION_YEARS` (`src/modules/invoicing/application/ports/
-- audit-port.ts`) but were NEVER added to the DB-layer trigger nor the
-- migration 0039 backfill.
--
-- Background:
--   - Migration 0039 (R2-E4 Review-Gate) backfilled 6 F4 types to 10y.
--   - Migration 0055 (F5 R2 review) added the BEFORE-INSERT trigger to
--     auto-default 10y on raw-SQL inserts of those same 6 types.
--   - Subsequent F4/F5 phases ADDED 3 more 10y types to the application
--     retention map (`F4_AUDIT_RETENTION_YEARS`):
--       * `receipt_pdf_resent`        (manual receipt-PDF resend audit)
--       * `credit_note_pdf_resent`    (manual credit-note-PDF resend)
--       * `receipt_rendered`          (T166 async render landing audit)
--     The application adapter at `src/modules/invoicing/infrastructure/
--     adapters/audit-adapter.ts` correctly calls `f4RetentionFor()` on
--     every emit, so go-forward APP-LAYER inserts land at retention=10.
--   - However raw-SQL inserts (test seeds, dev-apply scripts, psql
--     incident recovery) bypass the adapter and fall through to the
--     column DEFAULT 5 — silently downgrading tax-document retention
--     to 5y, which would violate Thai RD §87/3 + §86/10 if F9's future
--     GDPR purge job ever runs.
--
-- This migration adds defense-in-depth at the DB layer:
--   1. CREATE OR REPLACE the trigger function with the extended 9-type
--      IN() list (idempotent — replaces the existing function in place).
--   2. Idempotent backfill UPDATE for any existing rows of the 3 newly-
--      covered types currently at retention_years=5. Wrapped by the
--      same DISABLE / UPDATE / ENABLE pattern as migration 0039.
--
-- Compliance: Thai RD §87/3 (tax-document 5y minimum, we use 10y) +
-- §86/10 (credit-note ใบลดหนี้) + GDPR Art. 6(1)(c) legal-obligation
-- retention basis.
--
-- Atomicity: drizzle-kit wraps each migration file in an implicit
-- transaction. CREATE OR REPLACE FUNCTION + ALTER TRIGGER + UPDATE all
-- run inside the same tx; failure rolls back everything atomically.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type IN (
    -- Original 6 types (migration 0055):
    'invoice_issued',
    'invoice_paid',
    'invoice_voided',
    'credit_note_issued',
    'invoice_pdf_resent',
    'invoice_pdf_regenerated',
    -- Added 2026-04-29 — full coverage of F4_AUDIT_RETENTION_YEARS 10y types:
    'receipt_pdf_resent',
    'credit_note_pdf_resent',
    'receipt_rendered'
  ) AND NEW.retention_years < 10 THEN
    NEW.retention_years = 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Idempotent backfill — any rows of the 3 newly-covered types still at
-- retention=5 from prior raw-SQL inserts (test fixtures, dev-apply
-- scripts) get promoted to 10. Safe to re-run because the WHERE clause
-- filters on `retention_years = 5` (already-promoted rows are skipped).
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;--> statement-breakpoint

UPDATE audit_log
   SET retention_years = 10
 WHERE event_type IN (
       'receipt_pdf_resent',
       'credit_note_pdf_resent',
       'receipt_rendered'
     )
   AND retention_years = 5;--> statement-breakpoint

ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
