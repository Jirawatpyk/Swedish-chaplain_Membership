-- F7.1-IMP5 / Round-5 R5-CRIT-1 — extend audit_event_type enum with
-- `broadcast_resend_audience_drift`. This event was added to
-- F7_AUDIT_EVENT_TYPES (audit-port.ts) during round-4 zero-defer batch
-- but the corresponding ALTER TYPE was missed — first emit would
-- otherwise fail with `invalid input value for enum audit_event_type`.
--
-- Idempotent (matches migration 0072 pattern).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'broadcast_resend_audience_drift'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_resend_audience_drift';
  END IF;
END$$;

-- Future drift-check unverifiable event (R5-S1) — emitted when
-- `getAudienceContactCount` fails on a non-404 error during
-- idempotency-replay verification. Forensic record so ops can
-- investigate "we replayed but couldn't confirm recipient count".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'broadcast_resend_drift_check_unverifiable'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_resend_drift_check_unverifiable';
  END IF;
END$$;
