-- 0302 — F114 Member Portal: Approval Workflow for Member Changes — the three
-- FK columns of `member_change_requests` that 0300 left UNINDEXED (PR-1
-- review, migration M-2; closed in PR-2). Each is the child side of a
-- composite FK, so a DELETE / UPDATE of the parent key runs the RI check as
-- a lookup on the child column — a seq scan of the whole table per parent
-- row without an index — and each is a join / filter key on a read path:
--
--   * `decided_by_user_id`      — the reviewer display join (queue, member
--                                 section, review page) and a future "decided
--                                 by X" filter; the F1 user-erasure sweep's
--                                 RI check on `users`;
--   * `submitted_by_contact_id` — the contact display join and the contact
--                                 hard-delete / erasure RI check on `contacts`;
--   * `replaced_by_request_id`  — the self-FK (`member_change_requests_replaced_by_fk`,
--                                 DEFERRABLE): the RI check on a request-row
--                                 delete (the member hard-delete FK chain) and
--                                 the "what replaced this" pointer walk.
--
-- Tenant-first, like every other index on the table (RLS filters on
-- tenant_id first, so the planner can use the leading column). The two
-- nullable columns are partial (`WHERE … IS NOT NULL`): a pending request has
-- no reviewer and most requests are never replaced, so the index stays small.
-- Plain CREATE INDEX (not CONCURRENTLY): the migration runner wraps a file in
-- a transaction, and the table is empty in production until the flag flips.
CREATE INDEX "member_change_requests_tenant_decided_by_idx"
  ON "member_change_requests" ("tenant_id", "decided_by_user_id")
  WHERE "decided_by_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "member_change_requests_tenant_submitted_by_contact_idx"
  ON "member_change_requests" ("tenant_id", "submitted_by_contact_id");--> statement-breakpoint
CREATE INDEX "member_change_requests_tenant_replaced_by_idx"
  ON "member_change_requests" ("tenant_id", "replaced_by_request_id")
  WHERE "replaced_by_request_id" IS NOT NULL;
