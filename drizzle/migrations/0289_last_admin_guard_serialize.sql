-- 016 post-ship review fix (2026-08-14) — serialize users_last_admin_guard().
--
-- WHY: the 0288 guard does a plain COUNT with no lock. Two concurrent
-- sessions each removing one of the last two active super_admins both pass:
-- under READ COMMITTED each trigger's COUNT excludes its own OLD.id and
-- cannot see the other session's uncommitted UPDATE (classic write-skew —
-- the trigger takes no lock, and the app pre-flights issue independent
-- autocommit UPDATEs on two DIFFERENT rows, so row locks never conflict).
-- Both commit → zero active super_admins → permanent tenant lockout
-- (nobody holds users.manage; recovery requires direct DB access). SC-003.
--
-- FIX: take a transaction-scoped advisory lock BEFORE the COUNT, only on
-- the qualifying path (removal of an active super_admin — a rare admin
-- operation, so the serialization cost is nil). Concurrent removals now
-- queue; the second acquires the lock after the first COMMITs, its COUNT
-- runs on a fresh READ COMMITTED snapshot that sees the committed removal,
-- reads zero remaining, and refuses. Same-transaction re-acquisition is a
-- no-op (advisory xact locks are re-entrant), so multi-removal flows
-- (erase cascades) cannot self-deadlock.
--
-- Key namespace: 'auth:' — disjoint from F4 'invoicing:', F5 'payments:',
-- F7 'broadcasts:' (all use hashtextextended with a module prefix).
--
-- Three properties preserved VERBATIM from 0286/0288 —
-- `isLastAdminTriggerError` matches on the pair, and 0004 fixed a
-- silent-delete class:
--   - ERRCODE '23514'
--   - the substring 'last-admin-protection' in the message
--   - BEFORE DELETE returns OLD (returning NEW/NULL cancels the delete
--     with no error and zero rows affected — the 0004 incident)

CREATE OR REPLACE FUNCTION users_last_admin_guard()
  RETURNS trigger AS $$
DECLARE
  remaining_admins integer;
BEGIN
  -- Strict population: a tenant must never be left with zero active
  -- super_admin rows. Plain admins are not counted — they hold no
  -- administrative capability post-cutover.
  IF (TG_OP = 'UPDATE'
      AND OLD.role = 'super_admin' AND OLD.status = 'active'
      AND (NEW.role <> 'super_admin' OR NEW.status <> 'active'))
  OR (TG_OP = 'DELETE'
      AND OLD.role = 'super_admin' AND OLD.status = 'active') THEN

    -- Serialize concurrent qualifying removals (write-skew guard).
    -- MUST precede the COUNT: the lock is what guarantees the COUNT
    -- sees every previously committed removal.
    PERFORM pg_advisory_xact_lock(hashtextextended('auth:last_admin_guard', 0));

    SELECT COUNT(*) INTO remaining_admins
      FROM users
      WHERE role = 'super_admin'
        AND status = 'active'
        AND id <> OLD.id;

    IF remaining_admins = 0 THEN
      RAISE EXCEPTION
        'last-admin-protection: refusing to leave zero active admins '
        '(security.md T-10, FR-011)'
        USING ERRCODE = '23514';  -- check_violation
    END IF;
  END IF;

  -- Return the correct row-image for the operation type:
  --   UPDATE → NEW (commit the proposed new state)
  --   DELETE → OLD (commit the deletion; NULL cancels silently)
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
