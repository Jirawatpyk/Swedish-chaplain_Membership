-- Migration 0079 — F7 US5 notification_type enum extension.
--
-- Adds `broadcast_delivered_notification` for the FR-028 + AS3
-- transactional summary email enqueued at the `sending → sent`
-- transition (both webhook-driven completion and 24h reconciliation
-- paths). Mirrors the idempotent ADD VALUE pattern from 0073.
-- Re-running this migration is a no-op.

DO $$ BEGIN
  ALTER TYPE "notification_type" ADD VALUE 'broadcast_delivered_notification';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
