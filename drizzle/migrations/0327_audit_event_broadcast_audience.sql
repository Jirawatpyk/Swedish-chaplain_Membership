-- ---------------------------------------------------------------------------
-- Migration 0327 — `audit_event_type += 'broadcast_audience_disclosed',
-- 'broadcast_audience_deleted'` (spec 139 slice 2, DA4).
--
-- The import leg hands a recipient list to Resend (a Contacts Import into a
-- per-broadcast segment) and later deletes that segment. Neither left an
-- Art. 30 record. These two rows are that record, written BEFORE each call
-- (a function killed after the call must not be able to erase it), so each
-- row records a request, not its outcome. Ids and a count only; no address
-- and no hash. 5 y retention (the F7 default).
--
-- Safe before the code that emits them: two unused enum values. Idempotent
-- DO blocks, as 0014 / 0324. An enum value cannot be dropped: the rollback is
-- a forward-fix that stops emitting them.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_audience_disclosed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_audience_disclosed';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'broadcast_audience_deleted'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'broadcast_audience_deleted';
  END IF;
END$$;
