-- 088-invoice-tax-flow-redesign (T039 / US5 / FR-012 / FR-022 / data-model § F.7)
-- — tenant-configurable WHT footer note + seller §86/4 Head-Office/Branch +
-- offline-payment bank block on `tenant_invoice_settings`.
--
-- These columns are read at invoice-ISSUE time and PINNED into the immutable
-- `tenant_identity_snapshot` (member-identity-adapter / issue-invoice), so a
-- later settings change never retroactively alters a historical document
-- (FR-011). The template renders the SNAPSHOT, never live settings.
--
--   - `wht_note_th/_en`      — WHT note; rendered on membership documents ONLY
--                              (bill + tax receipt), NULL ⇒ nothing (FR-012).
--   - `seller_is_head_office`+ `seller_branch_code` — the SELLER §86/4
--                              Head-Office/Branch line (US3 wired the buyer;
--                              this wires the tenant seller). Default =
--                              สำนักงานใหญ่ / Head Office (TSCC).
--   - bank block (payee / account_no / account_type / bank / branch / address /
--                 swift + free-text instructions TH/EN) — FR-022 offline-payment
--                 block, rendered on the ใบแจ้งหนี้ (bill) ONLY. All NULL ⇒ no
--                 block.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + re-ADD,
-- pattern from 0203/0208/0211/0212/0231/0232). Existing rows take the
-- `seller_is_head_office = true` DEFAULT + all-NULL new columns → satisfy the
-- seller-branch pairing CHECK with NO backfill. RLS: `tenant_invoice_settings`
-- inherits the existing per-tenant policy (no new policy needed).

-- 1. WHT footer note (bilingual, both NULL for every existing row).
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "wht_note_th" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "wht_note_en" text;--> statement-breakpoint

-- 2. Seller §86/4 Head-Office / Branch (default true = สำนักงานใหญ่).
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "seller_is_head_office" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "seller_branch_code" char(5);--> statement-breakpoint

-- 3. FR-022 offline-payment bank block (all NULL for every existing row).
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_payee_name" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_account_no" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_account_type" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_name" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_branch" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_address" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "bank_swift" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "payment_instructions_th" text;--> statement-breakpoint
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "payment_instructions_en" text;--> statement-breakpoint

-- 4. Seller Head-Office/Branch pairing CHECK — a head office carries a NULL
--    code; a branch carries an exactly-5-digit code. char(5) space-pads a
--    shorter value → the `^[0-9]{5}$` anchor also enforces the digit-count.
--
--    NULL-safe by design: the branch leg carries an explicit
--    `seller_branch_code IS NOT NULL` so a `(false, NULL)` row evaluates to
--    FALSE (rejected) rather than NULL. Postgres CHECK treats NULL as satisfied
--    (only FALSE rejects), so WITHOUT the IS NOT NULL the `null ~ regex → NULL`
--    branch would let a branch-with-no-code slip past this defense-in-depth
--    guard. (This is stricter than the analogous member `members_branch_pairing_ck`
--    from 0232, which shares the same 3-valued-logic hole — the app-layer
--    superRefine is the primary guard for both; see report note.)
ALTER TABLE "tenant_invoice_settings"
  DROP CONSTRAINT IF EXISTS "tenant_invoice_settings_seller_branch_ck";--> statement-breakpoint

ALTER TABLE "tenant_invoice_settings" ADD CONSTRAINT "tenant_invoice_settings_seller_branch_ck" CHECK (
  (seller_is_head_office = true AND seller_branch_code IS NULL)
  OR (seller_is_head_office = false AND seller_branch_code IS NOT NULL AND seller_branch_code ~ '^[0-9]{5}$')
);--> statement-breakpoint
