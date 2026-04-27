-- ---------------------------------------------------------------------------
-- F5 Phase 9 / T135 fix — re-backfill audit_log.retention_years for F4 rows
-- inserted between migration 0039 apply time and the F4 audit-emitter fix
-- (audit-adapter.ts now sets retention_years explicitly per
-- F4_AUDIT_RETENTION_YEARS map, data-model 009 § 7.2).
--
-- **Root cause** (caught by tests/integration/payments/audit-retention-backfill.test.ts):
--   Migration 0039 added the column with DEFAULT 5 + backfilled the 6 F4
--   tax-document event types ONCE. New F4 audit emissions after 0039 ran
--   used the un-fixed adapter that did NOT include retention_years in the
--   INSERT — so each new row landed at DB DEFAULT 5 instead of the spec's
--   10-year requirement (Thai RD §87/3 + GDPR Art. 6(1)(c)).
--
-- **Fix scope**:
--   1. The 6 F4 tax-document event types backfilled in 0039 — need
--      re-backfill for any rows inserted between 0039 and this migration.
--   2. Same atomicity pattern as 0039 (DISABLE TRIGGER + UPDATE +
--      ENABLE TRIGGER inside the migrator's implicit transaction).
--
-- **Why this is safe**:
--   - The UPDATE only flips retention_years 5→10 for rows whose event_type
--     is in the canonical tax-document list. Idempotent — re-running picks
--     up zero new rows since the F4 adapter now sets it correctly on insert.
--   - audit_log content (event_type, actor, payload, summary, timestamp) is
--     untouched. Append-only invariant preserved (only the retention flag changes).
--   - Single transaction → all-or-nothing. A failure rolls back the trigger
--     disable too, leaving audit_log_no_update intact.
--
-- **Forward guarantee**: F4 audit-adapter (`audit-adapter.ts`) and overdue-
-- audit-adapter now set retention_years explicitly. Future F4 emissions will
-- carry the correct retention from creation, no further backfill needed.
-- F1+F2+F3 audit emitters (`auth/infrastructure/db/audit-repo.ts`) do not
-- touch tax-document event types — their DEFAULT 5 fallback is correct per
-- data-model 009 § 7.2 mapping.
-- ---------------------------------------------------------------------------

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
 )
   AND "retention_years" = 5;--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE TRIGGER "audit_log_no_update";--> statement-breakpoint
