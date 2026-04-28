-- review-20260428-102639.md W12 closure — additional CHECK constraint
-- to enforce the T166 separate-mode async-pending invariant at DB layer.
--
-- Existing CHECK `invoices_paid_has_receipt_status` (0056 L52-56)
-- enforces: status='paid' → receipt_pdf_status IS NOT NULL.
-- This ensures: paid + status='pending' → receipt_document_number_raw
-- IS NOT NULL OR receipt_pdf_status IS NULL (combined-mode bypass).
--
-- combined-mode tenants → receipt IS the invoice; receipt_pdf_status
-- is set to 'rendered' synchronously and receipt_document_number_raw
-- stays NULL. The OR clause makes this combined-mode commit legal.
--
-- separate-mode async-pending → receipt_pdf_status='pending' MUST
-- carry the pre-allocated receipt number, otherwise the worker hits
-- the defensive guard in render-receipt-pdf.ts:168 as a permanent
-- failure (a §87 spent-number-without-PDF concern).

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_pending_has_receipt_doc_num;
--> statement-breakpoint

ALTER TABLE invoices
  ADD CONSTRAINT invoices_pending_has_receipt_doc_num
  CHECK (
    -- Allow any state where pending receipt is not in flight.
    receipt_pdf_status IS NULL
    OR receipt_pdf_status <> 'pending'
    -- Combined-mode commits status='pending' transiently? No —
    -- combined-mode is sync only and never lands at status='pending'.
    -- So if status='pending', the doc number MUST be allocated.
    OR receipt_document_number_raw IS NOT NULL
  );
