-- Fix W-02 trigger: BEFORE DELETE must RETURN OLD, not NEW.
--
-- Postgres gotcha: a BEFORE DELETE row-level trigger that returns
-- NULL (or NEW, which is NULL during a DELETE) silently cancels
-- the delete — no error, no rows affected. The initial 0003
-- migration had `RETURN NEW` as the only return statement, so
-- every DELETE on `users` became a silent no-op. This only
-- surfaced when the integration test cleanup started mass-deleting
-- stale `test-*` rows during E2E triage and observed zero rows
-- affected.
--
-- This migration replaces the function with the corrected
-- return-row logic. The trigger definitions themselves are
-- unchanged — we only swap the underlying function body.

CREATE OR REPLACE FUNCTION users_last_admin_guard()
  RETURNS trigger AS $$
DECLARE
  remaining_admins integer;
BEGIN
  IF (TG_OP = 'UPDATE'
      AND OLD.role = 'admin' AND OLD.status = 'active'
      AND (NEW.role <> 'admin' OR NEW.status <> 'active'))
  OR (TG_OP = 'DELETE'
      AND OLD.role = 'admin' AND OLD.status = 'active') THEN

    SELECT COUNT(*) INTO remaining_admins
      FROM users
      WHERE role = 'admin'
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
