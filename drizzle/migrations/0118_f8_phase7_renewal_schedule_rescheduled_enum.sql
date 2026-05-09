-- ---------------------------------------------------------------------------
-- F8 Phase 7 T188a fix (verify-finding C2) — extend audit_event_type pgEnum
-- with `renewal_schedule_rescheduled` so the F2 → F8 plan-change listener
-- (Phase 7 T188a `rescheduleOnPlanChangeInTx`) can persist its diff audit
-- instead of falling through to pino-logging.
--
-- Emit site: `src/modules/renewals/application/use-cases/reschedule-on-plan-change.ts`
-- Listener: `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts`
-- F3-side wire: `src/modules/members/application/use-cases/change-plan.ts`
--
-- Per spec.md Edge Cases line 182: when an admin manually changes a
-- member's plan via F2 mid-cycle and the new plan's tier-bucket differs
-- from the old, F8 emits this audit row capturing the cancelled vs new
-- step ids so dashboards can attribute reminder-cadence shifts to the
-- mid-cycle plan flip.
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_schedule_rescheduled';
