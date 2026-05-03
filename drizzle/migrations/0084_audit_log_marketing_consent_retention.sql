-- ---------------------------------------------------------------------------
-- Round 3 PDPA/GDPR review M-2 — promote the marketing-consent
-- acknowledgement audit event to 10-year retention.
--
-- Background:
--   F7 events default to 5-year retention (migration 0064 + the
--   trigger chain in migrations 0039/0055/0063). One F7 event type
--   serves a different legal purpose:
--
--     `member_acknowledged_broadcasts_terms`
--
--   This is the GDPR Art. 7 written-consent record for marketing
--   broadcast dispatch (PDPA §24 marketing-consent equivalent in TH).
--   The `members.broadcasts_acknowledged_at` column is the primary
--   indefinite evidence, but the audit row carries the FORENSIC trail
--   (request id, source headers, locale at acknowledgement, exact
--   wording version) which dashboards and DPO requests rely on.
--
--   At 5 years, a member who stays on the chamber longer than 5 years
--   loses the audit forensic record while the consent itself remains
--   active. PDPA §35 requires retention "as long as necessary for the
--   purpose" — for an indefinite consent, the bound is the
--   relationship-end date.
--
-- This migration:
--   1. CREATE OR REPLACE the BEFORE-INSERT trigger function from
--      migration 0063 to ALSO promote `member_acknowledged_broadcasts_terms`
--      to 10y, mirroring the F4 tax-doc pattern. Idempotent — replaces
--      the existing function in place.
--   2. Idempotent backfill — any existing row at retention=5 gets
--      promoted to 10. WHERE clause filters by event type + retention
--      so re-runs are safe.
--   3. The trigger is named `audit_log_default_retention_for_f4_tax_docs`
--      from migration 0055; keep the name (the function now handles both
--      F4 tax docs and F7 marketing consent — function name no longer
--      matches scope, but renaming would orphan the existing trigger
--      binding. Future F9 retention-policy refactor can rename in one
--      sweep).
--
-- Compliance:
--   - PDPA §35 (retention while purpose persists; indefinite consent
--     means relationship-end is the bound, not 5 years).
--   - GDPR Art. 7 (written consent record evidence).
--   - GDPR Art. 30 (records of processing activities — must include
--     retention policy with legal basis per category of data).
--
-- Atomicity: implicit drizzle-kit tx wraps the whole file. CREATE OR
-- REPLACE FUNCTION + UPDATE both run inside one tx; failure rolls back.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type IN (
    -- F4 tax documents (Thai RD §87/3 + §86/10) — 10y retention:
    'invoice_issued',
    'invoice_paid',
    'invoice_voided',
    'credit_note_issued',
    'invoice_pdf_resent',
    'invoice_pdf_regenerated',
    'receipt_pdf_resent',
    'credit_note_pdf_resent',
    'receipt_rendered',
    -- Round 3 PDPA/GDPR review M-2 (2026-05-03) — marketing consent
    -- acknowledgement; 10y retention to match indefinite consent
    -- horizon under PDPA §35 + GDPR Art. 7.
    'member_acknowledged_broadcasts_terms'
  ) AND NEW.retention_years < 10 THEN
    NEW.retention_years = 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- Idempotent backfill — any existing marketing-consent rows still at
-- retention=5 from before this migration get promoted. Safe to re-run
-- because the WHERE clause filters on `retention_years = 5`.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;--> statement-breakpoint

UPDATE audit_log
   SET retention_years = 10
 WHERE event_type = 'member_acknowledged_broadcasts_terms'
   AND retention_years = 5;--> statement-breakpoint

ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
