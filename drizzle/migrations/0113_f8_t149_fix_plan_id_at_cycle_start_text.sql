-- ---------------------------------------------------------------------------
-- F8 T149 schema follow-up — convert renewal_cycles.plan_id_at_cycle_start
-- from `uuid` to `text` so it matches `membership_plans.plan_id` (TEXT slug).
--
-- Background: 0087 (the original F8 cycle table) typed
-- `plan_id_at_cycle_start` as `uuid`, but F2 plan IDs are TEXT slugs
-- (`'regular'`, `'premium'`, `'large'`, `'individual'`, `'start-up'`,
-- `'thai-alumni'`, …). The mismatch was logged as the T149 carry-forward
-- but never resolved, which let seeds (notably
-- `tests/e2e/helpers/renewals-seed.ts`) write `gen_random_uuid()` into
-- this column. The cycle-detail page's F2 plan-name lookup then
-- silently fell to "—" because the random UUID matched no F2 row.
--
-- Fix:
--   1. ALTER COLUMN type uuid → text. Existing UUID values are preserved
--      as their canonical text rendering (Postgres
--      `uuid::text` cast is implicit + lossless).
--   2. Repair orphan rows whose `plan_id_at_cycle_start` does not
--      resolve to a live `membership_plans.plan_id` for the cycle's
--      tenant. Best-available signal is `tier_at_cycle_start` — for the
--      tenants in this codebase the plan_id slug equals the tier-bucket
--      string for the canonical tier (`regular`/`premium`/`large`/
--      `individual`/`start-up`). Where the tier-string does NOT match a
--      live plan, leave the row as-is (no-op subquery filter) so the
--      lookup-failed UI is still surfaced as a real data issue.
--
-- No FK is added to `membership_plans` because:
--   - F2 plans are versioned by (tenant_id, plan_id, plan_year); a
--     cycle freezes plan_id only, so a hard FK would either need to
--     pin (tenant_id, plan_id, plan_year) — which conflicts with cycle
--     re-use across years — or accept duplicates per (tenant_id,
--     plan_id) which Postgres FK semantics don't allow.
--   - The application layer's `loadPlanFrozenFields` query
--     (`plan-lookup-for-renewal-drizzle.ts`) already follows the
--     soft-FK lookup pattern (WHERE plan_id + isNull(deletedAt) +
--     ORDER BY plan_year DESC LIMIT 1).
--
-- Idempotency: ALTER COLUMN TYPE is idempotent at the DDL level only
-- when the source/target types match; running this migration twice
-- would error with "column is already of type text" — Drizzle's
-- migration runner records `0113` in `__drizzle_migrations` so this
-- file is applied at most once. The UPDATE statement is itself
-- idempotent (the WHERE clause filters to rows whose `plan_id_at_cycle_start`
-- is NOT in `membership_plans` — once repaired they no longer match).
--
-- Source of truth: T149 carry-forward note (`specs/011-renewal-reminders/
-- tasks.md`) + Phase 5 K29 staff feedback "shema ผิดใช่ไหม" (2026-05-08).
-- ---------------------------------------------------------------------------

ALTER TABLE "renewal_cycles"
  ALTER COLUMN "plan_id_at_cycle_start" TYPE text USING "plan_id_at_cycle_start"::text;
--> statement-breakpoint

UPDATE "renewal_cycles" c
   SET "plan_id_at_cycle_start" = c."tier_at_cycle_start"
 WHERE NOT EXISTS (
   SELECT 1
     FROM "membership_plans" p
    WHERE p."tenant_id" = c."tenant_id"
      AND p."plan_id"   = c."plan_id_at_cycle_start"
      AND p."deleted_at" IS NULL
 )
 AND EXISTS (
   SELECT 1
     FROM "membership_plans" p2
    WHERE p2."tenant_id" = c."tenant_id"
      AND p2."plan_id"   = c."tier_at_cycle_start"
      AND p2."deleted_at" IS NULL
 );
--> statement-breakpoint

-- Phase 6 review-round 2 F4 — observable orphan count.
-- After the repair UPDATE, count cycles whose `plan_id_at_cycle_start`
-- still does not resolve to any live `membership_plans` row. These
-- silently render as "—" on the cycle-detail page (no UI for the
-- orphan tray yet). Operators reading the migration log see this
-- count and can decide whether to manually triage. Pure SELECT — no
-- side effects beyond the NOTICE.
DO $$
DECLARE
  orphan_count BIGINT;
BEGIN
  SELECT count(*)
    INTO orphan_count
    FROM "renewal_cycles" c
   WHERE NOT EXISTS (
     SELECT 1
       FROM "membership_plans" p
      WHERE p."tenant_id" = c."tenant_id"
        AND p."plan_id"   = c."plan_id_at_cycle_start"
        AND p."deleted_at" IS NULL
   );
  IF orphan_count > 0 THEN
    RAISE NOTICE
      'F8 migration 0113: % renewal_cycles row(s) still have plan_id_at_cycle_start that does not resolve to a live membership_plans row. Cycle-detail page will render plan-name as ''—'' for these rows. Manual triage may be required.',
      orphan_count;
  ELSE
    RAISE NOTICE 'F8 migration 0113: zero orphan rows after repair UPDATE.';
  END IF;
END $$;
--> statement-breakpoint
