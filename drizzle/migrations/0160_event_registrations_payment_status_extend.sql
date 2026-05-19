-- F6.1 Option B+ (2026-05-18) — extend event_registrations.payment_status
-- CHECK constraint to mirror EventCreate's full Status enum.
--
-- Adds 'waitlisted' and 'no_show' so the CSV import can persist all
-- non-skipped statuses (Pending, Waitlisted, No Show) instead of
-- silently dropping them. Quota counting tightens elsewhere in the
-- Application layer (process-attendee-in-tx.ts applyQuotaEffect) to
-- only `paid` and `free` to preserve finance correctness — see
-- specs/013-csv-import-eventcreate-format/spec.md § FR-007 / FR-019.
--
-- Safety:
--   * Additive change — extends the allowlist; no existing row uses
--     the new values, so no backfill needed.
--   * Atomic DROP + ADD inside a single migration (Drizzle wraps each
--     migration file in a tx). Online for read traffic; brief AccessExclusiveLock
--     on the table while the constraint is rebuilt — F6 event_registrations
--     is small (~thousands at most) so the rebuild is sub-second.
--   * RLS + FORCE policies on the table are unaffected.
--
-- Rollback: IRREVERSIBLE while any persisted row has
--   `payment_status IN ('waitlisted','no_show')`. The 6-status enum
--   widens the contract — a pre-Option-B+ app rolled back against this
--   schema will hit zod enum-rejection on list queries. To roll back
--   schema: first UPDATE all `waitlisted` / `no_show` rows to a
--   pre-Option-B+ value (e.g. `pending`), THEN rebuild the CHECK
--   constraint with the original 4-value allowlist.

ALTER TABLE "event_registrations"
  DROP CONSTRAINT "event_registrations_payment_status_check";

ALTER TABLE "event_registrations"
  ADD CONSTRAINT "event_registrations_payment_status_check"
  CHECK ("payment_status" IN ('paid','pending','refunded','free','waitlisted','no_show'));
