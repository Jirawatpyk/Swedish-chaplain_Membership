-- ---------------------------------------------------------------------------
-- F8 Phase 2 Wave C · T025 — F3 members + F2 membership_plans column extensions.
--
-- Cross-module migration extending two pre-existing tables:
--
-- F3 `members`: adds 13 columns (renewal opt-out + email-bounce flag +
-- 5-field at-risk score state + auto-reactivate-blocked override quartet)
-- per data-model.md § 3.1. The at-risk widget query needs a partial
-- index on (tenant_id, risk_score DESC) WHERE score ≥ 50 AND not snoozed.
--
-- F2 `membership_plans`: adds `renewal_tier_bucket` text column with a
-- 5-step backfill (data-model.md § 3.2). Plan-name driven mapping using
-- the JSONB `plan_name->>'en'` since membership_plans.plan_name is a
-- LocaleText JSONB column (not plain text). After backfill validates
-- zero NULLs, column is set NOT NULL + CHECK on the 5 bucket values.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS is NOT used here because the
-- subsequent ALTER COLUMN SET NOT NULL would silently re-run on a
-- second migration pass even though the backfill block already
-- finished. Standard pattern in this repo is "single-shot ALTER" +
-- migration journal idempotency at the drizzle-kit layer.
--
-- Source of truth: data-model.md § 3.1 + § 3.2.
-- ---------------------------------------------------------------------------

-- --- 1. F3 members: 13 new columns ------------------------------------------

ALTER TABLE "members"
  ADD COLUMN "renewal_reminders_opted_out"      boolean     NOT NULL DEFAULT FALSE,
  ADD COLUMN "renewal_reminders_opted_out_at"   timestamptz,
  ADD COLUMN "email_unverified"                 boolean     NOT NULL DEFAULT FALSE,
  ADD COLUMN "email_unverified_at"              timestamptz,
  ADD COLUMN "risk_score"                       smallint,
  ADD COLUMN "risk_score_band"                  text,
  ADD COLUMN "risk_score_factors"               jsonb,
  ADD COLUMN "risk_score_last_computed_at"      timestamptz,
  ADD COLUMN "risk_snoozed_until"               timestamptz,
  -- /speckit.clarify Q1 round 3 — auto-reactivate admin override (FR-005b).
  ADD COLUMN "blocked_from_auto_reactivation"   boolean     NOT NULL DEFAULT FALSE,
  ADD COLUMN "blocked_from_auto_reactivation_at" timestamptz,
  ADD COLUMN "blocked_from_auto_reactivation_set_by_user_id" uuid,
  ADD COLUMN "blocked_from_auto_reactivation_reason" text;--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_risk_score_range_check"
    CHECK ("risk_score" IS NULL OR ("risk_score" >= 0 AND "risk_score" <= 100)),
  ADD CONSTRAINT "members_risk_score_band_check"
    CHECK (
      "risk_score_band" IS NULL
      OR "risk_score_band" IN ('healthy', 'warning', 'at-risk', 'critical')
    ),
  ADD CONSTRAINT "members_blocked_from_auto_reactivation_consistency_check"
    CHECK (
      ("blocked_from_auto_reactivation" = FALSE
        AND "blocked_from_auto_reactivation_at" IS NULL
        AND "blocked_from_auto_reactivation_set_by_user_id" IS NULL
        AND "blocked_from_auto_reactivation_reason" IS NULL)
      OR ("blocked_from_auto_reactivation" = TRUE
        AND "blocked_from_auto_reactivation_at" IS NOT NULL
        AND "blocked_from_auto_reactivation_set_by_user_id" IS NOT NULL)
    );--> statement-breakpoint

-- At-risk widget query partial index (data-model.md § 3.1 L581-583).
CREATE INDEX "members_at_risk_idx"
  ON "members" ("tenant_id", "risk_score" DESC)
  WHERE "risk_score" >= 50 AND "risk_snoozed_until" IS NULL;--> statement-breakpoint

-- --- 2. F2 membership_plans: renewal_tier_bucket column + 5-step backfill ---

-- Step 1 — add nullable column.
ALTER TABLE "membership_plans"
  ADD COLUMN "renewal_tier_bucket" text;--> statement-breakpoint

-- Step 2 — backfill from plan_name->>'en' (LocaleText JSONB column).
-- LIKE patterns chosen to match the SweCham 2026 plan catalogue.
UPDATE "membership_plans" SET "renewal_tier_bucket" = CASE
  WHEN "plan_name"->>'en' = 'Thai Alumni' THEN 'thai_alumni'
  WHEN "plan_name"->>'en' = 'Individual'  THEN 'thai_alumni'
  WHEN "plan_name"->>'en' = 'Start-up Corporate' THEN 'start_up'
  WHEN "plan_name"->>'en' = 'Regular Corporate'  THEN 'regular'
  WHEN "plan_name"->>'en' = 'Large Corporate'    THEN 'regular'
  WHEN "plan_name"->>'en' = 'Premium Corporate'  THEN 'premium'
  WHEN "plan_name"->>'en' LIKE '%Partnership%'   THEN 'partnership'
  ELSE 'regular'
END;--> statement-breakpoint

-- Step 3 — verify backfill (loud-fail if any row still NULL).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "membership_plans"
    WHERE "renewal_tier_bucket" IS NULL
  ) THEN
    RAISE EXCEPTION 'F8 backfill failed: % membership_plans rows still NULL renewal_tier_bucket',
      (SELECT COUNT(*) FROM "membership_plans" WHERE "renewal_tier_bucket" IS NULL);
  END IF;
END $$;--> statement-breakpoint

-- Step 4 — tighten to NOT NULL + CHECK on 5 bucket values.
ALTER TABLE "membership_plans"
  ALTER COLUMN "renewal_tier_bucket" SET NOT NULL,
  ADD CONSTRAINT "membership_plans_renewal_tier_bucket_check"
    CHECK ("renewal_tier_bucket" IN (
      'thai_alumni',
      'start_up',
      'regular',
      'premium',
      'partnership'
    ));--> statement-breakpoint

-- Step 5 — supporting index for F8 cron joins (member.plan_id → bucket).
CREATE INDEX "membership_plans_renewal_tier_bucket_idx"
  ON "membership_plans" ("tenant_id", "renewal_tier_bucket");--> statement-breakpoint
