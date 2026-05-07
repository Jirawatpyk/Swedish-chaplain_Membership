-- ---------------------------------------------------------------------------
-- F8 Phase 5 Wave A · T116-T138 — extend audit_event_type pgEnum (21 new
-- values for User Story 3: Member Self-Service Renewal Flow).
--
-- The TypeScript const `F8_AUDIT_EVENT_TYPES` in
-- `src/modules/renewals/application/ports/renewal-audit-emitter.ts` is
-- updated alongside this migration to expand the compile-asserted count
-- from 55 → 59 (4 new events added to the tuple) AND to add the 17
-- pre-existing-in-tuple events to `F8_ENUM_SHIPPED` so the Drizzle
-- adapter actually persists them instead of falling through to pino.
--
-- New event types — emit sites (Phase 5 task IDs in parentheses):
--
--   ── Renewal lifecycle (already in tuple — 17) ───
--   1. `renewal_cycle_created`              (T123 — F4 onPaidCallback creating next cycle)
--   2. `renewal_cycle_price_frozen`         (T122 — confirm-renewal plan-change branch FR-021b)
--   3. `renewal_self_service_initiated`     (T120 — successful token verify)
--   4. `renewal_invoice_created`            (T122 — F4 invoice issued via barrel)
--   5. `renewal_with_plan_change`           (T122 — plan-change branch)
--   6. `renewal_payment_failed`             (T123 — F4 onPaidCallback failure path)
--   7. `renewal_completed`                  (T123 — happy path cycle complete)
--   8. `renewal_completed_post_lapse`       (T123 — auto-reactivate path FR-005b)
--   9. `renewal_token_invalid`              (T120 — 6 reject reasons per FR-027)
--  10. `renewal_kill_switch_blocked`        (T125, T130, T132, T133b — proxy + page guard)
--  11. `renewal_cross_member_probe`         (T125, T130 — URL [memberId] vs session mismatch)
--
--   ── Lapsed-member admin actions (already in tuple — 6) ───
--  12. `lapsed_member_action_blocked`       (T133 — lapsed-portal-scope helper)
--  13. `lapsed_member_admin_reactivated`    (T136 — admin approves pending)
--  14. `lapsed_member_admin_reactivation_rejected`  (T137 — admin rejects + refund)
--  15. `lapsed_member_admin_reactivation_timed_out` (T138 — 30d auto-cancel + refund)
--  16. `member_auto_reactivation_blocked`   (T135 — admin sets blocked flag)
--  17. `member_auto_reactivation_unblocked` (T135 — admin clears blocked flag)
--
--   ── NEW Phase 5 additions to tuple (4 — count 55→59) ───
--  18. `renewal_token_clicked_on_completed_cycle`    (T120 — race window per spec § Edge Cases CHK033)
--  19. `lapsed_member_admin_reactivation_reminder_t-7` (T138 — pending ladder day 23)
--  20. `lapsed_member_admin_reactivation_reminder_t-3` (T138 — pending ladder day 27)
--  21. `lapsed_member_admin_reactivation_reminder_t-1` (T138 — pending ladder day 29)
--
-- Postgres requirement: `ALTER TYPE … ADD VALUE` cannot run inside a
-- transaction. Drizzle's migration runner respects `--> statement-breakpoint`
-- so each ALTER lands as its own statement (idempotent via `IF NOT EXISTS`,
-- safe to re-run on partial-rollback or migration replay).
--
-- Source of truth: research.md R1 + spec.md §§ FR-005a-d, FR-016, FR-021,
-- FR-022-25, FR-027, FR-052, audit-port.md taxonomy line 365 (58→59 with
-- token-clicked-on-completed-cycle).
-- ---------------------------------------------------------------------------

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_created';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_price_frozen';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_self_service_initiated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_invoice_created';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_with_plan_change';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_payment_failed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_completed';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_completed_post_lapse';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_token_invalid';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_kill_switch_blocked';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cross_member_probe';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_action_blocked';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_admin_reactivated';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_admin_reactivation_rejected';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_admin_reactivation_timed_out';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_auto_reactivation_blocked';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'member_auto_reactivation_unblocked';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_token_clicked_on_completed_cycle';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_admin_reactivation_reminder_t-7';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_admin_reactivation_reminder_t-3';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'lapsed_member_admin_reactivation_reminder_t-1';--> statement-breakpoint
