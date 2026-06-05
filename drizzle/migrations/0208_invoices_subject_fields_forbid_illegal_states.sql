-- 054-event-fee-invoices (speckit-review hardening, FIX A) — TIGHTEN
-- `invoices_subject_fields_ck` so the subject discriminator forbids the
-- OPPOSITE subject's columns and couples `vat_inclusive`. Makes illegal
-- states UN-representable at the database layer (type-design defence-in-depth).
--
-- WHY:
--   The migration-0201 CHECK only asserted the columns each subject MUST
--   carry. It did NOT forbid the other subject's columns, nor couple
--   `vat_inclusive`. So both of these illegal combinations PASSED the CHECK:
--     - invoice_subject='membership' WITH event_id / event_registration_id set
--     - invoice_subject='membership' WITH vat_inclusive = true
--   (and symmetrically an event row carrying plan_id / plan_year). The
--   use-cases always write correct rows, but a direct/regressed write could
--   persist a contradictory row that later confuses the doc-type / VAT logic.
--
-- WHAT CHANGES (the required-column assertions from 0201 are KEPT verbatim;
--               two NEGATIVE clauses are ADDED per subject):
--   membership ⇒ ... AND event_id IS NULL
--                    AND event_registration_id IS NULL
--                    AND vat_inclusive = false   (membership is VAT-EXCLUSIVE)
--   event      ⇒ ... AND plan_id IS NULL
--                    AND plan_year IS NULL
--   (vat_inclusive is NOT constrained for the event subject — an event ticket
--    may be priced VAT-inclusive (true) or VAT-exclusive (false); only the
--    membership subject pins it to false.)
--
-- PRE-APPLY SAFETY:
--   A tightened CHECK FAILS to apply (Postgres 23514) if ANY existing row
--   violates it. Before authoring this migration the tightened predicate was
--   run as a SELECT over `invoices` on live Neon Singapore — ZERO violating
--   rows out of 35 total. The use-cases always write member-only OR event-only
--   identity, so every existing row already satisfies the negative clauses.
--
-- Idempotent DROP IF EXISTS + re-ADD (mirrors migration 0203) so a re-run
-- lands the same final predicate.

DO $$
BEGIN
  ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_subject_fields_ck";

  ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_subject_fields_ck"
    CHECK (
      (invoice_subject = 'membership'
        AND member_id IS NOT NULL
        AND plan_id IS NOT NULL
        AND plan_year IS NOT NULL
        -- Forbid the EVENT subject's identity + VAT-inclusive pricing on a
        -- membership row (membership invoices are always VAT-EXCLUSIVE).
        AND event_id IS NULL
        AND event_registration_id IS NULL
        AND vat_inclusive = false)
      OR
      (invoice_subject = 'event'
        AND event_registration_id IS NOT NULL
        AND event_id IS NOT NULL
        -- Forbid the MEMBERSHIP subject's plan identity on an event row.
        AND plan_id IS NULL
        AND plan_year IS NULL)
    );
END $$;
