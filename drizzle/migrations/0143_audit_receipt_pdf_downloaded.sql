-- Add `receipt_pdf_downloaded` audit event type.
-- Emitted by `getReceiptPdfSignedUrl` after a successful ownership check
-- + signed-URL issuance — captures every admin/manager/member
-- receipt-PDF read. Tax-document touch class → 10-year retention per
-- Thai RD §87/3.
--
-- Payload shape:
--   { invoice_id, member_id, receipt_document_number_raw,
--     actor_role, route: 'get-receipt-pdf-signed-url' }
--
-- `receipt_document_number_raw` is null for combined-mode invoices
-- (receipt PDF is the invoice PDF; reuses invoice document number).

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'receipt_pdf_downloaded';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
