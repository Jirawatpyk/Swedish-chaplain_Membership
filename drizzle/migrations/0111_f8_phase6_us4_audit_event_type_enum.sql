-- ---------------------------------------------------------------------------
-- F8 Phase 6 Wave F · T175 — extend audit_event_type pgEnum (6 new values
-- for User Story 4: At-Risk Member Detection).
--
-- New event types — emit sites (Phase 6 task IDs in parentheses):
--
--   1. `at_risk_score_recomputed`            (T154 — per-member score recompute)
--   2. `at_risk_score_threshold_crossed`     (T154 — band crossed UP per FR-031)
--   3. `at_risk_snoozed`                     (T155 — admin snooze 7|30|90 per FR-032)
--   4. `at_risk_outreach_recorded`           (T156 — admin OR manager outreach per FR-033 + FR-052a)
--   5. `at_risk_skipped_below_min_tenure`    (T154 — FR-035 min-tenure gate)
--   6. `at_risk_compute_partial_failure`     (T161 — per-tenant cron aggregate failure)
--
-- All 6 events are already in the F8_AUDIT_EVENT_TYPES const tuple (line
-- 87-92 of `src/modules/renewals/application/ports/renewal-audit-emitter.ts`,
-- count 59 unchanged). This migration adds the matching pgEnum values to the
-- DB so the Drizzle audit emitter (`drizzle-renewal-audit-emitter.ts` line
-- 67 F8_ENUM_SHIPPED set) can persist them via INSERT instead of falling
-- through to pino-logging.
--
-- Postgres requirement: ALTER TYPE ADD VALUE cannot run inside a
-- transaction. Drizzle's migration runner uses the
-- "statement-breakpoint" separator so each ALTER lands as its own
-- statement (idempotent via IF NOT EXISTS, safe to re-run on
-- partial-rollback or migration replay).
--
-- Source of truth: spec.md FR-029 + FR-031 + FR-032 + FR-033 + FR-035 +
-- contracts/audit-port.md lines 43-48 (6 at-risk events) +
-- specs/011-renewal-reminders/contracts/audit-port.md § AtRiskScoreRecomputed
-- through AtRiskComputePartialFailure (lines 292-328).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'at_risk_score_recomputed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'at_risk_score_threshold_crossed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'at_risk_snoozed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'at_risk_outreach_recorded';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'at_risk_skipped_below_min_tenure';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'at_risk_compute_partial_failure';--> statement-breakpoint
