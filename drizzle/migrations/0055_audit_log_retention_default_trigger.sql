-- ---------------------------------------------------------------------------
-- F5 R2 review (2026-04-27) — Auto-default retention_years=10 on INSERT for
-- F4 tax-document event types.
--
-- Background: migration 0039 added `audit_log.retention_years SMALLINT NOT
-- NULL DEFAULT 5` and back-filled the 6 F4 tax-document types to 10. The
-- F4 audit adapter at `src/modules/invoicing/infrastructure/adapters/
-- audit-adapter.ts` was updated (T135) to pass retention_years=10 for
-- those types on every NEW insert. However, direct SQL inserts from
-- integration test fixtures + seed scripts STILL fall through to the DB
-- DEFAULT 5, polluting live Neon's audit_log + tripping the
-- audit-retention-backfill compliance test on every CI run.
--
-- This trigger is the data-layer guarantee: ANY insert (adapter, raw SQL,
-- or psql) that lands one of the 6 F4 tax-document event types is
-- automatically promoted to retention_years=10. Application-layer
-- explicit retention_years=10 is now redundant but kept for clarity.
--
-- Compliance: Thai RD §87/3 (tax-document 5y minimum, we use 10y) +
-- GDPR Art. 6(1)(c) (legal-obligation retention basis).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type IN (
    'invoice_issued',
    'invoice_paid',
    'invoice_voided',
    'credit_note_issued',
    'invoice_pdf_resent',
    'invoice_pdf_regenerated'
  ) AND NEW.retention_years < 10 THEN
    NEW.retention_years = 10;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_retention_default_for_f4_tax_docs ON audit_log;
CREATE TRIGGER audit_log_retention_default_for_f4_tax_docs
  BEFORE INSERT ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_default_retention_for_f4_tax_docs();

-- Re-flip any rows already at 5 from past test runs (idempotent — safe to re-run).
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;
UPDATE audit_log
   SET retention_years = 10
 WHERE event_type IN (
       'invoice_issued',
       'invoice_paid',
       'invoice_voided',
       'credit_note_issued',
       'invoice_pdf_resent',
       'invoice_pdf_regenerated'
     )
   AND retention_years = 5;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
