-- ---------------------------------------------------------------------------
-- 016-rbac-permissions — Migration A: `role` enum extension (2 values).
--
-- Adds `super_admin` and `marketing` to the `role` pgEnum (spec FR-001).
-- Shared by `users.role` AND `invitations.intended_role` — one enum, both
-- columns widen at once.
--
-- Pattern: `ALTER TYPE … ADD VALUE IF NOT EXISTS`. The IF NOT EXISTS form is
-- REQUIRED — the runner's autocommit enum pre-pass
-- (scripts/run-migrations.ts) re-executes every `ALTER TYPE … ADD VALUE`
-- from ALL migration files on every deploy; a bare ADD VALUE would fail the
-- second deploy (round-3 R3-M1). Forward-only: enum values cannot be removed.
--
-- Ships in lockstep (SAME commit) with:
--   - `roleEnum` tuple  (src/modules/auth/infrastructure/db/schema.ts) — tuple
--     order MUST match the live label order (appended after the base three)
--   - `ROLES`           (src/modules/auth/domain/role.ts)
--   - `REQUIRED_ENUM_VALUES.role` (scripts/lib/enum-migration-guard.ts) — the
--     Phase-3 fail-loud assertion, primary guard against the silent-no-op class
--
-- DARK: no row holds the new values until the operator pre-mints the
-- verification super_admin (D18 runbook step) and Migration C promotes admins.
-- This migration is purely additive and safe to deploy ahead of the flag flip.
-- ---------------------------------------------------------------------------

ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'super_admin';
ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'marketing';
