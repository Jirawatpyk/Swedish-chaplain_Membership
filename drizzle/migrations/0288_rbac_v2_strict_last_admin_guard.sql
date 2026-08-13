-- 016-rbac-permissions Migration D (T069, PR 5) — STRICT last-admin guard.
--
-- Narrows `users_last_admin_guard()`'s protected population from the 0286
-- transitional union (`role IN ('admin', 'super_admin')`) to `super_admin`
-- alone. The union existed for exactly one reason: Migration C promotes human
-- admins, and during that window protection had to be continuous in both
-- directions (D13). The cutover completed 2026-08-11 and PR 4 removed the last
-- legacy-leg consumers, so a plain `admin` no longer holds administrative
-- capability (`users.manage` is super-admin-only) — counting one as "an
-- administrator the tenant cannot lose" would let the LAST super_admin be
-- demoted or disabled while only capability-less admins remain, after which
-- nobody can administer the tenant and nobody can fix that (SC-003).
--
-- Mirrors `administrativeRoles()` in `src/modules/auth/domain/role.ts`, which
-- PR 5 narrows in the same change — the app-layer pre-flights
-- (change-role / disable-user / erase-user) and this trigger must agree on the
-- population or one of them lies.
--
-- Three properties preserved VERBATIM from 0286 — `isLastAdminTriggerError`
-- matches on the pair, and 0004 fixed a silent-delete class:
--   - ERRCODE '23514'
--   - the substring 'last-admin-protection' in the message
--   - BEFORE DELETE returns OLD (returning NEW/NULL cancels the delete with
--     no error and zero rows affected — the 0004 incident)

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
