-- ---------------------------------------------------------------------------
-- F8 Phase 4 Wave I1a — extend audit_event_type pgEnum with the
-- `renewal_schedule_policy_updated` lifecycle event.
--
-- Per the H1 audit-emitter convention "co-ship enum + emit site",
-- this enum value lands alongside the first concrete emit site:
--
--   * `renewal_schedule_policy_updated` — emitted by the
--     `updateSchedulePolicy` use-case (T082) when an admin saves a
--     change to a tenant's per-tier-bucket reminder schedule from the
--     /admin/renewals/settings/schedules editor (T086/T087). Payload
--     carries `{tier_bucket, change_diff, actor_user_id}` per
--     data-model.md § 4.
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction with other DDL — this single statement ships in its own
-- migration file (sequential after 0100 Phase 3 lapsed-tier index).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_schedule_policy_updated';--> statement-breakpoint
