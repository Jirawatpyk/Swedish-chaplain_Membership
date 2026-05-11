-- F8 Phase 3 Round 6 W-R5-2 / Round 7 B-R6-1 — covering index for
-- tier-filtered lapsed-count.
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
-- Round 7 B-R6-1: Removed `CONCURRENTLY` clause. Drizzle's migration
-- runner wraps every migration in a single BEGIN/COMMIT transaction
-- block; `CREATE INDEX CONCURRENTLY` is illegal inside a tx and would
-- raise PG `ERROR 25001` at apply time. Migrations 0021 and 0054 set
-- the precedent of accepting a brief AccessExclusiveLock at MVP scale
-- (<5k cycles → sub-second lock) in exchange for migration-runner
-- compatibility. F8 follows the same pattern. If a future production
-- backfill needs a non-blocking rebuild, the index can be dropped +
-- recreated CONCURRENTLY via a manual ops runbook step OUTSIDE the
-- migrator.

CREATE INDEX IF NOT EXISTS renewal_cycles_lapsed_tier_idx
  ON renewal_cycles (tenant_id, tier_at_cycle_start)
  WHERE status = 'lapsed';

COMMENT ON INDEX renewal_cycles_lapsed_tier_idx IS
  'F8 Round 6 W-R5-2 — partial covering index for the tier-filtered lapsed-count query in loadPipelinePage. Keeps the badge count fast at scale (>500 cycles) under tenant tier filters.';
