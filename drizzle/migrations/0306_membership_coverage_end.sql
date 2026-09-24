-- ---------------------------------------------------------------------------
-- Migration 0306 — end membership coverage on a refund / full credit note.
--
-- A full refund (or a full manual credit note) of a membership invoice could
-- not actually end the member's coverage. Paying a renewal bill moves its
-- cycle to `completed` (terminal — `cancel-cycle` refuses it) and opens the
-- next cycle at the old period end; a plain `cancelled` close honours paid-
-- through access until `expires_at`. So the member stayed Active for the
-- refunded period whichever cycle staff cancelled.
--
-- 1. `renewal_cycles.closed_reason += 'coverage_ended'` — a cancellation that
--    ENDS access immediately (`deriveMembershipAccess` → terminated regardless
--    of `expires_at`), written only by `endMembershipCoverageNow`.
--
-- 2. `renewal_cycles.end_coverage_*` — a durable "end this member's coverage"
--    request on their OPEN cycle, converged by the hourly reconcile cron:
--      * refund-backed (refund_id + invoice_id set): end only once the F5
--        refund SETTLES `succeeded`; a `failed` settle clears the request and
--        the member keeps coverage (no money came back);
--      * plain (refund_id NULL): a retry of an end that failed inline.
--    Nullable, no CHECK — advisory/forensic like the 0243 reject marker, and
--    left set on the resulting cancelled row for forensics. `refund_id` is
--    TEXT (F5 ids are `rfnd_<ulid>`); `actor_user_id` is TEXT (free-form
--    actor id threaded through the audit context).
--
-- 3. `refunds.membership_effect` — the staff's declared intent for a refund
--    of a membership invoice ('keep' | 'cancel_membership', F4's vocabulary),
--    pinned at initiation so the webhook / sweep finaliser can hand it to the
--    credit-note bridge when an async refund settles. NULL = not declared
--    (pre-0305 rows, partial refunds, event invoices, the F8 reject bridge).
--
-- Additive only. The CHECK drop/re-add validates existing rows, none of which
-- carry the new literal; renewal_cycles is small (one active row per member).
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
        'pending_reactivation_timed_out',
        'coverage_ended'
      )
    );
--> statement-breakpoint

COMMENT ON CONSTRAINT "renewal_cycles_closed_reason_check" ON "renewal_cycles" IS
  '0305: + coverage_ended (refund / full credit note ended access immediately; plain cancelled keeps paid-through access)';
--> statement-breakpoint

ALTER TABLE "renewal_cycles"
  ADD COLUMN "end_coverage_requested_at" timestamp with time zone,
  ADD COLUMN "end_coverage_refund_id" text,
  ADD COLUMN "end_coverage_invoice_id" uuid,
  ADD COLUMN "end_coverage_actor_user_id" text;
--> statement-breakpoint

-- The hourly reconcile scans only the (rare) requested rows.
CREATE INDEX IF NOT EXISTS "renewal_cycles_end_coverage_requested_idx"
  ON "renewal_cycles" ("tenant_id")
  WHERE "end_coverage_requested_at" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "refunds"
  ADD COLUMN "membership_effect" text;
--> statement-breakpoint

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_membership_effect_check"
    CHECK ("membership_effect" IS NULL OR "membership_effect" IN ('keep', 'cancel_membership'));
--> statement-breakpoint

-- 4. `credit_notes.membership_effect` — the staff's Keep / End membership
--    intent on a FULL membership credit ('keep' | 'cancel_membership'),
--    written in the credit note's own tx. With `refunds.membership_effect`
--    it is the DURABLE record the renewals reconcile backstop re-reads when a
--    route's post-commit "end membership" call was lost. NULL on partial /
--    event credits and pre-0305 rows.
ALTER TABLE "credit_notes"
  ADD COLUMN "membership_effect" text;
--> statement-breakpoint

ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_membership_effect_check"
    CHECK ("membership_effect" IS NULL OR "membership_effect" IN ('keep', 'cancel_membership'));
--> statement-breakpoint

-- The backstop reads only recent End decisions — a tiny partial index.
CREATE INDEX IF NOT EXISTS "credit_notes_membership_end_idx"
  ON "credit_notes" ("tenant_id", "created_at")
  WHERE "membership_effect" = 'cancel_membership';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "refunds_membership_end_idx"
  ON "refunds" ("tenant_id", "initiated_at")
  WHERE "membership_effect" = 'cancel_membership';
