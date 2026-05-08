-- ---------------------------------------------------------------------------
-- F8 data-seed repair — `membership_plans.renewal_tier_bucket` mapping fix.
--
-- spec.md line 392 (assumption A7) committed F8's coordinated migration to
-- backfill `renewal_tier_bucket` so each F2 plan lands in its "matching
-- bucket" from the 5 canonical buckets (`thai_alumni`, `start_up`,
-- `regular`, `premium`, `partnership`). The original backfill in 0094
-- (`f8_extend_members_and_plans_columns`) classified almost every
-- corporate plan as `regular`, which broke admin pipeline filtering:
-- `?tier=premium` matched zero rows even when Premium Plus members
-- were due to renew, because the Premium Plus plan rows carried
-- `renewal_tier_bucket = 'regular'` in the DB.
--
-- Mapping rationale (each plan to its tier-grouped schedule policy):
--   - `premium`     → `premium`     (was `regular`) — Premium Plus
--                                                     justifies its own
--                                                     reminder cadence
--   - `start-up`    → `start_up`    (was `regular`) — start-up plans get
--                                                     a longer onboarding
--                                                     reminder ladder
--   - `thai-alumni` → `thai_alumni` (was `regular`) — alumni members get
--                                                     a different price
--                                                     point + ladder
--   - `individual`  → `regular`     (was `thai_alumni`) — Individual is a
--                                                     personal corporate
--                                                     membership, not an
--                                                     alumni/student plan
--   - `large`       → `regular` (no change) — Large Corporate uses the
--                                              regular schedule
--   - `regular`     → `regular` (no change)
--   - `diamond` / `gold` / `platinum` → `partnership` (no change)
--
-- Cycle table (`renewal_cycles.tier_at_cycle_start`) is NOT touched —
-- existing cycles freeze the bucket value at creation time per FR-021a.
-- The only swecham cycle today is for plan_id=regular (bucket=regular,
-- correct); future cycles will pick up the corrected bucket via the F2
-- plan-lookup at cycle creation.
--
-- Tenant scope: this migration only repairs `swecham` rows. Other tenants
-- (none today) carrying their own seed will need a parallel repair if/when
-- the same misclassification surfaces.
--
-- Source of truth: spec.md § FR-008 (5 frozen buckets) +
-- docs/membership-benefits-analysis.md plan catalogue.
-- ---------------------------------------------------------------------------

UPDATE "membership_plans"
   SET "renewal_tier_bucket" = 'premium'
 WHERE "tenant_id" = 'swecham'
   AND "plan_id"   = 'premium'
   AND "renewal_tier_bucket" <> 'premium';
--> statement-breakpoint

UPDATE "membership_plans"
   SET "renewal_tier_bucket" = 'start_up'
 WHERE "tenant_id" = 'swecham'
   AND "plan_id"   = 'start-up'
   AND "renewal_tier_bucket" <> 'start_up';
--> statement-breakpoint

UPDATE "membership_plans"
   SET "renewal_tier_bucket" = 'thai_alumni'
 WHERE "tenant_id" = 'swecham'
   AND "plan_id"   = 'thai-alumni'
   AND "renewal_tier_bucket" <> 'thai_alumni';
--> statement-breakpoint

UPDATE "membership_plans"
   SET "renewal_tier_bucket" = 'regular'
 WHERE "tenant_id" = 'swecham'
   AND "plan_id"   = 'individual'
   AND "renewal_tier_bucket" <> 'regular';
--> statement-breakpoint
