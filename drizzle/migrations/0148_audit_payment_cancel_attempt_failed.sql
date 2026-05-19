-- Add `payment_cancel_attempt_failed` audit event type (F5R1-E4).
-- Emitted by `cancelPayment` when Stripe-side cancelPaymentIntent
-- returns a non-OK Result (network outage, idempotency conflict,
-- permanent SDK error). Forensic ambiguity fix: pre-fix the failure
-- branch reused `payment_canceled` (with `payload.outcome:
-- 'stripe_error'` discriminator), so audit-log aggregations that
-- filter `event_type='payment_canceled'` over-counted cancel
-- successes when Stripe failures were the actual outcome.
--
-- Payload shape:
--   { payment_id, invoice_id, actor_type, outcome: 'stripe_error',
--     processor_error_kind, processor_error_reason? }
--
-- Retention: 5y (operational class — cancel-attempt-failed is not
-- a tax-document touch).

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'payment_cancel_attempt_failed';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
