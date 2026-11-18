-- ---------------------------------------------------------------------------
-- #717 (PR #794) — `member_erasure_repeated` audit event type.
--
-- A repeat erase of a member whose erasure already COMPLETED (a
-- `member_erased` row exists) re-runs the scrub and every cascade, so data
-- that came back after completion is cleared, but writes no second
-- `member_erased`. This row is the repeat request's durable record (actor,
-- request id, the new attestation), kept apart from `member_erasure_requested`
-- so the Art. 12 clock is not restarted. 5y retention (F3 default).
--
-- Safe before the code deploys: an unused enum value. Idempotent DO block,
-- the 0014 pattern. Rollback: none needed (an enum value cannot be dropped;
-- the old code never writes it).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_erasure_repeated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_erasure_repeated';
  END IF;
END$$;
