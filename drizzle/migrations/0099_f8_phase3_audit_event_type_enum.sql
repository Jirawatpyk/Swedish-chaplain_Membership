-- ---------------------------------------------------------------------------
-- F8 Phase 3 Wave H5 — extend audit_event_type pgEnum with the 4 F8 cycle
-- lifecycle events emitted by Phase 3 (US1) use-cases.
--
-- Per the H1 audit-emitter convention "co-ship enum + emit site", these
-- enum values land alongside their first concrete emit sites:
--
--   1. `renewal_cycle_cancelled`        — emitted by `cancelCycle` use-case
--      (T058) when admin cancels a non-terminal cycle.
--
--   2. `renewal_cycle_completed_offline` — emitted by `markPaidOffline`
--      use-case (T059) inside the F4-bridge `onPaid` callback after the
--      cycle flips from awaiting_payment → completed.
--
--   3. `renewal_cross_tenant_probe`     — emitted by `loadCycleDetail`,
--      `cancelCycle`, `markPaidOffline` use-cases when `findById` returns
--      null (RLS-hidden cross-tenant attempt OR truly missing). Per
--      Constitution Principle I clause 4 — defensive audit on every
--      cross-tenant access attempt.
--
--   4. `f8_role_violation_blocked`      — emitted by
--      `requireRenewalAdminContext` route helper when a manager attempts
--      a write action on `/api/admin/renewals/[cycleId]/{cancel,
--      mark-paid-offline}`. Contract requirement per
--      `specs/011-renewal-reminders/contracts/admin-renewals-api.md` § 1.
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction with other DDL — these 4 statements ship in their own
-- migration file (sequential after 0098 Phase 10A RLS).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_cancelled';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_completed_offline';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cross_tenant_probe';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'f8_role_violation_blocked';--> statement-breakpoint
