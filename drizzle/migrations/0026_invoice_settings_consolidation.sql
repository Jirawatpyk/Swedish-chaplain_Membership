-- R7 Option-2 consolidation — Invoice Settings becomes the single
-- source of truth for tenant-level fiscal config.
--
-- Background (per F2 spec `specs/002-membership-plans/spec.md` US5 AS2):
--   F2 fee-config acknowledged that F4 would be the authoritative
--   owner of VAT at issue time. F4 shipped R7; tenant_fee_config
--   has since been carrying duplicate vat_rate + registration_fee
--   that drift against tenant_invoice_settings. Admin had TWO pages
--   editing the same logical values.
--
-- This migration (0026) is the "expand" half of an expand-and-
-- contract schema change. It does NOT drop any columns — that's
-- the 0027+ contract migration, deferred to R8 after R7 is verified
-- in prod.
--
-- What this migration does:
--   1. Add `currency_code text` to `tenant_invoice_settings`
--      (nullable at first — we backfill below, then tighten).
--   2. Backfill `tenant_invoice_settings.currency_code`,
--      `vat_rate`, `registration_fee_satang` from matching
--      `tenant_fee_config` rows. Only fills when the invoice-
--      settings value is NULL or default-seeded — we never
--      overwrite an admin's explicit invoice-settings edit.
--   3. Tighten `currency_code` to NOT NULL with fallback 'THB'
--      (SweCham default). Any tenant with a fee_config row picks
--      up its real currency via the backfill above; any tenant
--      without a fee_config row yet AND without an invoice-
--      settings row is unaffected (tenant_invoice_settings is
--      created on first admin save of Invoice Settings).
--
-- Rollback (if needed before 0027 lands): `ALTER TABLE
-- tenant_invoice_settings DROP COLUMN currency_code;`

-- 1. Add nullable column.
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "currency_code" text;

-- 2. Backfill from fee_config for existing rows.
--    Key scenarios:
--    (a) fee_config exists, invoice_settings exists → copy currency
--        + copy vat_rate / registration_fee when invoice-settings
--        values are the hardcoded default seed ("0.0700" / 0).
--    (b) fee_config exists, invoice_settings row doesn't → no-op
--        here; will be created on admin's first Invoice Settings
--        save, which the UI will prefill from fee_config.
UPDATE "tenant_invoice_settings" tis
SET
  "currency_code" = fc."currency_code",
  -- Only overwrite vat_rate when invoice-settings currently holds
  -- the hard-coded seed value 0.0700. Any other value means the
  -- admin has explicitly set it; preserve their intent.
  "vat_rate" = CASE
    WHEN tis."vat_rate" = '0.0700' AND fc."vat_rate" IS NOT NULL
      THEN fc."vat_rate"
    ELSE tis."vat_rate"
  END,
  -- Same conservative rule for registration_fee.
  "registration_fee_satang" = CASE
    WHEN tis."registration_fee_satang" = 0 AND fc."registration_fee_minor_units" IS NOT NULL
      THEN fc."registration_fee_minor_units"::bigint
    ELSE tis."registration_fee_satang"
  END
FROM "tenant_fee_config" fc
WHERE fc."tenant_id" = tis."tenant_id"
  AND tis."currency_code" IS NULL;

-- 3. Tighten NOT NULL with 'THB' fallback for any residual NULL.
UPDATE "tenant_invoice_settings"
  SET "currency_code" = 'THB'
  WHERE "currency_code" IS NULL;

ALTER TABLE "tenant_invoice_settings"
  ALTER COLUMN "currency_code" SET NOT NULL;

-- 4. Add a CHECK — ISO 4217 currency codes are exactly 3 uppercase
--    letters. Keeps bad writes out at the DB level so application
--    validation failures don't leak via a manual SQL path.
ALTER TABLE "tenant_invoice_settings"
  ADD CONSTRAINT "tenant_invoice_settings_currency_code_iso4217"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');
