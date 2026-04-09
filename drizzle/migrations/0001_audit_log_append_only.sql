-- T024: Append-only enforcement for audit_log (data-model.md § 7.1, security.md T-13).
--
-- The data-model originally describes role-based grants (REVOKE UPDATE, DELETE
-- ON audit_log FROM swecham_app_rw). On Neon, however, the application
-- connects as the project owner role and we cannot easily provision a
-- separate restricted role per environment without bespoke deployment
-- tooling.
--
-- Instead we enforce append-only at the DB layer with a BEFORE UPDATE /
-- BEFORE DELETE trigger that raises an exception. This:
--   - Works for ALL connections regardless of role.
--   - Cannot be bypassed by application code (the trigger fires inside
--     the same transaction, so the rollback is mandatory).
--   - Is independently testable (tests/integration/audit/append-only.test.ts
--     attempts UPDATE/DELETE and asserts the exception fires — T026).
--
-- The application layer (src/modules/auth/infrastructure/db/audit-repo.ts,
-- T067) still exposes only an `append()` method as a second guard.
--
-- A future hardening pass MAY also add role-based grants if Neon adds
-- first-class multi-role support per project — until then this trigger
-- is the canonical enforcement point.

CREATE OR REPLACE FUNCTION audit_log_immutable()
  RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % denied (security.md T-13)', TG_OP
    USING ERRCODE = '42501';  -- insufficient_privilege
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_immutable();

-- TRUNCATE bypasses BEFORE DELETE row-level triggers, so guard separately.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit_log_immutable();

COMMENT ON TABLE audit_log IS
  'F1 compliance audit trail. Append-only via audit_log_immutable() trigger. '
  '5-year retention (Constitution VIII). NEVER drop the triggers without '
  'a documented compliance review.';
