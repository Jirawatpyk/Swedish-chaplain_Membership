-- 088-invoice-tax-flow-redesign (T006) — non-§87 bill number column + widened
-- numbering CHECKs + immutability lock (data-model § B.2 / § B.3).
--
-- Adds the pre-payment ใบแจ้งหนี้'s non-§87 `bill_document_number_raw` (SC), its
-- per-tenant partial unique index, widens the two numbering CHECKs so an issued
-- bill row (bill number, NULL sequence) AND a paid membership `receipt_combined`
-- row (RC receipt_document_number_raw, NULL sequence) both pass, and locks the
-- bill number in `invoices_enforce_immutability` (written once at draft→issued,
-- then frozen like `document_number`).
--
-- Widening CHECKs never rejects an existing row (the predicate only gains OR
-- legs), so no backfill/data change is required. Idempotent: ADD COLUMN IF NOT
-- EXISTS, CREATE INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + re-ADD
-- (pattern from 0203/0208/0211/0212).

-- 1. Non-§87 bill number column (NULL for drafts + all pre-088 rows).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "bill_document_number_raw" text;--> statement-breakpoint

-- 2. Per-tenant partial unique index — mirrors invoices_tenant_receipt_raw_uniq.
--    Disjoint from invoices_tenant_fiscal_seq_unique so a bill number can never
--    false-collide with a §87 tax number (SC-003).
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_tenant_bill_raw_uniq"
  ON "invoices" ("tenant_id", "bill_document_number_raw")
  WHERE "bill_document_number_raw" IS NOT NULL;--> statement-breakpoint

-- 3. invoices_draft_has_no_number — add the issued-bill leg.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_draft_has_no_number";--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_draft_has_no_number" CHECK (
  status = 'draft'
  OR sequence_number IS NOT NULL
  OR bill_document_number_raw IS NOT NULL
  OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL)
);--> statement-breakpoint

-- 4. invoices_non_draft_has_snapshots — add the bill-number leg (a) + widen the
--    receipt leg (b) by dropping its invoice_subject='event' gate (membership
--    receipt_combined now also carries receipt_document_number_raw with NULL
--    sequence). A paid membership legitimately satisfies BOTH legs (it carries
--    bill + receipt raw), which the OR permits. Every other snapshot/pdf leg is
--    unchanged.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_non_draft_has_snapshots";--> statement-breakpoint

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_non_draft_has_snapshots" CHECK (
  status = 'draft'
  OR (
    subtotal_satang IS NOT NULL
    AND vat_rate_snapshot IS NOT NULL
    AND vat_satang IS NOT NULL
    AND total_satang IS NOT NULL
    AND fiscal_year IS NOT NULL
    AND (
      (sequence_number IS NOT NULL AND document_number IS NOT NULL)
      OR (bill_document_number_raw IS NOT NULL
          AND sequence_number IS NULL AND document_number IS NULL)
      OR (receipt_document_number_raw IS NOT NULL
          AND sequence_number IS NULL AND document_number IS NULL)
    )
    AND issue_date IS NOT NULL
    AND due_date IS NOT NULL
    AND (pro_rate_policy_snapshot IS NOT NULL OR invoice_subject = 'event')
    AND net_days_snapshot IS NOT NULL
    AND tenant_identity_snapshot IS NOT NULL
    AND member_identity_snapshot IS NOT NULL
    AND pdf_blob_key IS NOT NULL
    AND pdf_sha256 IS NOT NULL
    AND pdf_template_version IS NOT NULL
  )
);--> statement-breakpoint

-- 5. Lock `bill_document_number_raw` in invoices_enforce_immutability.
--    This is migration 0214's function body COPIED VERBATIM with EXACTLY TWO
--    added lines — `OR NEW."bill_document_number_raw" IS DISTINCT FROM
--    OLD."bill_document_number_raw"` appended to BOTH the GUC-path and the
--    normal-path lock lists (a bill number is a numbering field — it must stay
--    immutable after issue AND survive PII redaction). Every other lock, the
--    OLD.status='draft' early-return, both RAISE messages, and the inline
--    SET search_path (survives CREATE OR REPLACE — migration 0124 hardening)
--    are UNCHANGED.
CREATE OR REPLACE FUNCTION "invoices_enforce_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.allow_pii_redaction', true) = 'true' THEN
    IF NEW."subtotal_satang"             IS DISTINCT FROM OLD."subtotal_satang"
       OR NEW."vat_rate_snapshot"        IS DISTINCT FROM OLD."vat_rate_snapshot"
       OR NEW."vat_satang"               IS DISTINCT FROM OLD."vat_satang"
       OR NEW."total_satang"             IS DISTINCT FROM OLD."total_satang"
       OR NEW."fiscal_year"              IS DISTINCT FROM OLD."fiscal_year"
       OR NEW."sequence_number"          IS DISTINCT FROM OLD."sequence_number"
       OR NEW."document_number"          IS DISTINCT FROM OLD."document_number"
       OR NEW."bill_document_number_raw" IS DISTINCT FROM OLD."bill_document_number_raw"
       OR NEW."issue_date"               IS DISTINCT FROM OLD."issue_date"
       OR NEW."due_date"                 IS DISTINCT FROM OLD."due_date"
       OR NEW."pro_rate_policy_snapshot" IS DISTINCT FROM OLD."pro_rate_policy_snapshot"
       OR NEW."net_days_snapshot"        IS DISTINCT FROM OLD."net_days_snapshot"
       OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
       OR NEW."member_id"                IS DISTINCT FROM OLD."member_id"
       OR NEW."plan_id"                  IS DISTINCT FROM OLD."plan_id"
       OR NEW."plan_year"                IS DISTINCT FROM OLD."plan_year"
       OR NEW."invoice_subject"          IS DISTINCT FROM OLD."invoice_subject"
       OR NEW."event_id"                 IS DISTINCT FROM OLD."event_id"
       OR NEW."event_registration_id"    IS DISTINCT FROM OLD."event_registration_id"
       OR NEW."vat_inclusive"            IS DISTINCT FROM OLD."vat_inclusive"
       OR NEW."pdf_doc_kind"             IS DISTINCT FROM OLD."pdf_doc_kind"
    THEN
      RAISE EXCEPTION 'invoices: only member_identity_snapshot and pii_blob_purged_at may change under PII redaction (row id=%)', OLD."invoice_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."subtotal_satang"            IS DISTINCT FROM OLD."subtotal_satang"
     OR NEW."vat_rate_snapshot"       IS DISTINCT FROM OLD."vat_rate_snapshot"
     OR NEW."vat_satang"              IS DISTINCT FROM OLD."vat_satang"
     OR NEW."total_satang"            IS DISTINCT FROM OLD."total_satang"
     OR NEW."fiscal_year"             IS DISTINCT FROM OLD."fiscal_year"
     OR NEW."sequence_number"         IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_number"         IS DISTINCT FROM OLD."document_number"
     OR NEW."bill_document_number_raw" IS DISTINCT FROM OLD."bill_document_number_raw"
     OR NEW."issue_date"              IS DISTINCT FROM OLD."issue_date"
     OR NEW."due_date"                IS DISTINCT FROM OLD."due_date"
     OR NEW."pro_rate_policy_snapshot" IS DISTINCT FROM OLD."pro_rate_policy_snapshot"
     OR NEW."net_days_snapshot"       IS DISTINCT FROM OLD."net_days_snapshot"
     OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
     OR NEW."member_identity_snapshot" IS DISTINCT FROM OLD."member_identity_snapshot"
     OR NEW."member_id"               IS DISTINCT FROM OLD."member_id"
     OR NEW."plan_id"                 IS DISTINCT FROM OLD."plan_id"
     OR NEW."plan_year"               IS DISTINCT FROM OLD."plan_year"
     OR NEW."invoice_subject"         IS DISTINCT FROM OLD."invoice_subject"
     OR NEW."event_id"                IS DISTINCT FROM OLD."event_id"
     OR NEW."event_registration_id"   IS DISTINCT FROM OLD."event_registration_id"
     OR NEW."vat_inclusive"           IS DISTINCT FROM OLD."vat_inclusive"
     OR NEW."pii_blob_purged_at"      IS DISTINCT FROM OLD."pii_blob_purged_at"
     OR NEW."pdf_doc_kind"            IS DISTINCT FROM OLD."pdf_doc_kind"
  THEN
    RAISE EXCEPTION 'invoices: snapshot columns are immutable once status != draft (row id=%)', OLD."invoice_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
