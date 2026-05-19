-- Repair migration for `tenant_invoice_settings.receipt_number_prefix`
-- (originally added by 0142). Two cleanups:
--
--   1. Idempotent column-add — 0142 used a plain ADD COLUMN which would
--      fail on re-run in a staging environment that was torn down and
--      re-created. This migration re-adds with `IF NOT EXISTS` so the
--      schema state converges either way (no-op on Neon where 0142 has
--      already applied).
--
--   2. Length CHECK — Application port + admin form validate the value
--      with `z.string().min(1).max(20)` but the DB had no enforcement.
--      Add a CHECK constraint mirroring the Application bound so
--      raw-SQL paths (bootstrap seed, manual repair) cannot insert
--      oversized values.
--
-- Both clauses are idempotent + zero-downtime on PostgreSQL — ADD COLUMN
-- IF NOT EXISTS is a metadata-only operation, and ADD CONSTRAINT (with
-- NOT VALID + VALIDATE-after) avoids a full-table scan lock. Single-row
-- per tenant means the scan cost is trivial regardless.

ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "receipt_number_prefix" text;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "tenant_invoice_settings"
    ADD CONSTRAINT "tenant_invoice_settings_receipt_number_prefix_length"
    CHECK (
      "receipt_number_prefix" IS NULL
      OR char_length("receipt_number_prefix") BETWEEN 1 AND 20
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
