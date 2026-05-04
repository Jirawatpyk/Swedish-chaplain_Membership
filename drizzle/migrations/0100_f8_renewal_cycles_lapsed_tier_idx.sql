-- F8 Phase 3 Round 6 W-R5-2 — covering index for tier-filtered lapsed-count.
--
-- The pipeline dashboard's `loadPipelinePage` issues a separate count
-- query for the Lapsed badge that filters by status='lapsed' AND (when
-- the user has a tier filter active) `tier_at_cycle_start`. The
-- existing `renewal_cycles_pipeline_idx (tenant_id, status, expires_at)`
-- does not include `tier_at_cycle_start`, so the planner falls back to
-- a heap recheck after scanning the status partition.
--
-- At SweCham's current 131 members this is invisible. At 500-5000
-- members it becomes the bottleneck for the lapsed-count query.
-- Partial index keyed on the static filter (`WHERE status = 'lapsed'`)
-- keeps the index size minimal — only the lapsed rows are stored.
--
-- Lock impact: CREATE INDEX CONCURRENTLY runs without blocking writes
-- to renewal_cycles. Safe to apply on a live database.

CREATE INDEX CONCURRENTLY IF NOT EXISTS renewal_cycles_lapsed_tier_idx
  ON renewal_cycles (tenant_id, tier_at_cycle_start)
  WHERE status = 'lapsed';

COMMENT ON INDEX renewal_cycles_lapsed_tier_idx IS
  'F8 Round 6 W-R5-2 — partial covering index for the tier-filtered lapsed-count query in loadPipelinePage. Keeps the badge count fast at scale (>500 cycles) under tenant tier filters.';
