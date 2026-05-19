-- F5R2 HIGH batch — two new audit event types added together to keep
-- the migration count down (single ALTER TYPE pass).
--
-- 1. `refund_amount_mismatch_detected` (5y operational retention)
--    Emitted by `processChargeRefunded` when the local refund row's
--    `amount_satang` exceeds Stripe's confirmed charge total. Pre-fix
--    these mismatches were bucketed under the generic
--    `out_of_band_refund_detected` event type → operators querying for
--    actual OOB refunds (admin-via-dashboard) saw amount-mismatch false
--    positives polluting the bucket. Dedicated type lets SRE alert
--    rules pivot on the genuine DB↔Stripe divergence class.
--
-- 2. `webhook_dispatch_permanent_failure` (5y operational retention)
--    Emitted by the webhook route when `process-webhook-event` returns
--    `permanence: 'permanent'` (route 200-acks Stripe to break the 72h
--    retry storm). Pre-fix the route only pino-logged + bumped a metric
--    counter — the 5y forensic compliance trail was missing because
--    pino logs roll off in 30 days. The reviewer-flagged docstring
--    promise of this event type at process-webhook-event.ts:156 is now
--    actually honoured.

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'refund_amount_mismatch_detected';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'webhook_dispatch_permanent_failure';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
