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
-- awaiting_payment` (the only edges out of a paid or grandfathered period)
-- and clears it on every other transition into or out of `awaiting_payment`.
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
-- Rows with no evidence keep NULL, i.e. today's behaviour. (a) and (c) use
-- the audit timestamp. (b) has no audit row, so it uses `updated_at` as an
-- approximation; the value is a discriminator plus forensic hint and is never
-- used as an exact flip instant.
--
-- No CHECK constraint. The only reader gates on status, and a CHECK would
-- turn a missed clear on a live payment path into a failed UPDATE.
-- ---------------------------------------------------------------------------

ALTER TABLE "renewal_cycles"
  ADD COLUMN IF NOT EXISTS "awaiting_entered_at" timestamptz;
--> statement-breakpoint

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
  AND rc."cycle_id" = ev.cycle_id;
--> statement-breakpoint

UPDATE "renewal_cycles"
SET "awaiting_entered_at" = "updated_at"
WHERE "status" = 'awaiting_payment'
  AND "awaiting_entered_at" IS NULL
  AND "linked_invoice_id" IS NOT NULL
  AND "linked_invoice_id" = "auto_draft_invoice_id";
