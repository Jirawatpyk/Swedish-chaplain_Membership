-- ---------------------------------------------------------------------------
-- Round-3 review N-I3 — add dedicated `member_portal_invite_queued` audit
-- event type.
--
-- Prior impl reused the generic `member_updated` event type for bulk
-- send_portal_invite actions. This made security monitoring unable to
-- distinguish portal-invite queueing from general field updates.
-- Dedicated event type enables accurate audit queries + alerts.
--
-- Idempotent DO block — same pattern as 0010_audit_log_f3_extension.sql.
--
-- SS-4 convention note: DO-block enum-value additions do NOT change
-- `schema.ts`-inferred structure, so `drizzle-kit generate` produces no
-- snapshot JSON for them. This mirrors 0002 / 0003 / 0004 / 0010 which
-- are also snapshot-less by design. The `_journal.json` entry + this SQL
-- file are sufficient for migration replay — drift verification is
-- covered by the live-Neon integration suite (`tests/integration/
-- members/migration-schema.test.ts`).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'member_portal_invite_queued'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'member_portal_invite_queued';
  END IF;
END$$;
