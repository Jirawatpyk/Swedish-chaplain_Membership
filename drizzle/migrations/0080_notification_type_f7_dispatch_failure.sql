-- Migration 0080 — F7 US6 notification_type enum extension.
--
-- Adds `broadcast_failed_to_dispatch_notification` for the FR-021 / AS2
-- transactional notification enqueued when a scheduled broadcast
-- exhausts its 1-hour retry budget against Resend (cron handler reaches
-- `now() - scheduled_for > 1h` while still hitting retryable failures).
-- Members are informed by email that their scheduled send did not go
-- out, the quota reservation remains held, and they can re-trigger or
-- re-schedule manually.
--
-- Mirrors the idempotent ADD VALUE pattern from 0079 + 0073.
-- Re-running this migration is a no-op.

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'broadcast_failed_to_dispatch_notification';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
