-- Migration 0023 — Add F4 notification type for invoice auto-email.
--
-- The existing F1+F3 `notifications_outbox.notification_type` enum only
-- carried auth-related values. F4 auto-emails are a distinct category
-- (paid benefit delivery, per spec FR-024). Rather than reshape the F3
-- outbox, we add ONE F4 notification_type and let the dispatcher use
-- `context_data.event_type` ∈ { 'invoice_issued', 'invoice_paid',
-- 'invoice_voided', 'credit_note_issued', 'invoice_pdf_resent',
-- 'receipt_pdf_resent', 'credit_note_pdf_resent' } to pick the correct
-- @react-email template at dispatch time.

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'invoice_auto_email';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
