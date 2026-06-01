-- ---------------------------------------------------------------------------
-- go-live /code-review #12-13 — add `account_creation_compensated` audit event.
--
-- The F3 `invitePortal` SAGA compensation (added with this change) deletes a
-- just-created pending user when the downstream contact-link step fails after
-- F1 `createUser` already committed (no orphan: see invite-portal.ts). The
-- compensating DELETE on the global `users` identity table is auditable, so we
-- append `account_creation_compensated` referencing the deleted user — the
-- append-only `account_created` row stays (Principle VIII), and this row records
-- the undo so an auditor never sees a created-but-never-existing account.
--
-- Idempotent DO block — same pattern as 0014_audit_event_portal_invite_queued.sql.
-- DO-block enum-value additions do NOT change schema.ts-inferred structure, so
-- `drizzle-kit generate` produces no snapshot JSON; the `_journal.json` entry +
-- this SQL file are sufficient for replay (drift covered by the live-Neon
-- integration suite).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'account_creation_compensated'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'account_creation_compensated';
  END IF;
END$$;
