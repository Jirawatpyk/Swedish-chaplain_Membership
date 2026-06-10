-- 064-event-invoice-paid-flow (Task 2) — persist the MAIN PDF document kind
-- chosen at issue (§86/4 'invoice', combined §86/4+§105ทวิ 'receipt_combined',
-- §105 'receipt_separate').
--
-- WHY:
--   Downstream code (the J2 credit-note annotation re-render) must know
--   whether an invoice's main PDF is an invoice-titled or a receipt-titled
--   document, so it can never overwrite a receipt-titled original with an
--   invoice-titled re-render (10-year §87/3 evidence). No reliable derivation
--   exists from the current columns once future tasks change the issue gate,
--   so the kind is PERSISTED at issue time from now on.
--
-- BACKFILL RULE (matches what issue-invoice actually rendered):
--   - shipped 054 no-TIN event rows (invoice_subject='event' AND the buyer
--     snapshot carries no/blank tax_id) got a §105 'receipt_separate' main
--     PDF at issue;
--   - every other non-draft row got an 'invoice' main PDF.
--   Draft rows have NO main PDF yet → stay NULL (the issue path fills it).
--
-- IMMUTABILITY-TRIGGER NOTE (why the backfill UPDATE on non-draft rows is
-- NOT blocked): `invoices_enforce_immutability` (latest body: migration
-- 0207) raises only when a column in its explicit IS DISTINCT FROM lock
-- list changes; `pdf_doc_kind` is a NEW column and is not in that list, so
-- an UPDATE that touches ONLY `pdf_doc_kind` passes the trigger on both the
-- normal and the GUC-exempt path. No `app.allow_pii_redaction` bypass (the
-- migration-0205/0206 precedent) is needed here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the UPDATE re-targets only
-- still-NULL rows; DROP CONSTRAINT IF EXISTS + re-ADD lands the same final
-- predicate on a re-run (mirrors migrations 0203/0208).

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "pdf_doc_kind" text;--> statement-breakpoint

UPDATE "invoices" SET "pdf_doc_kind" =
  CASE WHEN "invoice_subject" = 'event'
        AND COALESCE(TRIM("member_identity_snapshot"->>'tax_id'), '') = ''
       THEN 'receipt_separate' ELSE 'invoice' END
WHERE "pdf_doc_kind" IS NULL AND "status" <> 'draft';--> statement-breakpoint

ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_pdf_doc_kind_valid";--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_doc_kind_valid"
  CHECK ("pdf_doc_kind" IS NULL OR "pdf_doc_kind" IN ('invoice','receipt_combined','receipt_separate'));--> statement-breakpoint

ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_non_draft_has_doc_kind";--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_non_draft_has_doc_kind"
  CHECK ("status" = 'draft' OR "pdf_doc_kind" IS NOT NULL);
