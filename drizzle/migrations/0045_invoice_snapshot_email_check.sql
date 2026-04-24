-- Migration 0045 — F4 member_identity_snapshot completeness CHECK
--
-- T082 architect review 2026-04-24: the Domain type
-- `MemberIdentitySnapshot` declares `primary_contact_email: string`
-- (non-nullable) but jsonb columns have no schema enforcement at DB
-- layer — TypeScript type safety stops at the repo row→Domain
-- boundary. A legacy E2E fixture seed produced three non-draft
-- invoices whose snapshot was missing the field entirely, which
-- crashed F5's webhook-driven `recordPayment` with a Postgres
-- "syntax error at or near ','" when Drizzle tried to splice
-- `undefined` into the auto-email INSERT.
--
-- Two-part hardening:
--
--   1. BACKFILL — patch the three known legacy rows so the CHECK
--      constraint below can be added without rejecting the existing
--      dataset. The emails are reconstructed from the F3 member's
--      primary contact (which has always been complete). Wrapped in
--      a trigger-disable block because the `invoices_enforce_immutability_trg`
--      forbids mutating snapshot columns on non-draft rows — which
--      is exactly what we need to do ONCE to fix the drift.
--
--   2. CHECK CONSTRAINT — prevent the same class of bug from re-
--      entering the data: every non-draft invoice must carry a
--      `primary_contact_email` key whose value is a JSON string.
--      Draft rows are exempted because issue-time is where the
--      snapshot is finalized.
--
-- Paired runtime enforcement: `memberIdentitySnapshotSchema` at the
-- `DrizzleInvoiceRepo.rowsToInvoice` boundary (zod) for catching
-- post-CHECK drift + any future Domain-type extension that forgets
-- to update this migration.
--
-- Next step after this migration: the belt-and-suspenders F5 guard
-- in `recordPayment` can be removed after 2 clean release cycles.

BEGIN;

-- Step 1: Disable immutability trigger SESSION-LOCALLY so the
-- backfill UPDATE can touch snapshot columns. The trigger was added
-- in migration 0019 (`invoices_enforce_immutability_trg`) to stop
-- post-draft snapshot drift; we legitimately need to correct
-- historical drift here, so we turn it off for the scope of THIS
-- transaction only.
ALTER TABLE "invoices" DISABLE TRIGGER "invoices_enforce_immutability_trg";

-- Step 2: Backfill the three legacy E2E rows + any other non-draft
-- invoice where the snapshot is incomplete. Source email from
-- contacts table via the invoice's member_id. Matches the default
-- the frozen snapshot should have carried at issue time.
UPDATE "invoices" inv
SET "member_identity_snapshot" = inv."member_identity_snapshot" || jsonb_build_object(
  'primary_contact_email', COALESCE(
    (inv."member_identity_snapshot"->>'primary_contact_email'),
    (SELECT c."email" FROM "contacts" c
      WHERE c."member_id" = inv."member_id"
        AND c."is_primary" = TRUE
        AND c."removed_at" IS NULL
      LIMIT 1),
    'unknown@backfill.invalid'
  ),
  'primary_contact_name', COALESCE(
    (inv."member_identity_snapshot"->>'primary_contact_name'),
    (SELECT (c."first_name" || ' ' || c."last_name") FROM "contacts" c
      WHERE c."member_id" = inv."member_id"
        AND c."is_primary" = TRUE
        AND c."removed_at" IS NULL
      LIMIT 1),
    'Unknown (backfilled)'
  ),
  'legal_name', COALESCE(
    (inv."member_identity_snapshot"->>'legal_name'),
    (inv."member_identity_snapshot"->>'company_name'),
    'Unknown (backfilled)'
  ),
  'address', COALESCE(
    (inv."member_identity_snapshot"->>'address'),
    'Unknown (backfilled)'
  )
)
WHERE "status" != 'draft'
  AND (
    NOT ("member_identity_snapshot" ? 'primary_contact_email')
    OR NOT ("member_identity_snapshot" ? 'primary_contact_name')
    OR NOT ("member_identity_snapshot" ? 'legal_name')
    OR NOT ("member_identity_snapshot" ? 'address')
  );

-- Step 3: Re-enable immutability trigger BEFORE adding the CHECK so
-- the CHECK doesn't fire during the re-enable's implicit validation.
ALTER TABLE "invoices" ENABLE TRIGGER "invoices_enforce_immutability_trg";

-- Step 4: Add the CHECK constraint. The `NOT VALID` then `VALIDATE`
-- two-step is unnecessary here because Step 2 has already
-- normalized the whole table, but we still use `NOT VALID` +
-- `VALIDATE` as a defensive belt so a partial migration (e.g.
-- interrupted deploy) leaves the DB in a legible state.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_snapshot_has_contact_email" CHECK (
  "status" = 'draft' OR (
    "member_identity_snapshot" ? 'primary_contact_email'
    AND jsonb_typeof("member_identity_snapshot"->'primary_contact_email') = 'string'
    AND "member_identity_snapshot" ? 'primary_contact_name'
    AND jsonb_typeof("member_identity_snapshot"->'primary_contact_name') = 'string'
    AND "member_identity_snapshot" ? 'legal_name'
    AND jsonb_typeof("member_identity_snapshot"->'legal_name') = 'string'
    AND "member_identity_snapshot" ? 'address'
    AND jsonb_typeof("member_identity_snapshot"->'address') = 'string'
  )
) NOT VALID;

ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_snapshot_has_contact_email";

COMMIT;
