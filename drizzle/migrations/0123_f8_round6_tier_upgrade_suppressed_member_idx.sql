-- ---------------------------------------------------------------------------
-- F8 Phase 7 / Round 6 S-008 — performance index for `isSuppressedForMember`.
--
-- The pre-Round-6 partial index `tier_upgrade_suggestions_suppressed_idx`
-- (migration 0091) was `(tenant_id, status, suppressed_until) WHERE
-- status='dismissed'`. The `isSuppressedForMember` query filters by
-- `(tenant_id, member_id, status='dismissed', suppressed_until > now())`.
-- Without `member_id` in the leading index columns, Postgres scans
-- every dismissed row in the tenant and filters memberId in the heap.
--
-- At MVP single-tenant scale (<500 members) this is unobservable. As
-- per-tenant member counts grow OR as multi-tenant lands, the cost
-- compounds: a tenant with 5,000 dismissed-suggestion-history rows
-- requires 5,000 heap reads per evaluate cron pass × 500 active
-- members → 2.5M heap reads per weekly cron run.
--
-- This migration adds the second index. The original suppressed_idx is
-- retained because some future query path (admin "view all dismissed")
-- still benefits from the tenant + status leading-column form.
--
-- IDX-RATIONALE: Composite + partial. `member_id` second so the eval
-- cron's per-member lookup hits the index leaf directly. `suppressed_until`
-- third because the eval-time filter is `suppressed_until > now()`
-- (range-scan friendly). `WHERE status='dismissed'` keeps the index
-- narrow (5y of dismissed history vs full table).
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "tier_upgrade_suggestions_member_suppressed_idx"
  ON "tier_upgrade_suggestions" ("tenant_id", "member_id", "suppressed_until")
  WHERE "status" = 'dismissed';
