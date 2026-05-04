-- ---------------------------------------------------------------------------
-- F8 Phase 4 Wave I2c — extend audit_event_type pgEnum with the 8
-- dispatch-related events emitted by `dispatchOneCycle` (T088 +
-- T089 shared core).
--
-- Per the H1 audit-emitter convention "co-ship enum + emit site",
-- these enum values land alongside their first concrete emit sites
-- in the dispatcher:
--
--   * `renewal_reminder_sent` — happy-path dispatch emit when the
--     gateway returns a delivery_id (FR-010 + FR-011 idempotent dispatch).
--   * `renewal_reminder_skipped` — single skip event with structured
--     payload `{reason}` covering all 8 FR-012 reasons + FR-019a
--     `no_primary_contact` + FR-033 `outreach_in_progress`.
--   * `renewal_reminder_send_failed` — transient gateway failure
--     (5xx, retryable). Wave I2d's FR-010a retry budget will
--     subsequently emit `renewal_reminder_retried` per attempt.
--   * `renewal_reminder_send_failed_permanent` — non-retryable
--     gateway failure (4xx invalid recipient, validation error).
--   * `renewal_reminder_retried` — emitted by the FR-010a retry
--     budget logic in Wave I2d (enum lands now to keep migrations
--     batched and to avoid a separate ADD VALUE migration later).
--   * `renewal_reminder_deferred_read_only` — distinct event when
--     `READ_ONLY_MODE=true` blocks dispatch; preserves auditability
--     per FR-012 + Constitution Principle VIII.
--   * `renewal_skipped_no_joined_at` — defensive emit when a member
--     has NULL registration_date (data-quality regression).
--   * `escalation_task_created` — emitted by `dispatchOneCycle`
--     when (a) the schedule step is `channel='task'` (creates an
--     escalation task per cycle), or (b) the FR-019a graceful skip
--     creates a `manual_outreach_required` task on missing primary
--     contact. Same enum value, two emit sites — payload `task_type`
--     disambiguates.
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction with other DDL — these 8 statements ship in this single
-- migration file (sequential after 0102 escalation_task_completed).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_reminder_sent';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_reminder_skipped';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_reminder_send_failed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_reminder_send_failed_permanent';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_reminder_retried';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_reminder_deferred_read_only';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_skipped_no_joined_at';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'escalation_task_created';--> statement-breakpoint
