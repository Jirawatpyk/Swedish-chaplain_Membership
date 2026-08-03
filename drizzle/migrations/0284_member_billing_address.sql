-- ---------------------------------------------------------------------------
-- Migration 0284 — member-billing-address: OPTIONAL per-member billing
-- address for tax documents (customer request, operator-approved 2026-08-02).
--
-- WHY: a VAT-registrant buyer's ใบกำกับภาษี must carry their ภ.พ.20-
-- registered address while their operating/contact address (migration 0195
-- columns) differs. Complements the 088 buyer head-office/branch fields.
--
-- Mirrors the company address column set EXACTLY (0195 + 058's
-- sub_district), plus its OWN `billing_country` — the ภ.พ.20 address may
-- sit in a different country than the member's required `country`.
--
-- NO enable flag by design: "billing address set" ⟺
-- `billing_address_line1 IS NOT NULL`; clearing the admin form NULLs the
-- whole group.
--
-- `members_billing_address_group_ck` — DB backstop for the app-layer
-- all-or-nothing rule: when ANY field of the group is present, line1 +
-- city + postal_code + country must all be present (line2 / sub_district /
-- province stay individually optional inside an enabled group). A fully-
-- NULL group (the default for every existing member) passes.
--
-- `billing_country` carries an UPPERCASE ISO 3166-1 alpha-2 code (same
-- convention as `members.country`); format-checked here as a backstop —
-- the use-cases validate through the same `asIsoCountryCode` path as the
-- company `country`.
--
-- No new GRANT needed (0009's table-level grants extend to new columns);
-- no RLS change (policies are row-level tenant scoping).
--
-- PII NOTE: these are NEW PII columns — registered in the SAME lifecycle
-- paths as the company address in this change: `scrubPiiInTx` (GDPR
-- Art.17 / PDPA §33 erasure), the members-backup CSV + GDPR archive
-- export (Art.20), and the member self-view serialiser.
--
-- Idempotent — re-runs are no-ops via IF NOT EXISTS / duplicate_object.
-- Rollback:
--   ALTER TABLE members
--     DROP CONSTRAINT IF EXISTS members_billing_address_group_ck,
--     DROP CONSTRAINT IF EXISTS members_billing_country_format_ck,
--     DROP COLUMN billing_address_line1,
--     DROP COLUMN billing_address_line2,
--     DROP COLUMN billing_sub_district,
--     DROP COLUMN billing_city,
--     DROP COLUMN billing_province,
--     DROP COLUMN billing_postal_code,
--     DROP COLUMN billing_country;
-- ---------------------------------------------------------------------------

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS billing_address_line1 text,
  ADD COLUMN IF NOT EXISTS billing_address_line2 text,
  ADD COLUMN IF NOT EXISTS billing_sub_district text,
  ADD COLUMN IF NOT EXISTS billing_city text,
  ADD COLUMN IF NOT EXISTS billing_province text,
  ADD COLUMN IF NOT EXISTS billing_postal_code text,
  ADD COLUMN IF NOT EXISTS billing_country text;

DO $$
BEGIN
  ALTER TABLE members
    ADD CONSTRAINT members_billing_address_group_ck CHECK (
      (
        billing_address_line1 IS NULL
        AND billing_address_line2 IS NULL
        AND billing_sub_district IS NULL
        AND billing_city IS NULL
        AND billing_province IS NULL
        AND billing_postal_code IS NULL
        AND billing_country IS NULL
      )
      OR (
        billing_address_line1 IS NOT NULL
        AND billing_city IS NOT NULL
        AND billing_postal_code IS NOT NULL
        AND billing_country IS NOT NULL
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE members
    ADD CONSTRAINT members_billing_country_format_ck CHECK (
      billing_country IS NULL OR billing_country ~ '^[A-Z]{2}$'
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
