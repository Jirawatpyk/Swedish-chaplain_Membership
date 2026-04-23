-- ---------------------------------------------------------------------------
-- F5 — audit_log.retention_years + F4 tax-document backfill
-- (T025 per specs/009-online-payment/tasks.md).
--
-- **R2-E4 Review-Gate blocker** (Constitution Principle VIII + Thai RD
-- §87/3 + GDPR Art. 6(1)(c)). Without the backfill, existing F4 audit
-- rows covering tax-document events would be silently downgraded from
-- indefinite-by-absence to 5-year retention and F9's future purge job
-- would prematurely delete the statutory tax-trail. **MUST be atomic**.
--
-- Source: specs/009-online-payment/data-model.md § 7.1 + § 7.2.
--
-- The 6 backfilled event types match F4 migration 0020 (ADD VALUE) +
-- 0030 (invoice_pdf_regenerated) exactly — verified 2026-04-23 Main-
-- agent Gate. Verify again if F4 migrations 0020/0030 are rewritten.
--
-- Atomicity: drizzle-kit wraps each migration file in an implicit
-- transaction when applying. A single failure → rollback → no partial
-- state. The CHECK constraint is added before any UPDATE fires so
-- pre-existing rows with retention_years=5 (default) satisfy it.
-- ---------------------------------------------------------------------------

-- Step 1: add column with safe DEFAULT 5.
-- NOT NULL + DEFAULT means every existing row gets 5 at migration time;
-- no need for a second UPDATE to populate baseline values.
ALTER TABLE "audit_log"
  ADD COLUMN "retention_years" smallint NOT NULL DEFAULT 5;--> statement-breakpoint

-- Step 2: CHECK constraint.
-- Current permitted values: 5 (standard) and 10 (tax-document). Future
-- features may widen the CHECK via a subsequent migration.
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_retention_years_chk"
  CHECK ("retention_years" IN (5, 10));--> statement-breakpoint

-- Step 3: BACKFILL F4 tax-document event types to 10-year retention.
-- Without this, existing F4 rows stay at 5 years and F9 would prematurely
-- delete them before Thai RD §87/3's statutory minimum — a compliance
-- regression F5 would silently introduce. The 6 event types are:
--   - invoice_issued           (Thai RD §87/3 — tax document creation)
--   - invoice_paid             (receipt PDF generation — RD §87/3)
--   - invoice_voided           (VOID-stamped PDF — RD §87/3)
--   - credit_note_issued       (ใบลดหนี้ — RD §86/10)
--   - invoice_pdf_resent       (delivery audit trail — RD §87/3)
--   - invoice_pdf_regenerated  (re-render audit — RD §87/3)
--
-- `audit_log_no_update` trigger (migration 0001) blocks ALL UPDATEs to
-- enforce append-only semantics (security.md T-13). Here we TEMPORARILY
-- disable it for this single migration's retention backfill — the
-- content of the audit rows is NOT changed (payload / event_type /
-- actor / timestamp remain intact); only the new retention_years flag
-- is set. The disable + UPDATE + re-enable all run inside the same
-- implicit transaction that drizzle-migrator opens; a failure anywhere
-- rolls back the disable too, restoring the trigger atomically.
ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_no_update";--> statement-breakpoint

UPDATE "audit_log"
   SET "retention_years" = 10
 WHERE "event_type" IN (
   'invoice_issued',
   'invoice_paid',
   'invoice_voided',
   'credit_note_issued',
   'invoice_pdf_resent',
   'invoice_pdf_regenerated'
 );--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_no_update";--> statement-breakpoint
