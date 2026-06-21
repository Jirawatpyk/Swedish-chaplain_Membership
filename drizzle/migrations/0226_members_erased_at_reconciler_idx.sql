-- COMP-1 US2d — the partial index promised by migration 0221 (Member Erasure
-- US1). The reconciliation sweep (`MemberRepo.findStuckErasuresInTx`, driven by
-- POST /api/cron/members/reconcile-erasures) selects erased members
-- (`erased_at IS NOT NULL`) every tick and orders them `erased_at ASC`
-- (oldest-erasure-first — the rows nearest the GDPR Art.12 / PDPA one-month
-- completion deadline). Without an index that is a Seq Scan over the whole
-- `members` table on every tick.
--
-- The partial `WHERE erased_at IS NOT NULL` keeps the index sparse — it covers
-- ONLY erased rows (a tiny minority), so it stays small and the planner can
-- serve the sweep as an index-ordered scan (default ASC matches the ORDER BY).
-- `IF NOT EXISTS` makes a re-apply harmless.
CREATE INDEX IF NOT EXISTS "members_erased_at_idx"
  ON "members" ("erased_at")
  WHERE "erased_at" IS NOT NULL;
