-- F6 round-6 staff-review fix B8 (2026-05-13) — tighten the
-- `event_registrations_non_member_no_quota` CHECK constraint to also
-- forbid `matched_contact_id` on `non_member` and `unmatched` rows.
--
-- Original 0128 constraint enforced `matched_member_id IS NULL` on
-- non_member/unmatched rows but did NOT constrain `matched_contact_id`.
-- A buggy write (e.g., a future relink-flow regression) could persist
-- an inconsistent state — unmatched row with a contact link — invisibly.
-- The data-model invariant (`data-model.md § Invariants`) implies the
-- tighter form: a contact-matched row must have `match_type =
-- 'member_contact'`; a non-member/unmatched row cannot legitimately hold
-- a `matched_contact_id`.
--
-- Safety: the constraint is replaced atomically inside a single
-- statement. If any pre-existing row violated the tightened predicate
-- the ALTER TABLE would fail; at SweCham scale (no F6 traffic yet —
-- ships dark behind FEATURE_F6_EVENTCREATE) this is empirically safe.
-- We do not protect with a probe-query first because the prior
-- constraint already enforces the harder half (member_id IS NULL) on
-- the same predicate, and there is no Application code path that
-- writes `matched_contact_id` without also setting `match_type` to
-- 'member_contact' (verified across the F6 Phase 3 ingest pipeline +
-- Phase 4 admin routes).

ALTER TABLE "event_registrations"
  DROP CONSTRAINT IF EXISTS "event_registrations_non_member_no_quota";

ALTER TABLE "event_registrations"
  ADD CONSTRAINT "event_registrations_non_member_no_quota"
  CHECK (
    "match_type" NOT IN ('non_member','unmatched')
    OR (
      "matched_member_id" IS NULL
      AND "matched_contact_id" IS NULL
      AND "counted_against_partnership" = false
      AND "counted_against_cultural_quota" = false
    )
  );
