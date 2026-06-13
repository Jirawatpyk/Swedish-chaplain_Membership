-- F8 #4 lapsed-badge — supporting index for the per-page batch
-- DISTINCT ON (member_id) ... ORDER BY member_id, created_at DESC, cycle_id DESC
-- query in loadMembersMembershipStatus. Lets the planner serve it as an
-- index-ordered scan instead of a Seq Scan. NOTE: the index omits cycle_id, so
-- the `cycle_id DESC` tiebreak still incurs a tiny per-member in-memory Sort —
-- it is NOT a pure skip-scan with zero Sort. The residual sort is negligible
-- (a handful of cycles per member); see schema-renewal-cycles.ts memberRecencyIdx.
CREATE INDEX IF NOT EXISTS "renewal_cycles_member_recency_idx"
  ON "renewal_cycles" ("tenant_id", "member_id", "created_at" DESC);
