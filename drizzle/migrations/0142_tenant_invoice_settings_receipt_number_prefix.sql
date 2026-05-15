-- ---------------------------------------------------------------------------
-- F4 — tenant_invoice_settings.receipt_number_prefix (bug fix)
--
-- Adds the missing receipt-number-prefix column used when
-- `receipt_numbering_mode = 'separate'`. The Application port,
-- use-case schema, API route, and admin form all reference this
-- field, but the underlying column was never created — every save
-- silently dropped the value at the repo boundary.
--
-- After this migration:
--   * Form save persists the value.
--   * `getForIssue` returns it.
--   * `record-payment` uses `settings.receiptNumberPrefix ?? 'RE'`
--     (already implemented at src/modules/invoicing/application/
--     use-cases/record-payment.ts:280).
--
-- Zero-downtime safe: PostgreSQL ALTER TABLE ADD COLUMN TEXT NULL is
-- instant — no row rewrite, no lock escalation.
-- Rollback: DROP COLUMN — additive, no FK breakage, no existing data
-- depends on it.
-- ---------------------------------------------------------------------------

ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN "receipt_number_prefix" text;--> statement-breakpoint
