-- 107-auto-invoice (Task 11, review Important-2 fix) — new F8 audit event
-- for the reconcile-issued-orphans daily housekeeping cron:
-- `renewal_orphan_invoice_relinked` (an `issued` auto-drafted invoice's
-- cycle link was repaired because `issueAutoDraftedRenewal`'s own tx2
-- failed to stamp `linked_invoice_id`, F8.AUTO_ISSUE.LINK_FAILED).
--
-- A NEW migration rather than an append to 0260/0261 — both already
-- applied to the `dev` Neon branch before this fix landed, so editing
-- either file in place would change its content hash after being recorded
-- as applied. See `scripts/lib/enum-migration-guard.ts` header for why
-- `ALTER TYPE … ADD VALUE` migrations run in their own autocommit
-- pre-pass and must stay self-contained.

ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_orphan_invoice_relinked';
