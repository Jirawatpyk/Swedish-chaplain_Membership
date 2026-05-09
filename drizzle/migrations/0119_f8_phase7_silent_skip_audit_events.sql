-- ---------------------------------------------------------------------------
-- F8 Phase 7 review-fix Round 1 — extend audit_event_type pgEnum with 3 new
-- silent-skip audit events surfaced by the verify-fix close round.
--
-- New event types:
--
--   1. `tier_upgrade_pending_member_notify_skipped` (review-fix I-ERR-1) —
--      emitted when admin Accept commits the suggestion transition but the
--      member has no primary contact email (deleted, not yet onboarded, or
--      `dispatchCandidateRepo.findOne` returns null). FR-039 step 2 audit
--      obligation surfaced; admin can re-notify after onboarding the contact.
--
--   2. `tier_upgrade_pending_member_notify_failed` (review-fix I-ERR-2) —
--      emitted when `RenewalGateway.sendTierUpgradeApprovalEmail` returns err
--      after the 3-retry budget (gateway_5xx exhausted) OR throws an
--      exception in the post-tx path. Mirrors F7 broadcast `_failed` audit
--      precedent so admin queue can flag retry candidates.
--
--   3. `renewal_schedule_reschedule_skipped` (review-fix S-2-errors) —
--      emitted when the reschedule-on-plan-change listener's
--      `loadPlanFrozenFields` returns `not_found` for either old or new
--      plan, so the `renewal_schedule_rescheduled` audit cannot fire.
--      Forensic chain explicit instead of silent skip.
--
-- All 3 events are 5-year retention (no F4 tax-document overlap).
--
-- Postgres requirement: ALTER TYPE ADD VALUE cannot run inside a
-- transaction. Drizzle's migration runner uses the
-- "statement-breakpoint" separator so each ALTER lands as its own
-- statement (idempotent via IF NOT EXISTS).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_pending_member_notify_skipped';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'tier_upgrade_pending_member_notify_failed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_schedule_reschedule_skipped';
