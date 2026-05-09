-- ---------------------------------------------------------------------------
-- F8 Phase 7 · T179-T207 — extend audit_event_type pgEnum (11 new values for
-- User Story 5: Auto Tier-Upgrade Suggestions).
--
-- New event types — emit sites (Phase 7 task IDs in parentheses):
--
--   1. `tier_upgrade_suggested`                            (T179 — eval cron creates open suggestion)
--   2. `tier_upgrade_accepted`                             (T180 — admin Accept transitions to accepted_pending_apply)
--   3. `tier_upgrade_pending_member_notified`              (T180 — member email dispatch)
--   4. `tier_upgrade_pending_admin_verification_due`       (T180 — T-180 verify task created)
--   5. `tier_upgrade_applied_at_renewal`                   (T183 — F4 invoice-paid hook applies upgrade)
--   6. `tier_upgrade_pending_superseded_by_manual_change`  (T184 — F2 supersede listener)
--   7. `tier_upgrade_dismissed`                            (T181 — admin Dismiss with 90-day suppression)
--   8. `tier_upgrade_already_at_target`                    (T179 — eval skips when already upgraded)
--   9. `tier_upgrade_tenant_disabled`                      (T179 — eval skips tenant when auto_upgrade_enabled=false)
--  10. `tier_upgrade_skipped_no_thresholds_configured`     (T179 — eval skips tenant with no eligible plans)
--  11. `tier_upgrade_pending_orphan_detected`              (T185 — reconcile cron detects orphaned pending applications)
--
-- All 11 events are already in the F8_AUDIT_EVENT_TYPES const tuple
-- (count 59 unchanged) per Phase 2 Wave A2. This migration adds the
-- matching pgEnum values to the DB so the Drizzle audit emitter
-- (`drizzle-renewal-audit-emitter.ts` F8_ENUM_SHIPPED set) can persist
-- them via INSERT instead of falling through to pino-logging.
--
-- Postgres requirement: ALTER TYPE ADD VALUE cannot run inside a
-- transaction. Drizzle's migration runner uses the
-- "statement-breakpoint" separator so each ALTER lands as its own
-- statement (idempotent via IF NOT EXISTS, safe to re-run on
-- partial-rollback or migration replay).
--
-- Source of truth: spec.md FR-037..FR-042 + contracts/audit-port.md
-- "Tier-upgrade lifecycle" section + research.md R7 (pending state).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_suggested';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_accepted';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_pending_member_notified';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_pending_admin_verification_due';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_applied_at_renewal';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_pending_superseded_by_manual_change';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_dismissed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_already_at_target';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_tenant_disabled';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_skipped_no_thresholds_configured';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_pending_orphan_detected';--> statement-breakpoint
