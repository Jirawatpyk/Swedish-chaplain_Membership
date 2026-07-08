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
ALTER TABLE "renewal_cycles" ADD CONSTRAINT "renewal_cycles_anchor_invoice_fk"
  FOREIGN KEY ("tenant_id","anchor_invoice_id")
  REFERENCES "invoices"("tenant_id","invoice_id")
  ON DELETE SET NULL;--> statement-breakpoint
ALTER TYPE "audit_event_type" ADD VALUE IF NOT EXISTS 'renewal_cycle_reanchored';--> statement-breakpoint
