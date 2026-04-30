-- 0074 — Fix `broadcasts.requested_by_member_plan_id_snapshot` type.
--
-- F2 stores `membership_plans.plan_id` as TEXT (composite identity is
-- `(tenant_id, plan_id, plan_year)` — there is no surrogate uuid). The
-- Wave 1 schema for the broadcasts table mistakenly declared the
-- snapshot column as `uuid NOT NULL`, which is incompatible with the
-- value that `submitBroadcast` actually passes (the F2 plan_code
-- string e.g. 'corporate', 'regular').
--
-- F7 has not shipped to production (FEATURE_F7_BROADCASTS=false), so
-- there are no rows to migrate. The fix is a straight column alter.

ALTER TABLE broadcasts
  ALTER COLUMN requested_by_member_plan_id_snapshot TYPE text USING requested_by_member_plan_id_snapshot::text;
