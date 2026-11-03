-- ---------------------------------------------------------------------------
-- Migration 0324 — `audit_event_type += 'credit_note_issue_replayed'` (#67).
--
-- #66 / mig 0323 made an admin credit note idempotent: a repeat of an issue
-- attempt (the same `idempotency_key`) is answered with the note already
-- issued and wrote nothing. Thai-tax review M-2 on PR #728: the audit trail
-- then cannot show that staff asked again and were given the existing §86/10
-- note. The replay now writes one row of this type (ids only, 10 y retention,
-- set by the emitter from `F4_AUDIT_RETENTION_YEARS`).
--
-- Safe before the code that emits it: an unused enum value. Idempotent DO
-- block, as 0014. An enum value cannot be dropped: the rollback is a
-- forward-fix that stops emitting it.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'credit_note_issue_replayed'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'credit_note_issue_replayed';
  END IF;
END$$;
