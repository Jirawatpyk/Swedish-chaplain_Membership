-- Migration 0081 — F7 US6 Phase 8 verify-fix R3 audit_event_type extension.
--
-- Adds 2 new audit event types per the post-Phase-8 verify-fix round 3:
--
-- 1. `broadcast_dispatch_idempotency_conflict_pre_send` (Errors-C1)
--    Distinct forensic marker for the rare case where two cron workers
--    raced through `createAudience` before either reached `sendBroadcast`.
--    Previously this fell into the generic `broadcast_failed_to_dispatch`
--    bucket which conflated "race" with "Resend permanent error" — making
--    triage harder.
--
-- 2. `broadcast_dispatch_failure_notif_skipped_no_email`
--    (Errors-H3) — AS2 / FR-021 contract requires the originating member
--    receive a transactional notification when scheduled dispatch
--    permanently fails. If the member's primary contact email is NULL
--    (F3 archive cascade / contact deletion), the dispatch use-case
--    skips the enqueue — but previously this was only a pino log line
--    that would roll out of retention. Now an audit row records the
--    missed notification for compliance review.
--
-- Mirrors the idempotent ADD VALUE pattern from 0072 + 0079 + 0080.
-- Re-running this migration is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'broadcast_dispatch_idempotency_conflict_pre_send'
  ) THEN
    ALTER TYPE audit_event_type
      ADD VALUE 'broadcast_dispatch_idempotency_conflict_pre_send';
  END IF;
END$$;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'audit_event_type'
      AND e.enumlabel = 'broadcast_dispatch_failure_notif_skipped_no_email'
  ) THEN
    ALTER TYPE audit_event_type
      ADD VALUE 'broadcast_dispatch_failure_notif_skipped_no_email';
  END IF;
END$$;
