-- 016-rbac-permissions Migration B (T023) — denial audit event + transitional
-- last-admin guard.
--
-- TWO independent changes that must land together because the second one is
-- what makes the cutover survivable and the first one is what makes it
-- observable:
--
--   1. `audit_event_type += 'permission_denied'` — every denied staff surface
--      writes one row through `src/lib/rbac.ts`, on BOTH flag legs.
--
--   2. `users_last_admin_guard()` population widened from `role = 'admin'` to
--      `role IN ('admin', 'super_admin')`.
--
-- Why the UNION population, and why now (D13):
--
--   Migration C promotes human admins to `super_admin`. Under the current
--   admin-only guard the promotion of the LAST admin would either be refused
--   (it leaves zero active admins) or, once promoted, the tenant would have
--   zero rows the guard protects — a subsequent demotion could leave the
--   tenant with nobody able to administer it and no error raised. Counting
--   both roles keeps protection continuous across the transition in both
--   directions. PR 5 narrows the population to `super_admin` alone (T069)
--   once no plain admin holds administrative capability any more.
--
-- Three properties this file MUST preserve verbatim — `isLastAdminTriggerError`
-- matches on the pair, and 0004 fixed a silent-delete class:
--   - ERRCODE '23514'
--   - the substring 'last-admin-protection' in the message
--   - BEFORE DELETE returns OLD (returning NEW/NULL cancels the delete with
--     no error and zero rows affected — the 0004 incident)
--
-- Enum note: the runner replays this file once in an autocommit phase and once
-- transactionally within the SAME deploy, so `ADD VALUE` must be idempotent.
-- `IF NOT EXISTS` is mandatory; a bare ADD VALUE aborts the first deploy.

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'permission_denied';

CREATE OR REPLACE FUNCTION users_last_admin_guard()
  RETURNS trigger AS $$
DECLARE
  remaining_admins integer;
BEGIN
  -- Transitional guarded set: a tenant must never be left with zero active
  -- rows across BOTH administrative roles.
  IF (TG_OP = 'UPDATE'
      AND OLD.role IN ('admin', 'super_admin') AND OLD.status = 'active'
      AND (NEW.role NOT IN ('admin', 'super_admin') OR NEW.status <> 'active'))
  OR (TG_OP = 'DELETE'
      AND OLD.role IN ('admin', 'super_admin') AND OLD.status = 'active') THEN

    SELECT COUNT(*) INTO remaining_admins
      FROM users
      WHERE role IN ('admin', 'super_admin')
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
