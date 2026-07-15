-- 059 / PR-A Task 5 — a branch implies a VAT registrant.
--
-- 0236 pinned only `is_head_office ⇔ branch_code`. Nothing stopped
-- `(is_vat_registered = false, is_head_office = false, branch_code = '00001')` —
-- a row that PASSES every existing check and then renders NO branch line at all,
-- because invoice-template.tsx gates the line on the registrant flag. A silent
-- under-print. The rule lived only in the client (`member-form/schema.ts`), so a
-- direct API call could already store it.
--
-- This TIGHTENS. `members` is empty (prod wiped 2026-07-12), so no row can be
-- rejected — but audit before applying to any populated database.
--
-- Idempotent (DROP IF EXISTS + re-ADD), pattern from 0236.
ALTER TABLE "members" DROP CONSTRAINT IF EXISTS "members_branch_pairing_ck";--> statement-breakpoint

ALTER TABLE "members" ADD CONSTRAINT "members_branch_pairing_ck" CHECK (
  (is_head_office = true AND branch_code IS NULL)
  OR (is_head_office = false
      AND is_vat_registered = true
      AND branch_code IS NOT NULL
      AND branch_code ~ '^[0-9]{5}$')
);--> statement-breakpoint
