-- ---------------------------------------------------------------------------
-- F2 integrity CHECK — `plan_name.en` and `description.en` MUST be
-- non-empty strings.
--
-- Background: `src/modules/plans/domain/locale-text.ts:asLocaleText`
-- enforces non-empty `en` at the Domain boundary (smart constructor
-- wired into `plan-repo.ts:rowToPlan`). Before that smart constructor
-- landed (Batch 3e / F2 R6), seed scripts persisted rows with
-- `description.en=''` for ~44 swecham plans + ~198 leaked
-- test-tenant plans. After the smart constructor wired, hydration
-- via rowToPlan threw `EmptyEnLocaleTextError` on those legacy rows
-- → `listPlans` returned server_error → `/admin/plans` UI showed
-- "Failed to load plans." (see commit 467bfc7f + 9151695c for the
-- diagnostic + backfill + cleanup pipeline that closed the data debt).
--
-- This migration adds DB-level CHECK constraints as the third layer
-- of defence (alongside the Domain smart constructor + the ESLint
-- R4-S4 rule banning inline BenefitMatrix literal construction in
-- production code). Together they form defence-in-depth:
--
--   Layer 1: ESLint (compile-time)  — bans inline literal construction
--   Layer 2: asLocaleText (runtime) — smart-constructor at hydration
--   Layer 3: DB CHECK (this file)   — enforces invariant at write-time
--
-- The CHECK fires on INSERT or UPDATE; bad data cannot land regardless
-- of which application layer wrote the row (seed scripts, future
-- migration backfills, direct SQL edits in admin tools, etc.).
--
-- Pre-flight safety: this migration must run AFTER the data backfill
-- (commits 467bfc7f + 9151695c) which cleaned every empty-en row
-- across the DB. Verified via `scripts/diagnose-empty-locale-rows.ts`
-- reporting "Found 0 rows" at the time this migration is being added.
-- If a future tenant adoption brings legacy data with empty-en rows,
-- run the backfill first BEFORE applying this migration.
-- ---------------------------------------------------------------------------

ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_plan_name_en_non_empty"
  CHECK (
    "plan_name" ? 'en'
    AND jsonb_typeof("plan_name"->'en') = 'string'
    AND length(trim(both from ("plan_name"->>'en'))) > 0
  );--> statement-breakpoint

ALTER TABLE "membership_plans"
  ADD CONSTRAINT "membership_plans_description_en_non_empty"
  CHECK (
    "description" ? 'en'
    AND jsonb_typeof("description"->'en') = 'string'
    AND length(trim(both from ("description"->>'en'))) > 0
  );--> statement-breakpoint
