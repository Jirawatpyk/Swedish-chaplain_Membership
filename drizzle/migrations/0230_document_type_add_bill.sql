-- 088-invoice-tax-flow-redesign — the feature's enum-add migration (T005 + T009).
--
-- ── WHY A DEDICATED ENUM-ADD MIGRATION (data-model § B.1) ─────────────────────
--   `ALTER TYPE … ADD VALUE` must land in its OWN migration, committed before
--   any migration or runtime path USES the new value (`::document_type`) — PG
--   forbids using a freshly-added enum value in the same transaction that adds
--   it. So the enum extensions are isolated HERE (0230); the column + CHECK +
--   trigger changes that reference `bill` semantics live in 0231. Do NOT fold
--   these ADD VALUEs into the 0231 column/CHECK migration.
--
--   Two DIFFERENT enums are extended in this one file — both are pure ADD VALUE
--   operations, neither value is used in this migration, so they coexist safely:
--     • document_type   += 'bill'          — the non-§87 ใบแจ้งหนี้ stream (SC).
--     • document_type   += 'receipt_105'   — the SEPARATE §105 RE register for
--                                             event-without-TIN receipts (pinned
--                                             2026-07-01, keeps the RC §86/4/§87
--                                             register pure for RD audit).
--     • audit_event_type += 'tax_receipt_issued' — the §86/4 first-issuance
--                                             signal (SC-001) fired in-tx when the
--                                             RC §87 number is minted at payment.
--                                             Retention = 10y (tax-doc class);
--                                             set by the F4 audit emitter, not by
--                                             a column DEFAULT (see F4_AUDIT_RETENTION_YEARS).
--
-- Uses the plain `ADD VALUE IF NOT EXISTS` form (transactional-safe in PG16/17;
-- the proven pattern from migrations 0210/0228). A `DO $$ … EXCEPTION …` block
-- would run the ADD VALUE inside a subtransaction, which PG silently declines to
-- persist through the drizzle transactional migrator — the older DO-block enum
-- migrations were applied via separate autocommit `dev-apply-migration-*`
-- scripts, not `pnpm db:migrate`. `IF NOT EXISTS` keeps a re-apply a no-op.

ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'bill';--> statement-breakpoint

ALTER TYPE "document_type" ADD VALUE IF NOT EXISTS 'receipt_105';--> statement-breakpoint

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tax_receipt_issued';
