-- ---------------------------------------------------------------------------
-- Migration 0316 — `member_acknowledged_broadcasts_terms` back to 5 years.
--
-- 0084 promoted this event to 10-year retention as the "GDPR Art. 7
-- written-consent record" for E-Blasts. E-Blasts do not rely on consent:
-- the lawful basis is legitimate interest (GDPR Art. 6(1)(f) / PDPA
-- §24(5)), and the event records a SENDING member's acknowledgement of the
-- E-Blast terms on the compose banner — not anyone's consent. Without the
-- consent rationale there is no reason to keep it longer than every other
-- F7 audit event, and keeping it longer than needed breaches storage
-- limitation (GDPR Art. 5(1)(e) / PDPA §37(3)). Decision 2026-10-06: it
-- returns to the 5y F7 default (`f7RetentionFor` already says 5, and the
-- emitter writes `retentionYears: 5` in its payload — only this trigger
-- disagreed). `members.broadcasts_acknowledged_at` keeps the fact itself
-- for as long as the member row exists.
--
-- This migration:
--   1. CREATE OR REPLACE the retention trigger function from its LATEST
--      body (0257) with `member_acknowledged_broadcasts_terms` removed.
--      Every other type in the IN() list is unchanged — dropping one by
--      accident would silently regress a tax record to 5y
--      (tests/integration/audit/retention-trigger.test.ts pins the list).
--   2. Backfill: existing rows of this type at 10 go back to 5. The
--      append-only guard is lifted for the one UPDATE, as 0084 did.
--
-- `SET search_path` is re-declared: CREATE OR REPLACE reassigns every
-- function property, so leaving it out would strip 0124's hardening.
--
-- Numbered 0316, journal idx 317, `when` 1798544900000 — strictly after
-- 0315's 1798544800000 (a duplicate `when` makes db:migrate a silent no-op).
--
-- Rollback: re-run 0257's function body and
--   UPDATE audit_log SET retention_years = 10
--    WHERE event_type = 'member_acknowledged_broadcasts_terms'
--      AND retention_years = 5;
-- (with audit_log_no_update disabled around it).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()
RETURNS TRIGGER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Tax-document events promoted to 10y per Thai RD §87/3 + §86/10 + GDPR
  -- Art. 6(1)(c) legal-obligation retention basis.
  IF NEW.event_type IN (
    -- Original 6 types (migration 0055):
    'invoice_issued',
    'invoice_paid',
    'invoice_voided',
    'credit_note_issued',
    'invoice_pdf_resent',
    'invoice_pdf_regenerated',
    -- Added migration 0063:
    'receipt_pdf_resent',
    'credit_note_pdf_resent',
    'receipt_rendered',
    -- (0084's `member_acknowledged_broadcasts_terms` removed by 0316 — it is
    -- a sender terms acknowledgement, not a consent record; 5y F7 default.)
    -- 066 §6 — post-termination payment forensic. Explains a §86/4 receipt
    -- minted to a terminated non-member; tax-evidence class, so 10y like
    -- its receipt peer.
    'payment_on_terminated_member'
  ) AND NEW.retention_years < 10 THEN
    NEW.retention_years = 10;
  END IF;

  -- F7 broadcast_* events, the E-Blast terms acknowledgement and other
  -- non-tax events deliberately fall through with the column DEFAULT 5
  -- (Constitution v1.4.0). See migration 0069 for the F7 taxonomy note.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;--> statement-breakpoint

UPDATE audit_log
   SET retention_years = 5
 WHERE event_type = 'member_acknowledged_broadcasts_terms'
   AND retention_years = 10;--> statement-breakpoint

ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
