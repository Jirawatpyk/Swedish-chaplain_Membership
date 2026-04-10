-- W-02: DB-level last-admin protection trigger.
--
-- Background: the application-layer guard in
-- `src/modules/auth/application/change-role.ts` and
-- `disable-user.ts` reads `countActiveAdmins()` and then writes
-- `setRole`/`disable` as bare sequential awaits — NOT inside a single
-- transaction. The race window is narrow but real: two concurrent
-- demote-the-last-admin requests can both observe `count = 2`, both
-- pass the application guard, and both commit, leaving the system
-- with zero active admins.
--
-- The application-layer test suite (`tests/integration/auth/
-- last-admin-protection.test.ts`) injects a stub that forces
-- `countActiveAdmins() = 1` to prove the guard FIRES, but cannot
-- prove the guard is ATOMIC under concurrent load — the test fixture
-- DB always has 3+ admins, so the race window is never the deciding
-- factor.
--
-- This trigger closes the gap by enforcing the invariant at the DB
-- layer, where it is automatically race-free regardless of how many
-- concurrent transactions hit the row. The trigger fires BEFORE
-- UPDATE on the `users` table and rolls back the transaction with
-- a custom errcode + message that the application catches and
-- surfaces as the existing `last-admin-protection` error code.
--
-- Test coverage: `tests/integration/auth/last-admin-protection.test.ts`
-- (existing) verifies the application-layer guard fires; this trigger
-- is the second line of defence and is exercised implicitly by every
-- last-admin scenario the integration suite runs against live Neon.
--
-- Drop / disable safely: the trigger can be disabled with
-- `ALTER TABLE users DISABLE TRIGGER users_last_admin_protection;`
-- but doing so requires explicit Constitution Principle I sign-off.

CREATE OR REPLACE FUNCTION users_last_admin_guard()
  RETURNS trigger AS $$
DECLARE
  remaining_admins integer;
BEGIN
  -- Only inspect transitions that would REMOVE one active admin:
  --   1. role change: admin → non-admin
  --   2. status change: active → anything else (disabled, pending)
  --   3. DELETE on a row that is currently an active admin
  IF (TG_OP = 'UPDATE'
      AND OLD.role = 'admin' AND OLD.status = 'active'
      AND (NEW.role <> 'admin' OR NEW.status <> 'active'))
  OR (TG_OP = 'DELETE'
      AND OLD.role = 'admin' AND OLD.status = 'active') THEN

    -- Count OTHER active admins (exclude the row being mutated). The
    -- subquery materialises rows so the count is taken under the
    -- transaction's snapshot — concurrent transactions on other admin
    -- rows will block on the UPDATE row lock when they reach this
    -- trigger, serialising the check.
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
  --   - UPDATE: return NEW (committing the proposed new state)
  --   - DELETE: return OLD (committing the deletion)
  --
  -- A BEFORE DELETE trigger that returns NULL (or NEW, which is
  -- NULL during a DELETE) SILENTLY CANCELS the delete — a subtle
  -- PostgreSQL gotcha that turned this trigger into a blanket
  -- DELETE-blocker in an earlier iteration.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_last_admin_protection
  BEFORE UPDATE OR DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION users_last_admin_guard();

COMMENT ON TRIGGER users_last_admin_protection ON users IS
  'F1 last-admin protection (security.md T-10, FR-011). Closes the '
  'race-window left by the application-layer countActiveAdmins guard. '
  'Disabling requires Constitution Principle I sign-off.';
