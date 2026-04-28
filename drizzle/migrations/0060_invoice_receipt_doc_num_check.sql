-- T166 R2-S1 — defensive CHECK constraint on receipt_document_number_raw.
-- The only writer is `applyPayment` which feeds from
-- `DocumentNumber.of(...).value.raw` (already validated), so the runtime
-- exposure is low. But adding a DB-level constraint:
--   * makes the §86/§87 invariant explicit at the schema level
--   * blocks operator manual UPDATE that bypasses the Domain validation
--   * gives forensic engineers a clear schema-doc'd format
-- Format: `{PREFIX}-{YYYY}-{NNNNNN}` matching `DocumentNumber.parse`
-- regex `^([A-Z][A-Z0-9]{0,7})-(\d{4})-(\d{6})$` (DocumentNumber.ts:80).

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS receipt_document_number_raw_format_check;
--> statement-breakpoint

ALTER TABLE invoices
  ADD CONSTRAINT receipt_document_number_raw_format_check
  CHECK (
    receipt_document_number_raw IS NULL
    OR receipt_document_number_raw ~ '^[A-Z][A-Z0-9]{0,7}-[0-9]{4}-[0-9]{6}$'
  );
