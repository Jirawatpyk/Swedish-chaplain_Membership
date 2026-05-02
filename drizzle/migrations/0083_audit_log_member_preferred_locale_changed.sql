-- Migration 0083 — F3 audit_event_type extension for the
-- preferred_locale write path (admin UI + member self-service portal).
--
-- Per Constitution Principle I append-only audit clause: every state
-- change to a member field MUST emit an audit row. The
-- `preferred_locale` column added in 0082 only had a read path until
-- now; this migration adds the audit event for the new write path.
--
-- Idempotent — re-runs are no-ops.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'member_preferred_locale_changed'
  ) THEN
    ALTER TYPE audit_event_type
      ADD VALUE 'member_preferred_locale_changed';
  END IF;
END$$;
