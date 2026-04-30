-- Migration 0073 — F7 notification_type enum extension.
--
-- F7 reuses the F1+F3+F4 `notifications_outbox` table for member-facing
-- transactional emails about broadcast lifecycle events (approved /
-- rejected / cancelled / dispatch-failed). Each event becomes a row in
-- `notifications_outbox` with `context_data.broadcastId` + locale; the
-- existing F4 cron dispatcher (`/api/cron/outbox-dispatch`) picks them
-- up and renders the appropriate template per `notification_type`.
--
-- Mirrors the idempotent ADD VALUE pattern from 0023 (F4) + 0058
-- (F4 receipt PDF render). Re-running this migration is a no-op.

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'broadcast_dispatch_pending';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'broadcast_approved_notification';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'broadcast_rejected_notification';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'broadcast_cancelled_notification';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
