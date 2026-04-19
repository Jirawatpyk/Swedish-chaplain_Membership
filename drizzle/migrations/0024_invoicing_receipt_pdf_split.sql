-- F4 final-review C1 + H5 — split receipt PDF columns from invoice PDF columns.
--
-- Problem:
--   `applyPayment` was overwriting `pdf_blob_key` / `pdf_sha256` /
--   `pdf_template_version` with the RECEIPT PDF metadata, destroying
--   the ISSUE-time invoice PDF. After record-payment:
--     - admin clicking "Download" on a paid invoice got the receipt
--       (not the invoice)
--     - the invoice's sha256 (legal audit trail) was wiped
--
-- Fix:
--   Three new columns that carry the receipt PDF's metadata
--   INDEPENDENTLY of the invoice PDF metadata:
--     - receipt_pdf_blob_key      — Vercel Blob key for the receipt PDF
--     - receipt_pdf_sha256        — content hash of the receipt PDF
--     - receipt_pdf_template_version — template-registry pin
--
--   All three are nullable — null until record-payment sets them
--   (or permanently null for combined-mode tenants where the
--   receipt IS the invoice and no separate receipt PDF exists).
--
-- H5 — tighten `invoices_non_draft_has_snapshots` CHECK to include
-- `pdf_template_version` (was missing; DB allowed a partial state
-- where blob_key+sha256 were set but template_version was null,
-- making re-render impossible).

--> statement-breakpoint
ALTER TABLE "invoices"
  ADD COLUMN "receipt_pdf_blob_key" text,
  ADD COLUMN "receipt_pdf_sha256" char(64),
  ADD COLUMN "receipt_pdf_template_version" smallint;--> statement-breakpoint

-- Backfill: existing paid invoices that were issued BEFORE this
-- migration landed carry the receipt PDF in the invoice columns
-- (the pre-fix overwrite behaviour). Copy them over so "download
-- receipt" continues to work for historical rows.
-- We can tell a paid row had its pdf columns overwritten because
-- they point at a `_receipt_v` blob key.
UPDATE "invoices"
   SET "receipt_pdf_blob_key"      = "pdf_blob_key",
       "receipt_pdf_sha256"        = "pdf_sha256",
       "receipt_pdf_template_version" = "pdf_template_version"
 WHERE "status" = 'paid'
   AND "pdf_blob_key" LIKE '%\_receipt\_v%' ESCAPE '\';--> statement-breakpoint

-- H5 — tighten the non-draft snapshot CHECK to include
-- pdf_template_version so the DB rejects partial PDF states.
-- First backfill any null values on existing non-draft rows
-- (should be zero in practice, but defend against stale data).
UPDATE "invoices"
   SET "pdf_template_version" = 1
 WHERE "status" != 'draft'
   AND "pdf_template_version" IS NULL
   AND "pdf_blob_key" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "invoices_non_draft_has_snapshots";--> statement-breakpoint

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_non_draft_has_snapshots"
  CHECK (
    "status" = 'draft' OR (
      "subtotal_satang"           IS NOT NULL AND
      "vat_rate_snapshot"         IS NOT NULL AND
      "vat_satang"                IS NOT NULL AND
      "total_satang"              IS NOT NULL AND
      "fiscal_year"               IS NOT NULL AND
      "sequence_number"           IS NOT NULL AND
      "document_number"           IS NOT NULL AND
      "issue_date"                IS NOT NULL AND
      "due_date"                  IS NOT NULL AND
      "pro_rate_policy_snapshot"  IS NOT NULL AND
      "net_days_snapshot"         IS NOT NULL AND
      "tenant_identity_snapshot"  IS NOT NULL AND
      "member_identity_snapshot"  IS NOT NULL AND
      "pdf_blob_key"              IS NOT NULL AND
      "pdf_sha256"                IS NOT NULL AND
      "pdf_template_version"      IS NOT NULL
    )
  );--> statement-breakpoint
