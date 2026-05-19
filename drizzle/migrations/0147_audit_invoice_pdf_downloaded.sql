-- Add `invoice_pdf_downloaded` audit event type (R8-M1-code).
-- Emitted by `getInvoicePdfSignedUrl` after a successful ownership check
-- + signed-URL issuance — captures every admin/manager/member invoice-
-- PDF read. Tax-document touch class → 10-year retention per Thai RD
-- §86/4 + §87/3 (same retention as `invoice_pdf_resent` and peer
-- receipt events).
--
-- Payload shape:
--   { invoice_id, member_id, actor_member_id (member-actor only),
--     invoice_pdf_template_version, actor_role,
--     route: 'get-invoice-pdf-signed-url' }
--
-- Closes the audit-coverage asymmetry flagged in R8 review: receipts
-- emit `receipt_pdf_downloaded` on success, invoices previously had
-- no equivalent on the success path (only the cross-tenant probe
-- emitted on denial).

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'invoice_pdf_downloaded';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
