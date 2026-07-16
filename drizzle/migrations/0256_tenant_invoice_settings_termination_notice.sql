-- 065 renewal-swecham-alignment (§5.4) — bilingual statutory termination notice
-- on tenant_invoice_settings.
--
-- Rendered on the ใบแจ้งหนี้ (bill) ONLY (isBill-gated in the template, v12),
-- NEVER on a §86/4 tax invoice/receipt. Both NULL for every existing row (ships
-- dark until SweCham approves the legal wording). No CHECK needed.
--
-- Pinned into the immutable TenantIdentitySnapshot at issue (SC-003) — the
-- template reads the snapshot, never live settings.
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "termination_notice_th" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "termination_notice_en" text;--> statement-breakpoint
