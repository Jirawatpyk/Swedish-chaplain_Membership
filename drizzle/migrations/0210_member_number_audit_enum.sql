-- ---------------------------------------------------------------------------
-- Migration 0210 — audit_event_type extension: member_number_assigned
--
-- MUST be a separate migration from 0209 because Postgres forbids
-- ALTER TYPE … ADD VALUE inside the same transaction as code that uses
-- the new value. Precedent: 0010 (F3), 0043/0046 (F5), 0095/0099 (F8).
--
-- Idempotency: DO block guards with pg_enum/pg_type existence check —
-- same pattern as every preceding enum-extension migration in this repo
-- (first established in 0010_audit_log_f3_extension.sql).
--
-- Retention: 5 years (F3 default via drizzleAuditAdapter — no action
-- required here; audit_log.retention_years default trigger handles it).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'member_number_assigned'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_number_assigned';
  END IF;
END$$;
