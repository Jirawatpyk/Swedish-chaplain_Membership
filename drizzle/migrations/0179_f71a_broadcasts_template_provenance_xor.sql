-- Migration 0179 — F7.1a US7 R8.4 close (R7 silent-failure-LOW-2)
--
-- Defense-in-depth CHECK constraint for the template-provenance XOR
-- invariant. Pre-R8.4 the invariant was application-layer only:
-- the Drizzle mapper at `deriveTemplateProvenance` returned null +
-- emitted `broadcasts.mapper.template_provenance_half_populated` at
-- error severity when EXACTLY ONE of the two columns was populated.
-- That gracefully degraded the affected row but silently undercounted
-- it in SIEM queries (the corrupt row appeared as "blank canvas").
--
-- This migration:
--   1. Backfills any half-populated rows by NULLing the non-orphaned
--      column. The mapper already treats half-populated as null, so
--      backfilling is semantically equivalent to what the application
--      already sees.
--   2. Adds a CHECK constraint enforcing "either-both-or-neither".
--      Future out-of-band writes that violate the invariant fail at
--      INSERT/UPDATE time with Postgres 23514 check_violation,
--      converting silent corruption-on-read into loud corruption-on-
--      write.
--
-- Rollback: DROP CONSTRAINT broadcasts_template_provenance_xor.
-- Application code remains forward-compatible (the mapper still
-- handles null without throwing).
--
-- NOTE: drizzle-kit migrate wraps each migration file in its own
-- transaction. Do NOT add `BEGIN;`/`COMMIT;` here — a nested BEGIN
-- triggers Postgres 25001 "there is already a transaction in progress"
-- and the migrator hangs.

-- Step 1 — backfill corrupt rows. The mapper already reports these
-- via the half-populated error log; the backfill aligns DB state to
-- what the application sees.
UPDATE broadcasts
   SET template_name_snapshot = NULL
 WHERE started_from_template_id IS NULL
   AND template_name_snapshot IS NOT NULL;

UPDATE broadcasts
   SET started_from_template_id = NULL
 WHERE started_from_template_id IS NOT NULL
   AND template_name_snapshot IS NULL;

-- Step 2 — add the XOR constraint. Mirrors the existing
-- `broadcasts_quota_year_only_on_sent` pattern at schema.ts:281-285
-- (two columns must be co-populated or co-null).
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_template_provenance_xor
  CHECK (
    (started_from_template_id IS NULL AND template_name_snapshot IS NULL)
    OR
    (started_from_template_id IS NOT NULL AND template_name_snapshot IS NOT NULL)
  );
