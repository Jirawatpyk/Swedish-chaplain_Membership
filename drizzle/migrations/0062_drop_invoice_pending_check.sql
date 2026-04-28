-- review-20260428-102639.md W12 reversal — drop the CHECK constraint
-- added in 0061. The constraint enforced
-- `receipt_pdf_status='pending' → receipt_document_number_raw IS NOT NULL`
-- without distinguishing separate-mode vs combined-mode.
--
-- Problem: combined-mode invoices LEGITIMATELY have
-- `receipt_document_number_raw=null` (receipt IS the invoice; no
-- separate sequence) and can transit `receipt_pdf_status='pending'`
-- while the async worker renders. The CHECK can't see
-- `tenant_invoice_settings.receipt_numbering_mode` (different table),
-- so we cannot scope the constraint to separate-mode at SQL layer.
--
-- Application-layer guard at `render-receipt-pdf.ts:168-177` (S8 closure
-- — `kind: 'data_corruption'`) is the canonical safety net. It throws
-- with a permanent-failure marker that short-circuits the dispatcher
-- retry ladder for separate-mode rows missing receiptDocumentNumberRaw.
--
-- Empirical evidence: T166-12 perf benchmark at n=100 caught this
-- regression (combined-mode seed rows fail the CHECK).

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_pending_has_receipt_doc_num;
