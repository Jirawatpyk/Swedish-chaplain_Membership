-- ---------------------------------------------------------------------------
-- F8 R4-W4 (staff-review-2026-05-09) — `audit_log` partial index for the
-- weekly at-risk recompute CTE.
--
-- Background: `gatherAtRiskFactorsForTenant`
-- (`src/modules/renewals/infrastructure/drizzle/drizzle-member-renewal-flags-repo.ts:417`)
-- runs a per-tenant CTE that includes a correlated EXISTS sub-query
-- against `audit_log` filtered by `event_type = 'member_plan_changed'`
-- to detect FR-029 factor 8 (recent tier-downgrade signal). Without a
-- partial index covering this lookup, Postgres seq-scans `audit_log` —
-- a table that grows unboundedly across all features (F1+F4+F7 each
-- contribute thousands of rows per active tenant per month).
--
-- At 5,000 members × ~50,000 audit rows the EXPLAIN ANALYZE on Neon
-- Singapore showed the EXISTS branch fall back to a Bitmap Heap Scan +
-- recheck. Adding the partial index `(tenant_id, timestamp)` filtered to
-- only `event_type='member_plan_changed'` (~0.5% of total rows) lets
-- the planner satisfy the EXISTS via an index-only scan without
-- touching the table heap.
--
-- The partial filter keeps the index small (~250 KB at MVP scale vs.
-- ~50 MB on a non-partial `audit_log (tenant_id, event_type, timestamp)`
-- composite), since 99.5% of `audit_log` rows are non-tier-change
-- events that never need this lookup.
--
-- IMPORTANT: this migration is INSIDE a Drizzle-managed transaction
-- (Drizzle wraps every migration in BEGIN/COMMIT) so it cannot use
-- `CREATE INDEX CONCURRENTLY`. The `audit_log` write rate is bounded
-- (every audit emit is an INSERT, never an UPDATE/DELETE), so a brief
-- AccessExclusiveLock during index build is acceptable. At MVP scale
-- (≤100k audit rows total) the build completes in <2 s on Neon.
--
-- See spec § Performance & Observability — SC-005 (at-risk recompute
-- p95 < 60 s @ 5k members) requires this index to land in production
-- before the FEATURE_F8_RENEWALS=true flag-flip.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS audit_log_f8_tier_change_idx
  ON audit_log (tenant_id, "timestamp")
  WHERE event_type = 'member_plan_changed';

-- grants unchanged — `audit_log` has its own GRANT INSERT TO chamber_app
-- from F1's append-only audit setup (migration 0007). Index access is
-- automatic for any role with SELECT on the parent table.
