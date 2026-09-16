-- 0303 — F114 Member Portal: Approval Workflow — the decision-reason CHECK
-- covers `partially_approved` too (post-ship `/code-review` #6 / T125).
--
-- FR-014: "a reason is required whenever ANY field is rejected". 0300 wrote
-- the DB's last line as
--
--   CHECK ("outcome" IS DISTINCT FROM 'rejected' OR "decision_reason" IS NOT NULL)
--
-- which only covers the WHOLE-request rejection. A `partially_approved`
-- decision rejects at least one field by definition (the use case refuses an
-- all-approved "partial"), so it owes the member the same reason — and the
-- decision email renders it. The use case already requires it; this closes the
-- gap in the last line, where a repo bug or a hand-written UPDATE lands.
--
-- Every other arm is UNCHANGED:
--   * `outcome IS NULL` (pending / withdrawn)  → `NULL NOT IN (…)` is NULL,
--     `NULL OR FALSE` is NULL, and a CHECK passes on NULL — exactly as the
--     0300 predicate behaved with `IS DISTINCT FROM`;
--   * `approved`        → the left arm is TRUE, reason optional;
--   * `rejected`        → reason required, as before.
--
-- DROP + ADD under the same name: the constraint is re-created, so PostgreSQL
-- validates every existing row as part of the ADD. The DO block below fails
-- FIRST and by name, so an operator reads `member_change_requests_partially_approved_without_reason`
-- instead of a bare 23514 from the ALTER. Production carries zero decided rows
-- with a missing reason (the use case has always required one), so this is a
-- metadata-only change there.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending
  FROM "member_change_requests"
  WHERE "outcome" = 'partially_approved' AND "decision_reason" IS NULL;

  IF offending > 0 THEN
    RAISE EXCEPTION 'member_change_requests_partially_approved_without_reason: % row(s)', offending
      USING ERRCODE = 'check_violation',
            HINT    = 'Backfill decision_reason on those rows (FR-014) before applying 0303.';
  END IF;
END$$;--> statement-breakpoint

ALTER TABLE "member_change_requests"
  DROP CONSTRAINT IF EXISTS "member_change_requests_reason_iff_rejected_ck";--> statement-breakpoint

ALTER TABLE "member_change_requests"
  ADD CONSTRAINT "member_change_requests_reason_iff_rejected_ck"
  CHECK ("outcome" NOT IN ('rejected', 'partially_approved') OR "decision_reason" IS NOT NULL);
