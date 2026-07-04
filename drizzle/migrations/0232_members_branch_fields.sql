-- 088-invoice-tax-flow-redesign (T029 / US3 / FR-008 / data-model § F.1) —
-- §86/4 Head-Office / Branch buyer particular on the F3 member record.
--
-- Adds the admin-managed `is_head_office` flag (default = สำนักงานใหญ่ / Head
-- Office) + the optional 5-digit RD `branch_code`, pinned into the immutable
-- buyer identity snapshot at invoice-issue time (member-identity-adapter.ts).
-- The §86/4 buyer branch LINE is drawn ONLY for a VAT-registrant juristic buyer
-- (gated on the snapshot's `buyer_is_vat_registrant`, NEVER `buyerHasTin`);
-- these columns just STORE the particular.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + re-ADD,
-- pattern from 0203/0208/0211/0212/0231). Existing rows take the `is_head_office
-- = true` DEFAULT + `branch_code` NULL → satisfy the pairing CHECK with no
-- backfill. RLS: `members` is per-tenant row-level; new columns inherit the
-- existing policy (no new policy needed).

-- 1. Head-office flag (default true = สำนักงานใหญ่, for every existing row).
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "is_head_office" boolean NOT NULL DEFAULT true;--> statement-breakpoint

-- 2. Optional 5-digit RD branch code (NULL for a head office).
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "branch_code" char(5);--> statement-breakpoint

-- 3. Pairing CHECK — mirrors the member-identity snapshot VO superRefine + the
--    updateMember zod: a head office carries a NULL code; a branch carries an
--    exactly-5-digit code. A shorter value in char(5) is space-padded → fails
--    the `^[0-9]{5}$` anchor, so the CHECK also enforces the digit-count.
ALTER TABLE "members" DROP CONSTRAINT IF EXISTS "members_branch_pairing_ck";--> statement-breakpoint

ALTER TABLE "members" ADD CONSTRAINT "members_branch_pairing_ck" CHECK (
  (is_head_office = true AND branch_code IS NULL)
  OR (is_head_office = false AND branch_code ~ '^[0-9]{5}$')
);--> statement-breakpoint
