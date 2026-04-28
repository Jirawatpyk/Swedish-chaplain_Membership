-- T166 R1-C1 — Persist pre-allocated receipt document number on the
-- invoice row so the async render worker can read it back instead of
-- re-allocating from `tenant_document_sequences.receipt`. Re-allocation
-- on every retry was creating gaps in the receipt sequence — a Thai
-- Revenue Code §86/§87 no-gaps violation. The column is NULL for:
--   * Combined-mode tenants (receipt reuses the invoice document number)
--   * Pre-T166 paid invoices (sync path didn't need it on the row)
--   * Drafts / issued / void invoices (no payment yet)
-- Populated only at `recordPayment` time when settings.receipt_numbering_mode='separate'.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS receipt_document_number_raw TEXT NULL;

COMMENT ON COLUMN invoices.receipt_document_number_raw IS
  'T166: pre-allocated receipt doc number (separate-mode + async path). Worker reads this instead of re-allocating to preserve §87 no-gaps invariant.';
