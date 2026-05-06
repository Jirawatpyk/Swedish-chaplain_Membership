-- ---------------------------------------------------------------------------
-- F8 Phase 4 / T115a — extend `renewal_cycles.closed_reason` CHECK with
-- two more specific lapse reasons:
--
--   * `'grace_expired'` — `now > expires_at + grace_period_days` and
--     the member never made a payment attempt (or all attempts remained
--     pending/processing). Distinguishable from the catch-all
--     `'lapsed'` so admins can spot pure-no-action lapses.
--   * `'payment_failed'` — at least one F5 payment attempt failed
--     permanently before the grace window ended (chargeback, declined
--     card, fraud-block, etc.). Distinguishable so admins can route
--     to outreach with the right framing.
--
-- The legacy `'lapsed'` literal stays in the CHECK as a backward-compat
-- catch-all — rows written before the lapse-decision branch ships in
-- Phase 5 (T138 cycle-state-reconciler) keep using it. The admin UI
-- (lapsed-tab.tsx badge) already renders `'lapsed'` as "Grace expired"
-- so users see a sensible label until the dispatcher writes the more
-- specific reason.
--
-- This migration is purely additive: drops + recreates the CHECK with
-- the two new literals appended. Zero data migration needed (no rows
-- have these values yet — only the dispatcher will write them, and it
-- still writes `'lapsed'` until Phase 5 wires the decision branch).
-- ---------------------------------------------------------------------------

ALTER TABLE "renewal_cycles"
  DROP CONSTRAINT IF EXISTS "renewal_cycles_closed_reason_check";
--> statement-breakpoint

ALTER TABLE "renewal_cycles"
  ADD CONSTRAINT "renewal_cycles_closed_reason_check"
    CHECK (
      "closed_reason" IS NULL
      OR "closed_reason" IN (
        'paid',
        'cancelled',
        'lapsed',
        'grace_expired',
        'payment_failed',
        'completed_offline',
        'admin_reactivated',
        'admin_rejected_with_refund',
        'pending_reactivation_timed_out'
      )
    );
--> statement-breakpoint

COMMENT ON CONSTRAINT "renewal_cycles_closed_reason_check" ON "renewal_cycles" IS
  'F8 T115a: catch-all `lapsed` + specific `grace_expired`/`payment_failed` (specific reasons land in writes when Phase 5 cycle-state-reconciler ships)';
