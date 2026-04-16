-- ---------------------------------------------------------------------------
-- Fix — add missing audit_event_type enum value `email_verification_consumed`.
--
-- Migration 0010_audit_log_f3_extension.sql was intended to add all 23 F3
-- audit event types but accidentally omitted `email_verification_consumed`.
-- The TypeScript enum in src/modules/auth/infrastructure/db/schema.ts and
-- the F3AuditEventType union referenced this value, so F3 US3.b tests
-- were failing at runtime with:
--
--   PostgresError: invalid input value for enum audit_event_type:
--   "email_verification_consumed"
--
-- This migration adds the missing value idempotently — safe to re-run.
--
-- SS-4 convention note: DO-block enum-value additions do NOT change
-- `schema.ts`-inferred structure, so no drizzle snapshot is generated.
-- Same convention as 0010 / 0014 (also snapshot-less by design).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'email_verification_consumed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'email_verification_consumed';
  END IF;
END$$;
