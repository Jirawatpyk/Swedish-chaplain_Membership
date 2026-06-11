-- 064-event-invoice-paid-flow (Task 9, β numbering) — an as-paid no-TIN EVENT
-- invoice is a §105 receipt: its number comes from the RECEIPT stream and
-- lives in receipt_document_number_raw; the invoice-stream pair
-- sequence_number/document_number must BOTH be NULL — the relaxed leg
-- requires this explicitly, so a half-pair row (a §87 sequence slot consumed
-- without a document number, or vice versa) can never slip through it.
-- The invoices_tenant_fiscal_seq_unique index (tenant_id, fiscal_year,
-- sequence_number) has NO stream discriminator, so a receipt-stream number
-- occupying sequence_number would collide with invoice-stream numbers in the
-- same (tenant, fiscal_year) bucket — receipt numbers must never live there.
--
-- CONDITIONAL relax of the two numbering CHECKs. Live predicates verified
-- against the deployed DB via pg_get_constraintdef on 2026-06-10:
--   * invoices_non_draft_has_snapshots == migration 0203's definition
--     (no later amendment exists);
--   * invoices_draft_has_no_number    == migration 0019's definition.
--
-- WHAT CHANGES:
--   invoices_non_draft_has_snapshots — the
--     `sequence_number IS NOT NULL AND document_number IS NOT NULL`
--   legs become:
--     ((sequence_number IS NOT NULL AND document_number IS NOT NULL)
--      OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL
--          AND sequence_number IS NULL AND document_number IS NULL))
--   EVERY other leg — including the 0203 pro_rate event carve-out — is
--   preserved exactly as deployed.
--
--   invoices_draft_has_no_number — the receipt-stream OR leg appended WITHOUT
--   the two IS NULL conjuncts (they are vacuous here: any row with
--   sequence_number set already passes via the preceding OR leg, so the
--   conjuncts could never change this CHECK's outcome):
--     ("status" = 'draft' OR sequence_number IS NOT NULL
--      OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL))
--
-- Every OTHER non-draft row (membership on any path, event on the TIN path)
-- still requires the invoice-stream pair: the relax is scoped to
-- (event subject AND receipt number present), never blanket. Relax-only —
-- both new predicates are strictly weaker, so the ADD-time validation scan
-- over existing rows cannot fail.
--
-- Idempotent DO-block style (mirrors migration 0203): DROP IF EXISTS +
-- re-ADD so a re-run lands the same final predicate.

DO $$
BEGIN
  ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_non_draft_has_snapshots";

  ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_non_draft_has_snapshots"
    CHECK (
      status = 'draft'
      OR (
        subtotal_satang IS NOT NULL
        AND vat_rate_snapshot IS NOT NULL
        AND vat_satang IS NOT NULL
        AND total_satang IS NOT NULL
        AND fiscal_year IS NOT NULL
        AND (
          (sequence_number IS NOT NULL AND document_number IS NOT NULL)
          -- 064 Task 9 (beta): as-paid no-TIN event = S105 receipt numbered
          -- from the receipt stream; the invoice-stream pair must BOTH be
          -- NULL (a half-pair would be a S87 sequence slot consumed without
          -- a document number).
          OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL
              AND sequence_number IS NULL AND document_number IS NULL)
        )
        AND issue_date IS NOT NULL
        AND due_date IS NOT NULL
        -- Membership-only: pro-rating has no meaning for an event ticket fee.
        AND (pro_rate_policy_snapshot IS NOT NULL OR invoice_subject = 'event')
        AND net_days_snapshot IS NOT NULL
        AND tenant_identity_snapshot IS NOT NULL
        AND member_identity_snapshot IS NOT NULL
        AND pdf_blob_key IS NOT NULL
        AND pdf_sha256 IS NOT NULL
        AND pdf_template_version IS NOT NULL
      )
    );

  ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_draft_has_no_number";

  ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_draft_has_no_number"
    CHECK (
      "status" = 'draft'
      OR sequence_number IS NOT NULL
      OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL)
    );
END $$;
