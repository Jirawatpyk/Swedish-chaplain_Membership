-- 0318 — 124-invoice-dashboard slice 2: indexes for the Collected figures.
--
-- The invoice dashboard (/admin/finance, spec 124 D-b) sums Collected on the
-- document basis per period:
--   + invoices in paid | partially_credited | credited by their §78/1 tax point
--   − credit notes by issue_date
--   − waived refunds (status = 'succeeded') by completed_at
-- None of the three date predicates had an index. Probed read-only on the dev
-- branch (22 Oct 2026): `timezone(text, timestamptz)` is IMMUTABLE and a trial
-- index on the exact tax-point expression builds; credit_notes has no
-- (tenant_id, issue_date) index and refunds no (tenant_id, completed_at) one.
--
-- 1. invoices_tenant_tax_point_paid_idx — an EXPRESSION index on the tax
--    point. The expression is character-identical to `invoiceTaxPointSql`
--    (src/modules/invoicing/infrastructure/db/invoice-tax-point.ts), which the
--    register, its CSV export and the dashboard all read; Postgres uses an
--    expression index only when the query's expression matches.
--    tests/unit/invoicing/invoice-tax-point-migration-guard.test.ts fails if
--    the two drift. Partial on the paid family, the only rows with a tax point
--    the dashboard sums.
-- 2. credit_notes_tenant_issue_date_idx — (tenant_id, issue_date).
-- 3. refunds_tenant_completed_succeeded_idx — (tenant_id, completed_at),
--    partial on status = 'succeeded' (pending and failed rows are never
--    subtracted).
--
-- Indexes only: no rows change. Safe before the code that uses them deploys
-- (the register's plan can only gain an option). Unflagged on deploy.
--
-- Plain CREATE INDEX (not CONCURRENTLY), per the 0021 / 0305 precedent: the
-- migration runner wraps the pending batch in one transaction. The tables are
-- small (hundreds to low thousands of rows per tenant), so the SHARE lock is
-- brief; lock_timeout makes a deploy that meets a long transaction abort and
-- retry instead of queueing every invoice write behind it. SET LOCAL lives to
-- the end of the batch, so the default is handed back as the LAST statement.
--
-- Rollback: DROP INDEX IF EXISTS invoices_tenant_tax_point_paid_idx,
-- credit_notes_tenant_issue_date_idx, refunds_tenant_completed_succeeded_idx;
-- every reader still works without them, only slower.
--
-- Numbered 0318, journal idx 319, `when` 1798545100000 — strictly after
-- 0317's 1798545000000 (a duplicate `when` makes db:migrate a silent no-op).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "invoices_tenant_tax_point_paid_idx"
  ON "invoices" ("tenant_id", (COALESCE("payment_date", ("paid_at" AT TIME ZONE 'Asia/Bangkok')::date)))
  WHERE "status" IN ('paid', 'partially_credited', 'credited');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "credit_notes_tenant_issue_date_idx"
  ON "credit_notes" ("tenant_id", "issue_date");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refunds_tenant_completed_succeeded_idx"
  ON "refunds" ("tenant_id", "completed_at")
  WHERE "status" = 'succeeded';--> statement-breakpoint

SET LOCAL lock_timeout = DEFAULT;
