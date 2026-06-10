-- 064-event-invoice-paid-flow (Task 10, review Finding 2) — receipt-number
-- uniqueness backstop.
--
-- receipt_document_number_raw now carries §87 RECEIPT-stream numbers from TWO
-- writers: recordPayment (separate-mode, sync + async pre-allocation) and
-- issueEventInvoiceAsPaid (no-TIN β, since Task 10). The invoice stream has
-- invoices_tenant_fiscal_seq_unique as its duplicate backstop, but the
-- receipt stream had NONE — a §87 allocator regression (or a manual write)
-- could silently mint the same receipt number twice within a tenant.
--
-- Partial UNIQUE index on (tenant_id, receipt_document_number_raw): NULL rows
-- (drafts, combined-mode receipts that reuse the invoice number) stay outside
-- the index. Per-tenant scope — different tenants legitimately share raws
-- (each runs its own numbering). The pre-apply duplicate probe on the live DB
-- (2026-06-10) found 8 raw-bearing rows and ZERO duplicate pairs, so the
-- CREATE-time validation scan cannot fail.
--
-- IF NOT EXISTS keeps the migration idempotent (re-run lands the same state).

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_tenant_receipt_raw_uniq"
  ON "invoices" (tenant_id, receipt_document_number_raw)
  WHERE receipt_document_number_raw IS NOT NULL;
