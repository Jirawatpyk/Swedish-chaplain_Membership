-- R8-T4 (prep) — backfill missing invoice_settings rows from fee_config.
--
-- Background:
--   R7 Option-2 consolidation made `tenant_invoice_settings` the
--   authoritative source for VAT + currency + registration fee.
--   Migration 0026 backfilled currency_code + vat_rate +
--   registration_fee_satang for tenants that ALREADY had an
--   invoice_settings row. But tenants with fee_config and NO
--   invoice_settings were left untouched — and list-plans' fee_config
--   fallback keeps them working today.
--
--   To safely DROP tenant_fee_config in migration 0029, every tenant
--   that has fee_config MUST have an invoice_settings row. This
--   migration is the bridge.
--
-- Approach:
--   For every tenant_fee_config row that has NO matching
--   tenant_invoice_settings row, INSERT a minimum-viable row with:
--     - currency_code / vat_rate / registration_fee_satang copied
--       from fee_config
--     - All NOT NULL text fields populated with 'PENDING-SETUP'
--       placeholders that the admin MUST replace via
--       `/admin/settings/invoicing` before issuing any invoice
--       (`issue-invoice` use-case refuses when tax_id is literally
--       '0000000000000' — the seed placeholder — per spec FR-010).
--
--   Placeholders are deliberate:
--     tax_id = '0000000000000' (admin-recognisable "not set yet")
--     legal names / addresses = 'PENDING-SETUP' so any PDF rendered
--       without admin setup is obviously broken at a glance.
--
-- Rollback: DELETE FROM tenant_invoice_settings WHERE tax_id =
-- '0000000000000' AND legal_name_en = 'PENDING-SETUP';
-- (Deletes only the rows this migration inserted.)

INSERT INTO "tenant_invoice_settings" (
  "tenant_id",
  "currency_code",
  "vat_rate",
  "registration_fee_satang",
  "legal_name_th",
  "legal_name_en",
  "tax_id",
  "registered_address_th",
  "registered_address_en",
  "invoice_number_prefix",
  "credit_note_number_prefix",
  "receipt_numbering_mode",
  "fiscal_year_start_month",
  "default_net_days",
  "pro_rate_policy",
  "auto_email_enabled",
  "tenant_logo_count"
)
SELECT
  fc."tenant_id",
  fc."currency_code",
  fc."vat_rate",
  fc."registration_fee_minor_units"::bigint,
  'PENDING-SETUP',
  'PENDING-SETUP',
  '0000000000000',
  'PENDING-SETUP',
  'PENDING-SETUP',
  'INV',
  'CN',
  'combined',
  1,
  30,
  'monthly',
  TRUE,
  0
FROM "tenant_fee_config" fc
WHERE NOT EXISTS (
  SELECT 1 FROM "tenant_invoice_settings" tis
  WHERE tis."tenant_id" = fc."tenant_id"
);
