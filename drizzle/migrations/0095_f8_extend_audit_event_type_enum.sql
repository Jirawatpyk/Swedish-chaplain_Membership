-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T029a — extend audit_event_type pgEnum (5 new values).
--
-- Carries over the 5 audit event types deferred from Wave B because
-- they share the same DB enum constraint and Postgres requires
-- `ALTER TYPE … ADD VALUE` to run OUTSIDE a transaction (cannot be
-- batched with table-creation DDL). This migration sequences last
-- in the Wave C base batch (after 0086-0094) so all referenced tables
-- exist when audit emit sites start firing.
--
-- New event types:
--
--   1. `member_plan_manually_changed` (T013 carry-over from Wave B):
--      F3 emits alongside `member_plan_changed` when an admin manually
--      mutates a member's plan via the change-plan use-case. F8
--      supersede listener (Phase 5+ T184) consumes ONLY this specific
--      event so it can ignore auto-applied scheduled plan changes
--      that emit only the generic event.
--
--   2-5. `plan_change_*` (G1 carry-over from Wave B verify-run):
--      F2 emits these from the scheduled-plan-change use-case
--      lifecycle. `scheduled` fires on initial schedule + on each
--      re-schedule (the supersede + insert atomic pair fires both
--      `superseded` for the prior row AND `scheduled` for the new
--      one). `applied` fires from F4's invoice-paid hook (Phase 5+).
--      `cancelled` fires from explicit admin cancel (Phase 5+).
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE IF NOT EXISTS` is
-- safe to re-run; idempotent across migration re-applies.
--
-- Source of truth: Wave B verify-run remediation T029a-c +
-- Constitution Principle VIII (Reliability — atomic state+audit).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_plan_manually_changed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'plan_change_scheduled';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'plan_change_superseded';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'plan_change_cancelled';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'plan_change_applied';--> statement-breakpoint
