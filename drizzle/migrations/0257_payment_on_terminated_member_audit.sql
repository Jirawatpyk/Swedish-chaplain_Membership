-- ---------------------------------------------------------------------------
-- 066-renewal-swecham-round2 §4.4(2)/§6 — `payment_on_terminated_member`
-- audit event + 10-year retention.
--
-- The event is the forensic trail for an anomalous §86/4 receipt: under
-- FEATURE_088_TAX_AT_PAYMENT a receipt is minted at payment even when the
-- member is terminated (the rare webhook-race path the pre-charge gate
-- cannot catch — design §4.5). It is tax-evidence class, same rationale as
-- the F4 tax-document events already promoted to 10y (Thai RD §87/3 + GDPR
-- Art. 6(1)(c) legal-obligation basis), so it JOINS the retention trigger's
-- IN() list rather than inheriting the 5y column default.
--
-- Lockstep registration (all updated in this commit — the audit-event
-- "four-places" pattern + retention + i18n label + count tests):
--   src/modules/renewals/application/ports/renewal-audit-emitter.ts
--     F8_AUDIT_EVENT_TYPES tuple (69→70) + _AssertF8AuditEventCount + payload
--   src/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter.ts
--     F8_ENUM_SHIPPED_TUPLE (emit sites ship in the same branch, Task 9)
--   src/modules/auth/infrastructure/db/schema.ts DB_ONLY_AUDIT_EVENT_TYPES
--   scripts/lib/enum-migration-guard.ts REQUIRED_ENUM_VALUES
--   src/i18n/messages/{en,th,sv}.json audit.eventType label
--     (audit-event-label-coverage.test.ts parses THIS migration file)
--   tests/unit/renewals/application/ports.test.ts (69→70)
--   tests/contract/renewals-audit-port.contract.test.ts (69→70 + payload)
--
-- The ALTER TYPE is applied by run-migrations.ts's autocommit enum pre-pass
-- (idempotent via IF NOT EXISTS) before the transactional migrate that
-- re-creates the trigger function (whose body only references the value as
-- a runtime-cast string literal — safe within the same migration).
-- ---------------------------------------------------------------------------
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'payment_on_terminated_member';--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_log_default_retention_for_f4_tax_docs()
RETURNS TRIGGER AS $$
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
    -- 066 §6 — post-termination payment forensic. Explains a §86/4 receipt
    -- minted to a terminated non-member; tax-evidence class, so 10y like
    -- its receipt peer.
    'payment_on_terminated_member'
  ) AND NEW.retention_years < 10 THEN
    NEW.retention_years = 10;
  END IF;

  -- F7 broadcast_* events + other non-tax events deliberately fall through
  -- with the column DEFAULT 5 (Constitution v1.4.0). See migration 0069 for
  -- the full F7 taxonomy note.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
