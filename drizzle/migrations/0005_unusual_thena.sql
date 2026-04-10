-- Drizzle-kit generated this migration to add the
-- `password_reset_failed` enum value to `audit_event_type`.
-- However, that value was ALREADY added in hand-written migration
-- 0002 (`ALTER TYPE audit_event_type ADD VALUE IF NOT EXISTS
-- 'password_reset_failed'`). Drizzle-kit regenerated it because
-- 0002 was a hand-edit without an accompanying snapshot file — so
-- the kit's drift detector saw the enum value in `schema.ts`
-- without a matching snapshot entry.
--
-- To keep this migration idempotent + schema-snapshot continuity
-- intact, we replace the generated ALTER TYPE with an explicit
-- no-op gated by `IF NOT EXISTS`. Postgres 9.6+ accepts this form
-- and silently skips when the value already exists.
--
-- `0005_snapshot.json` is retained unchanged so future
-- `drizzle-kit generate` invocations diff against the correct
-- baseline (the live schema state).

ALTER TYPE "public"."audit_event_type" ADD VALUE IF NOT EXISTS 'password_reset_failed';
