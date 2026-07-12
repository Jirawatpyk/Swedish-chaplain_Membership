-- 0243 — F8-RP follow-up: durable "async reject-with-refund initiated" marker on
-- renewal_cycles. When an admin REJECTS a pending_admin_reactivation cycle WITH a
-- refund that F5 settles ASYNCHRONOUSLY (Stripe pending/requires_action), the reject
-- use-case leaves the cycle in `pending_admin_reactivation` (F8-RP added NO new
-- sub-state) and stamps these three columns. The reconcile-pending cron then detects
-- the SETTLED refund and converges the cycle → `cancelled`/`admin_rejected_with_refund`
-- (byte-identical to the SYNC reject path) instead of letting the 30-day timeout lapse
-- it. See docs/superpowers/sdd/task-f8rp-hook-report.md.
--
-- All three are NULLABLE with NO CHECK constraint: the marker is advisory/forensic and
-- is only ever set on a still-`pending_admin_reactivation` row (guarded UPDATE in the
-- repo). It is intentionally LEFT SET on the resulting `cancelled` row for forensics.
-- `reject_refund_id` is TEXT (F5 refund ids are `rfnd_<ulid>`, NOT uuid);
-- `reject_actor_user_id` is TEXT (replays the admin actor for audit parity — matches
-- the free-form actor id threaded through the audit context).
ALTER TABLE "renewal_cycles"
  ADD COLUMN "reject_refund_initiated_at" timestamp with time zone,
  ADD COLUMN "reject_refund_id" text,
  ADD COLUMN "reject_actor_user_id" text;--> statement-breakpoint
