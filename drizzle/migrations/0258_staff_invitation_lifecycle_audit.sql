-- ---------------------------------------------------------------------------
-- Staff invitation lifecycle — add three audit event types for the /admin/users
-- resend / revoke / cron-prune actions on pending invitations:
--   - invitation_reissued : admin re-sent a fresh invite to a pending user.
--   - invitation_revoked  : admin deleted a pending invite (frees the email;
--                           SET-NULLs any linked contact per FK 0009).
--   - invitation_expired  : cron pruned a pending user whose invite expired
--                           > 30 days ago.
--
-- Emitted at the ROUTE level (not inside the shared `reissueInvitation`, which
-- F3's member-resend also calls) so a member-linked resend is never double-
-- audited. 5-year default retention (append-only, Principle VIII).
--
-- Idempotent DO blocks — same pattern as 0198_account_creation_compensated_audit.
-- DO-block enum-value additions do NOT change schema.ts-inferred structure, so
-- `drizzle-kit generate` produces no snapshot JSON; the `_journal.json` entry +
-- this SQL file are sufficient for replay (drift covered by the live-Neon suite).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'invitation_reissued'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'invitation_reissued';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'invitation_revoked'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'invitation_revoked';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type' AND e.enumlabel = 'invitation_expired'
  ) THEN
    ALTER TYPE audit_event_type ADD VALUE 'invitation_expired';
  END IF;
END$$;
