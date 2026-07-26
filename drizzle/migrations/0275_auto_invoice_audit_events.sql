-- 107-auto-invoice (Task 2) — F8 audit events for the proactive
-- renewal-invoice drafting cron: `renewal_auto_drafted` (a DRAFT invoice
-- was pre-filled ahead of a cycle's due date) + `renewal_auto_draft_discarded`
-- (that draft was discarded — manual issue, superseded by a later cron
-- pass, or pruned once its cycle left the lead-day window).
--
-- A NEW migration rather than an append to 0259: 0259 was already applied
-- to the `dev` Neon branch before this task started (schema — invoice_origin
-- + enrolment/settings columns), so editing that file in place would change
-- its content hash after it has already been recorded as applied — see
-- `scripts/lib/enum-migration-guard.ts` header for why `ALTER TYPE … ADD
-- VALUE` migrations run in their own autocommit pre-pass and must stay
-- self-contained. (0259's own header comment predicted this would land as
-- an append — that plan changed once 0259 shipped to dev first; noting
-- here so a future reader isn't confused by the stale cross-reference.)

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_auto_drafted';--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_auto_draft_discarded';
