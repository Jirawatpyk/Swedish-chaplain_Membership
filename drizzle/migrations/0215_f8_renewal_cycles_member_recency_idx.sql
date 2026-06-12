-- F8 #4 lapsed-badge — supporting index for the per-page batch
-- DISTINCT ON (member_id) ... ORDER BY member_id, created_at DESC query in
-- loadMembersMembershipStatus. Makes it an index skip-scan (no Seq Scan / Sort).
CREATE INDEX IF NOT EXISTS "renewal_cycles_member_recency_idx"
  ON "renewal_cycles" ("tenant_id", "member_id", "created_at" DESC);
