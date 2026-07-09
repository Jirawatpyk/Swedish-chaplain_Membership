-- 0238 — renewal rolling-anchor (spec 2026-07-08 rev 2)
-- anchored_at: discriminator "this cycle has been anchored to a real payment"
--   (set by re-anchor AND by the R4 backfill script; NULL = provisional
--   registration_date anchor from onboarding).
-- anchor_invoice_id: forensic reference to the anchoring invoice (NULL for
--   backfilled pre-system payments). Deliberately NOT linked_invoice_id —
--   that column stays free for the renewal-invoice machinery (linkInvoice
--   I1 guard refuses overwrite).
ALTER TABLE "renewal_cycles" ADD COLUMN IF NOT EXISTS "anchored_at" timestamptz;--> statement-breakpoint
ALTER TABLE "renewal_cycles" ADD COLUMN IF NOT EXISTS "anchor_invoice_id" uuid;--> statement-breakpoint
-- F7 (final-review, 2026-07-09, comment-only — migration already applied,
-- no behavioural change): this is a COMPOSITE FK on (tenant_id,
-- anchor_invoice_id). "ON DELETE SET NULL" nulls BOTH columns, including
-- tenant_id — but tenant_id is NOT NULL (part of renewal_cycles_pk), so in
-- practice a hard-delete of a referenced invoice ERRORS on the NOT NULL
-- violation rather than actually nulling the pointer, i.e. it behaves as
-- NO ACTION (the delete is blocked), not as literally documented SET NULL.
-- Acceptable because tax invoices are never hard-deleted in this codebase
-- (GDPR erasure redacts PII in place, it does not DROP invoice rows).
-- FIX-4 (PR #173 review, 2026-07-09, comment correction) — the ORIGINAL
-- claim here ("clear-test-data purges renewal_cycles before invoices, so
-- the ordering issue never surfaces in practice") was true ONLY for
-- clear-test-data's tenant-scoped pass (`tenant_id LIKE 'test-%'`, which
-- does delete renewal_cycles before invoices). It was WRONG for the
-- script's separate test-USER-scoped orphan-cleanup pass (non-test-tenant
-- rows referencing a test-user-created/paid invoice/member/credit-note):
-- that pass's `orphanCyclePredicate` originally checked only
-- `linked_invoice_id` / `(tenant_id, member_id)` / `linked_credit_note_id`,
-- missing `anchor_invoice_id` entirely — a re-anchored cycle (whose
-- `linked_invoice_id` is CLEARED by the same UPDATE that stamps
-- `anchor_invoice_id`) could survive the cycle purge and then block the
-- orphan invoice DELETE with a `renewal_cycles_anchor_invoice_fk`
-- violation. `orphanCyclePredicate` now includes an `anchor_invoice_id`
-- arm mirroring `linked_invoice_id`'s, closing this gap for real.
ALTER TABLE "renewal_cycles" ADD CONSTRAINT "renewal_cycles_anchor_invoice_fk"
  FOREIGN KEY ("tenant_id","anchor_invoice_id")
  REFERENCES "invoices"("tenant_id","invoice_id")
  ON DELETE SET NULL;--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_reanchored';--> statement-breakpoint
