-- T166-01 — Async receipt PDF state machine.
--
-- Moves F4 receipt PDF generation off the Stripe webhook hot path. The
-- new state column tracks the async render lifecycle. Sequential
-- numbering + the `paid` flip stay inline in the webhook tx (Thai
-- Revenue Code §86/§87 atomicity); only the bytes go async.
--
-- Lifecycle:
--   pending  — invoice flipped to `paid`; outbox row enqueued; render
--              has NOT yet completed
--   rendered — worker uploaded the PDF + applied blob_key+sha256
--   failed   — render or upload failed; reconciliation cron retries
--              up to receipt_pdf_render_attempts < 3
--
-- Backfill: every existing `paid` row already passed through the prior
-- synchronous code path, so we mark them all `rendered` regardless of
-- whether the actual blob_key is populated (combined-mode invoices
-- intentionally have NULL receipt_pdf_blob_key — the receipt IS the
-- invoice PDF, see schema-invoices.ts comment at receiptPdfBlobKey).
--
-- See `specs/009-online-payment/plan.md` § Phase 9 sub-plan — T166.

DO $$ BEGIN
  CREATE TYPE "receipt_pdf_status_t" AS ENUM ('pending', 'rendered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "receipt_pdf_status" "receipt_pdf_status_t",
  ADD COLUMN IF NOT EXISTS "receipt_pdf_render_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "receipt_pdf_last_error" text;
--> statement-breakpoint

-- Backfill: every pre-migration `paid` row finished the synchronous
-- render path, so its receipt is rendered (even when blob_key is
-- intentionally NULL for combined-mode tenants). Idempotent — re-runs
-- skip rows already migrated.
UPDATE "invoices"
   SET "receipt_pdf_status" = 'rendered'
 WHERE "status" = 'paid'
   AND "receipt_pdf_status" IS NULL;
--> statement-breakpoint

-- Tax-document invariant: a `paid` row MUST have a render-status
-- regardless of whether blob_key is populated. The CHECK leaves
-- non-paid statuses (issued / void / draft / partially_credited /
-- credited) free to keep `receipt_pdf_status` NULL.
ALTER TABLE "invoices"
  DROP CONSTRAINT IF EXISTS "invoices_paid_has_receipt_status";
--> statement-breakpoint

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_paid_has_receipt_status"
  CHECK (
    "status" <> 'paid' OR "receipt_pdf_status" IS NOT NULL
  );
--> statement-breakpoint

-- Index used by the reconciliation cron (T166-11) to scan failed rows
-- needing retry. Partial index keeps it tiny — the vast majority of
-- rows are `rendered` and irrelevant to the reconciler.
CREATE INDEX IF NOT EXISTS "invoices_receipt_pdf_failed_idx"
  ON "invoices" ("receipt_pdf_render_attempts")
  WHERE "receipt_pdf_status" = 'failed';
--> statement-breakpoint

COMMENT ON COLUMN "invoices"."receipt_pdf_status" IS
  'T166 async-receipt-PDF state machine. NULL for non-paid rows; pending|rendered|failed for paid rows. Sequential numbering remains atomic with the paid flip (Thai Revenue Code §86/§87); only the PDF bytes are async.';
