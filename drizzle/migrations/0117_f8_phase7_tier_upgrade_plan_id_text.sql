-- ---------------------------------------------------------------------------
-- F8 Phase 7 T179 fix — convert `tier_upgrade_suggestions.from_plan_id` +
-- `tier_upgrade_suggestions.to_plan_id` from `uuid` to `text`.
--
-- Rationale: F2 `membership_plans.plan_id` is `TEXT` (slug-style identifiers
-- like 'regular', 'premium'). The original migration 0091 typed both
-- columns as `uuid`, mirroring the `member_id` shape, but plan ids in
-- this codebase are slugs not UUIDs. The mismatch crashes any INSERT into
-- `tier_upgrade_suggestions` whose `from_plan_id` / `to_plan_id` is a slug
-- — which is every real-world insert because F2 catalogue uses slugs.
--
-- Mirrors migration 0113 (`plan_id_at_cycle_start` UUID → TEXT) which fixed
-- the same shape mismatch on `renewal_cycles`.
--
-- Safe online migration: USING clause casts existing UUID values to text
-- representation for any pre-existing rows (none in production today, but
-- defensive).
-- ---------------------------------------------------------------------------

ALTER TABLE "tier_upgrade_suggestions"
  ALTER COLUMN "from_plan_id" TYPE TEXT USING "from_plan_id"::text;
--> statement-breakpoint
ALTER TABLE "tier_upgrade_suggestions"
  ALTER COLUMN "to_plan_id" TYPE TEXT USING "to_plan_id"::text;
