-- T166-07 — async receipt PDF render notification type.
--
-- Adds the new `receipt_pdf_render` value to the `notification_type`
-- Postgres enum so `record-payment.ts` (when
-- `FEATURE_F5_ASYNC_RECEIPT_PDF=true`) can enqueue an outbox row with
-- this notification_type, and the cron dispatcher can route it to
-- `renderReceiptPdf` under `runInTenant(payload.tenantId)` (instead
-- of the buildPayload/Resend email path).
--
-- Idempotent (re-runs are no-ops).

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'receipt_pdf_render';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
