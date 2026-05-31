-- Migration 0195 — F3 members postal address (structured, optional).
--
-- Adds street-level address columns to `members`. The 2-letter `country`
-- (ISO 3166-1 alpha-2) already exists; these hold the rest of the address.
-- All nullable — existing members carry no address. Optional per the
-- product decision (2026-05-29): the address is never required on
-- create/edit.
--
-- No new GRANT needed: migration 0009 granted table-level
-- SELECT/INSERT/UPDATE/DELETE on `members` to `chamber_app`, which
-- Postgres extends to columns added later. No RLS change either — the
-- members policies are row-level (tenant scoping) and are unaffected by
-- new columns.
--
-- Idempotent — re-runs are no-ops via `IF NOT EXISTS`.
-- Rollback:
--   ALTER TABLE members
--     DROP COLUMN address_line1,
--     DROP COLUMN address_line2,
--     DROP COLUMN city,
--     DROP COLUMN province,
--     DROP COLUMN postal_code;

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS postal_code text;
