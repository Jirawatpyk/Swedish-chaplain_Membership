-- 088-invoice-tax-flow-redesign (US5 review follow-up) — CLOSE the 3-valued-logic
-- hole in members_branch_pairing_ck (migration 0232 / US3 / FR-008).
--
-- 0232's branch leg `(is_head_office = false AND branch_code ~ '^[0-9]{5}$')`
-- evaluates to NULL (not FALSE) when branch_code IS NULL, and a Postgres CHECK
-- admits NULL — so a (is_head_office = false, branch_code = NULL) member row
-- slips past the DB defense-in-depth guard (only the app-layer updateMember
-- superRefine/zod blocks it). This mirrors the fix already applied to
-- tenant_invoice_settings_seller_branch_ck in migration 0233: add an explicit
-- `branch_code IS NOT NULL` to the branch leg so the pairing invariant is
-- enforced for EVERY write path (direct SQL / bulk import / a future use-case
-- that forgets the superRefine), because these columns feed the §86/4 buyer
-- Head-Office / Branch particular on tax documents.
--
-- TIGHTENING (the columns already exist), so unlike 0233 it CAN in principle
-- reject an existing row. SAFE here: the write path has ALWAYS been app-guarded
-- (updateMember superRefine mirrors the pairing) so no (false, NULL) row exists,
-- and prod is a clean launch state (no member rows). If a future env DOES hold
-- an offender, this DROP + re-ADD fails loudly at deploy → remediate the row
-- (set is_head_office = true, or add a 5-digit branch_code) then re-run.
-- Idempotent: DROP CONSTRAINT IF EXISTS + re-ADD.
ALTER TABLE "members" DROP CONSTRAINT IF EXISTS "members_branch_pairing_ck";--> statement-breakpoint

ALTER TABLE "members" ADD CONSTRAINT "members_branch_pairing_ck" CHECK (
  (is_head_office = true AND branch_code IS NULL)
  OR (is_head_office = false AND branch_code IS NOT NULL AND branch_code ~ '^[0-9]{5}$')
);--> statement-breakpoint
