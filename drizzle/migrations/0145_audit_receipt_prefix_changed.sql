-- Add `tenant_receipt_prefix_changed` audit event type.
--
-- Emitted by `updateTenantInvoiceSettings` when an admin flips
-- `receipt_number_prefix` (and/or `invoice_number_prefix` /
-- `credit_note_number_prefix`) mid-fiscal-year. Thai RD §87 verifies
-- continuity by document number (prefix + year + sequence) — a prefix
-- change creates an apparent gap (e.g. RE-2026-000001 → RC-2026-000002
-- skips RC-2026-000001). The forensic trail (when, who, last seq under
-- old prefix) needs to be reconstructable from audit on a future RD
-- audit. 10-year retention class — tax-document touching.
--
-- Payload shape:
--   { old_invoice_prefix, new_invoice_prefix,
--     old_credit_note_prefix, new_credit_note_prefix,
--     old_receipt_prefix, new_receipt_prefix,
--     last_invoice_seq, last_credit_note_seq, last_receipt_seq,
--     fiscal_year, changed_fields }
--
-- A separate event (not just bundled inside
-- `tenant_invoice_settings_updated`) so a §87 forensic SELECT can
-- WHERE event_type = 'tenant_receipt_prefix_changed' to surface ALL
-- prefix flips in one query without parsing JSON payloads.

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'tenant_receipt_prefix_changed';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
