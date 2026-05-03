-- Migration 0085 — F7 R6 staff-review audit_event_type extension.
--
-- Adds 2 new audit event types per R6 staff-review (commit 28cc851):
--
-- 1. `broadcast_delivery_recorded` (R6 B1)
--    Per-recipient delivery confirmation from Resend webhook
--    `email.delivered` events. Pre-R6 this path incorrectly emitted
--    `broadcast_send_started` (the dispatch use-case's send-init
--    event), polluting the audit trail and the SLO-F7-005 metric
--    cardinality. R6 split semantics — see process-webhook-event.ts:
--    256.
--
-- 2. `broadcast_subject_empty` (R6 W-R3)
--    Distinct event type for whitespace-only subject rejection at
--    submit boundary. Pre-R6 this path emitted
--    `broadcast_subject_too_long` with payload `{length:0}` while the
--    Result returned `broadcast_subject_empty` — audit and on-wire
--    error code diverged for the same rejection. R6 aligned the two
--    surfaces — see submit-broadcast.ts:350.
--
-- R9 staff-review caught the gap: TS-side `F7_AUDIT_EVENT_TYPES`
-- (count 43, compile-time-asserted in audit-port.ts:109) included
-- both events post-R6, but the corresponding Postgres enum
-- `audit_event_type` migration was never authored. Live Neon had
-- both values applied out-of-band so integration tests passed; a
-- fresh DB deploy would fail with `invalid input value for enum
-- audit_event_type` on first emit.
--
-- Mirrors the idempotent ADD VALUE pattern from 0072 + 0076 + 0079 +
-- 0080 + 0081. Re-running this migration is a no-op.
--
-- All F7 events default to 5-year retention via the
-- `audit_log_retention_default_trigger_fn` function (no F4 tax-doc
-- overlap). No retention column update needed here — the trigger
-- handles the default at INSERT time for every F7 event type
-- including these two.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'broadcast_delivery_recorded'
  ) THEN
    ALTER TYPE audit_event_type
      ADD VALUE 'broadcast_delivery_recorded';
  END IF;
END$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'broadcast_subject_empty'
  ) THEN
    ALTER TYPE audit_event_type
      ADD VALUE 'broadcast_subject_empty';
  END IF;
END$$;
