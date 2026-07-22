-- ---------------------------------------------------------------------------
-- Bug 10 (money-remediation) — void §86/4 PDF re-stamp reconcile marker.
--
-- voidInvoice re-renders the VOID overlay in Phase 1 and uploads it best-effort
-- in Phase 2. When the Phase-2 blob upload FAILS (the blob_upload leg), the
-- served §86/4 keeps its ORIGINAL un-stamped bytes on a voided sale —
-- tax-dangerous, and undetectable by a sha-mismatch check (the stored sha still
-- matches the old bytes). These columns mark such a void for the
-- `void-pdf-reconcile` cron, which re-renders + re-uploads until the served doc
-- carries the VOID overlay.
--
--   pending_at  — set on a blob_upload-leg failure (COALESCE keeps the first).
--   attempts    — SQL-incremented per cron tick that fails (race-safe).
--   parked_at   — set ONLY on genuine corruption (no snapshot / render fault);
--                 transient infra failures retry indefinitely, so a voided doc
--                 is never abandoned un-stamped.
--
-- The partial index scans only actionable rows (pending, not parked). All three
-- columns are absent from the 0234 immutability freeze-list, so they are
-- writable on a `void` row (like pdf_sha256, which Phase 2 already syncs).
-- ---------------------------------------------------------------------------
ALTER TABLE "invoices"
  ADD COLUMN "void_pdf_reconcile_pending_at" timestamptz,
  ADD COLUMN "void_pdf_reconcile_attempts"   smallint NOT NULL DEFAULT 0,
  ADD COLUMN "void_pdf_reconcile_parked_at"  timestamptz;
--> statement-breakpoint
CREATE INDEX "invoices_void_pdf_reconcile_pending_idx"
  ON "invoices" ("void_pdf_reconcile_pending_at")
  WHERE "void_pdf_reconcile_pending_at" IS NOT NULL
    AND "void_pdf_reconcile_parked_at" IS NULL;
