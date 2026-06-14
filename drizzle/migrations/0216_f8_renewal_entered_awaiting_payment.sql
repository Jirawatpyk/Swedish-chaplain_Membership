-- ---------------------------------------------------------------------------
-- Migration 0215 — audit_event_type extension: renewal_entered_awaiting_payment
--
-- F8-completion slice 2 — the T-0 expiry cron (enter-awaiting-payment-on-
-- expiry) + the lazy confirm-renewal self-transition (slice 2.5) flip a
-- cycle `upcoming|reminded` → `awaiting_payment`. This new audit event
-- records that flip with a `source: 'cron' | 'confirm'` discriminator so
-- the member timeline shows which writer made the cycle payable.
--
-- MUST be a separate migration because Postgres forbids
-- ALTER TYPE … ADD VALUE inside the same transaction as code that uses
-- the new value. Precedent: 0010 (F3), 0043/0046 (F5), 0095/0099/0210 (F8/F3).
--
-- Idempotency: DO block guards with pg_enum/pg_type existence check —
-- same pattern as every preceding enum-extension migration in this repo
-- (first established in 0010_audit_log_f3_extension.sql). Additive +
-- idempotent → safe to apply on the shared Neon even though main's code
-- does not yet reference the value.
--
-- Retention: 5 years (F8 default via F8_AUDIT_RETENTION_YEARS — no action
-- required here; audit_log.retention_years default trigger handles it).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'renewal_entered_awaiting_payment'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'renewal_entered_awaiting_payment';
  END IF;
END$$;
