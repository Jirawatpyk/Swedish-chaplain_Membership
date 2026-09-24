-- ---------------------------------------------------------------------------
-- Migration 0308 — `renewal_cycles.awaiting_entered_at`: separates an EARLY
-- renewal bill from a never-paid cycle.
--
-- The problem: `deriveMembershipAccess` resolved EVERY `awaiting_payment`
-- cycle to `suspended`. Three writers move a PAID `upcoming|reminded` cycle
-- to `awaiting_payment` BEFORE its period ends, and the member lost benefit
-- access (E-Blast submit, colleague invite, the next auto-draft) for the rest
-- of the period they had already paid for:
--   - issueAutoDraftedRenewal (107): the normal case. Drafts exist only for
--     cycles that have not expired yet, so issuing one flips the cycle early.
--   - confirmRenewal: the lazy `upcoming|reminded → awaiting_payment` flip.
--   - reconcileIssuedOrphans: relinks an orphaned auto-issued bill.
-- Those rows cannot be told apart from the 065 §5.3 BORN-`awaiting_payment`
-- cohort (new member, admin lapsed-comeback). That cohort never paid, and its
-- far-future `expires_at = period_to` must NOT buy access. `anchored_at`,
-- `linked_invoice_id`, `auto_draft_invoice_id` and `created_at` were each
-- checked and none separates the two groups; see the PR for why.
--
-- The column: `transitionStatus` stamps it on `upcoming|reminded →
-- awaiting_payment` when the bill is a RENEWAL (the cycle is anchored or the
-- member has a settled predecessor, the `classifyMembershipPayment` split),
-- so the bill charges the NEXT term while the current one is paid. It clears
-- the column on every other transition into or out of `awaiting_payment`.
-- `insert` never sets it, so a born cycle stays NULL. The access rule reads
-- it only while status = 'awaiting_payment':
--   stamped AND expires_at in the future  → full
--   otherwise                             → suspended (unchanged)
-- NULL gives the pre-0308 behaviour. The column can only ever grant access
-- that a cycle's own paid period already covers.
--
-- Backfill: stamp ONLY the currently-`awaiting_payment` rows that have
-- evidence they were flipped out of `upcoming|reminded`:
--   (a) a `renewal_entered_awaiting_payment` audit row for the cycle (confirm
--       and T-0 cron flips; the cron rows have a past `expires_at`, so the
--       stamp does not change their access);
--   (b) the linked bill IS the cycle's auto-draft (issueAutoDraftedRenewal
--       emits no enter-awaiting audit; drafts exist only for
--       `upcoming|reminded` cycles, so this is a flip);
--   (c) a `renewal_orphan_invoice_relinked` audit row whose
--       `previous_cycle_status` is `upcoming|reminded`.
-- Every arm is ALSO limited to the RENEWAL cohort (the cycle is anchored,
-- or the member has a settled predecessor cycle), the same split as
-- `classifyMembershipPayment`. A `first_payment` cycle's early bill charges
-- the CURRENT period, so that period is unpaid and must stay suspended.
-- Rows with no evidence keep NULL, i.e. today's behaviour. (a) and (c) use
-- the audit timestamp. (b) has no audit row, so it uses `updated_at` as an
-- approximation; the value is a discriminator plus forensic hint and is never
-- used as an exact flip instant.
--
-- No CHECK constraint. The only reader gates on status, and a CHECK would
-- turn a missed clear on a live payment path into a failed UPDATE.
--
-- Deploy safety:
--   - `lock_timeout` (0305 precedent): ADD COLUMN is metadata-only, but its
--     ACCESS EXCLUSIVE lock is held to the end of the migrator's single
--     batch transaction. Without a bound, one open cron transaction on
--     `renewal_cycles` would queue every member-facing read behind the ALTER.
--     `SET LOCAL` lasts for the whole batch, so the default is restored as
--     the LAST statement.
--   - The backfill fails the deploy if the migration role lacks BYPASSRLS
--     (0293 precedent). Both tables are RLS FORCE, so without BYPASSRLS both
--     UPDATEs would match 0 rows and still report success. It RAISEs NOTICE
--     with each arm's row count so the build log records how many cycles
--     were stamped. A stamped row whose period is still running moves from
--     suspended to full at deploy.
--   - The `renewal_cycles_set_updated_at` trigger bumps `updated_at` on each
--     stamped row. Arm (b) reads the OLD `updated_at` (SET expressions see
--     the pre-update row), so the copied hint is the pre-deploy value.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "renewal_cycles"
  ADD COLUMN IF NOT EXISTS "awaiting_entered_at" timestamptz;
--> statement-breakpoint

DO $$
DECLARE
  n_audit integer;
  n_auto integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls) THEN
    RAISE EXCEPTION
      'migration role % lacks BYPASSRLS; the 0308 backfill would be blind under RLS FORCE',
      current_user;
  END IF;

  -- (a) + (c): audit evidence of a flip out of upcoming|reminded.
  UPDATE "renewal_cycles" rc
  SET "awaiting_entered_at" = ev.entered_at
  FROM (
    SELECT a."tenant_id", (a."payload"->>'cycle_id')::uuid AS cycle_id,
           MAX(a."timestamp") AS entered_at
    FROM "audit_log" a
    WHERE a."event_type" IN ('renewal_entered_awaiting_payment', 'renewal_orphan_invoice_relinked')
      AND (
        a."event_type" = 'renewal_entered_awaiting_payment'
        OR a."payload"->>'previous_cycle_status' IN ('upcoming', 'reminded')
      )
      AND a."payload"->>'cycle_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    GROUP BY a."tenant_id", (a."payload"->>'cycle_id')::uuid
  ) ev
  WHERE rc."status" = 'awaiting_payment'
    AND rc."awaiting_entered_at" IS NULL
    AND rc."tenant_id" = ev."tenant_id"
    AND rc."cycle_id" = ev.cycle_id
    -- B1: RENEWAL cohort only, mirroring classifyMembershipPayment and the
    -- effectivePaidCoverageSql settled-predecessor predicate. A first_payment
    -- cycle's early bill charges the CURRENT period, so it stays unstamped.
    AND (rc."anchored_at" IS NOT NULL OR EXISTS (
      SELECT 1
      FROM "renewal_cycles" p
      LEFT JOIN "invoices" li
        ON li."tenant_id" = p."tenant_id" AND li."invoice_id" = p."linked_invoice_id"
      LEFT JOIN "invoices" ai
        ON ai."tenant_id" = p."tenant_id" AND ai."invoice_id" = p."anchor_invoice_id"
      WHERE p."tenant_id" = rc."tenant_id"
        AND p."member_id" = rc."member_id"
        AND p."cycle_id" <> rc."cycle_id"
        AND (
          (p."status" = 'completed'
             AND li."status" IS DISTINCT FROM 'void'
             AND (li."status" IS DISTINCT FROM 'credited' OR EXISTS (
               SELECT 1 FROM "credit_notes" cn
               WHERE cn."tenant_id" = li."tenant_id"
                 AND cn."original_invoice_id" = li."invoice_id"
                 AND cn."retains_coverage" = TRUE)))
          OR
          (p."anchored_at" IS NOT NULL
             AND ai."status" IS DISTINCT FROM 'void'
             AND (ai."status" IS DISTINCT FROM 'credited' OR EXISTS (
               SELECT 1 FROM "credit_notes" cn
               WHERE cn."tenant_id" = ai."tenant_id"
                 AND cn."original_invoice_id" = ai."invoice_id"
                 AND cn."retains_coverage" = TRUE)))
        )
    ));
  GET DIAGNOSTICS n_audit = ROW_COUNT;

  -- (b): the linked bill is the cycle's own auto-draft (107 issue path).
  UPDATE "renewal_cycles" rc
  SET "awaiting_entered_at" = rc."updated_at"
  WHERE rc."status" = 'awaiting_payment'
    AND rc."awaiting_entered_at" IS NULL
    AND rc."linked_invoice_id" IS NOT NULL
    AND rc."linked_invoice_id" = rc."auto_draft_invoice_id"
    -- B1: RENEWAL cohort only, mirroring classifyMembershipPayment and the
    -- effectivePaidCoverageSql settled-predecessor predicate. A first_payment
    -- cycle's early bill charges the CURRENT period, so it stays unstamped.
    AND (rc."anchored_at" IS NOT NULL OR EXISTS (
      SELECT 1
      FROM "renewal_cycles" p
      LEFT JOIN "invoices" li
        ON li."tenant_id" = p."tenant_id" AND li."invoice_id" = p."linked_invoice_id"
      LEFT JOIN "invoices" ai
        ON ai."tenant_id" = p."tenant_id" AND ai."invoice_id" = p."anchor_invoice_id"
      WHERE p."tenant_id" = rc."tenant_id"
        AND p."member_id" = rc."member_id"
        AND p."cycle_id" <> rc."cycle_id"
        AND (
          (p."status" = 'completed'
             AND li."status" IS DISTINCT FROM 'void'
             AND (li."status" IS DISTINCT FROM 'credited' OR EXISTS (
               SELECT 1 FROM "credit_notes" cn
               WHERE cn."tenant_id" = li."tenant_id"
                 AND cn."original_invoice_id" = li."invoice_id"
                 AND cn."retains_coverage" = TRUE)))
          OR
          (p."anchored_at" IS NOT NULL
             AND ai."status" IS DISTINCT FROM 'void'
             AND (ai."status" IS DISTINCT FROM 'credited' OR EXISTS (
               SELECT 1 FROM "credit_notes" cn
               WHERE cn."tenant_id" = ai."tenant_id"
                 AND cn."original_invoice_id" = ai."invoice_id"
                 AND cn."retains_coverage" = TRUE)))
        )
    ));
  GET DIAGNOSTICS n_auto = ROW_COUNT;

  RAISE NOTICE '0308 backfill: stamped % cycle(s) from audit evidence, % from auto-draft links',
    n_audit, n_auto;
END
$$;
--> statement-breakpoint

SET LOCAL lock_timeout = DEFAULT;
