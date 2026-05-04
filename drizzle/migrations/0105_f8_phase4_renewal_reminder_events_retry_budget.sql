-- ---------------------------------------------------------------------------
-- F8 Phase 4 Wave I2e — FR-010a retry budget columns on
-- `renewal_reminder_events`.
--
-- Adds two nullable columns:
--
--   * `retry_until TIMESTAMPTZ` — set by the dispatcher (T088) on
--     transient gateway failures to `dispatched_at + 24 hours`.
--     `retry-failed-reminders` use-case (Wave I2e) lists events where
--     `status='failed' AND retry_until > NOW()` for re-attempt and
--     events where `status='failed' AND retry_until <= NOW() AND
--     retry_exhausted_at IS NULL` for permanent-escalation marking.
--     NULL means: (a) the event is not in failed status, OR (b) it
--     was a permanent failure (4xx/recipient_unsubscribed) at first
--     attempt — never eligible for retry.
--
--   * `retry_exhausted_at TIMESTAMPTZ` — set by the retry use-case
--     when it transitions a row to permanent failure after the 24h
--     window expires. The presence of this timestamp is the
--     idempotency primitive for the "emit-permanent-audit-once"
--     contract: a row with `retry_exhausted_at IS NOT NULL` has
--     already had `renewal_reminder_send_failed_permanent` emitted
--     and a `manual_outreach_required` task created.
--
-- Both columns are NULLABLE — backfilling for the ~0 in-flight failed
-- rows (F8 ships dark behind FEATURE_F8_RENEWALS=false until F9) is
-- a no-op. New failure rows from Wave I2e dispatcher write retry_until
-- inline.
--
-- Index: partial index on `(tenant_id, retry_until)` WHERE
-- `status='failed' AND retry_until IS NOT NULL` so the retry-eligible
-- query is index-served at scale.
-- ---------------------------------------------------------------------------

ALTER TABLE "renewal_reminder_events"
  ADD COLUMN "retry_until" TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE "renewal_reminder_events"
  ADD COLUMN "retry_exhausted_at" TIMESTAMPTZ;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "renewal_reminder_events_retry_eligible_idx"
  ON "renewal_reminder_events" ("tenant_id", "retry_until")
  WHERE "status" = 'failed' AND "retry_until" IS NOT NULL;
--> statement-breakpoint

COMMENT ON COLUMN "renewal_reminder_events"."retry_until" IS
  'F8 FR-010a retry budget — dispatched_at + 24h for transient failures; NULL for non-failed or permanent';
--> statement-breakpoint

COMMENT ON COLUMN "renewal_reminder_events"."retry_exhausted_at" IS
  'F8 FR-010a — set when retry use-case transitions to permanent failure (idempotency primitive for permanent-audit emission)';
