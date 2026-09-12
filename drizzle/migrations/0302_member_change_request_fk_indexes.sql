-- 0302 — F114 Member Portal: Approval Workflow for Member Changes — the four
-- FK columns of `member_change_requests` that 0300 left UNINDEXED (PR-1
-- review, migration M-2; closed in PR-2; column orders corrected by the
-- PR-2 migration re-review BEFORE this file's first prod run — the 0300
-- precedent of editing in place). A DELETE / UPDATE of a parent key runs the
-- RI check as a lookup on the child column — a seq scan of the whole table
-- per parent row without an index. The lookup's shape decides the column
-- order:
--
--   * the two FKs to `users(id)` are SINGLE-column
--     (`member_change_requests_decided_by_user_fk`,
--     `member_change_requests_submitter_user_fk`): the RI check is
--     `WHERE $1 = decided_by_user_id` / `WHERE $1 = submitted_by_user_id` —
--     an equality on that column ALONE, so it must LEAD the index (a
--     tenant-first index cannot serve it: before PG 18 there is no skip scan,
--     and with one tenant a skip scan degenerates to a full index scan
--     anyway). The existing tenant-first indexes on `submitted_by_user_id`
--     (the partial unique + the rate window) do not serve it either. The
--     F1 pending-invite sweep bulk-deletes users, one RI check per row.
--   * the two COMPOSITE FKs (`…_submitter_contact_fk` →
--     `contacts(tenant_id, contact_id)`, `…_replaced_by_fk` →
--     `member_change_requests(tenant_id, id)`, DEFERRABLE): the RI check has
--     an equality on BOTH columns, so tenant-first is fine and matches the
--     table's other indexes.
--
-- The nullable columns are partial (`WHERE … IS NOT NULL`): a pending request
-- has no reviewer and most requests are never replaced, so the index stays
-- small; the RI check's `= $1` implies `IS NOT NULL`, so the planner can use
-- it. Plain CREATE INDEX (not CONCURRENTLY): the migration runner wraps the
-- pending batch in ONE transaction (CONCURRENTLY would error), and the table
-- is empty in production until the flag flips.
CREATE INDEX "member_change_requests_decided_by_tenant_idx"
  ON "member_change_requests" ("decided_by_user_id", "tenant_id")
  WHERE "decided_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "member_change_requests_submitted_by_user_idx"
  ON "member_change_requests" ("submitted_by_user_id");--> statement-breakpoint
CREATE INDEX "member_change_requests_tenant_submitted_by_contact_idx"
  ON "member_change_requests" ("tenant_id", "submitted_by_contact_id");--> statement-breakpoint
CREATE INDEX "member_change_requests_tenant_replaced_by_idx"
  ON "member_change_requests" ("tenant_id", "replaced_by_request_id")
  WHERE "replaced_by_request_id" IS NOT NULL;
