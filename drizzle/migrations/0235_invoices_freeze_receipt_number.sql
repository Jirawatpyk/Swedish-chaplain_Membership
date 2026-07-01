-- 088-invoice-tax-flow-redesign — US1 review-hardening (security INFO).
--
-- Freeze the §87 `RC` receipt number (`receipt_document_number_raw`) in the
-- `invoices_enforce_immutability` trigger, SYMMETRIC with `document_number` /
-- `bill_document_number_raw`. Before this, a minted RC (a Thai RD §87 tax
-- number) on a `paid` row could be silently UPDATEd — a §87 integrity hole.
--
-- Subtlety vs `document_number`: the bill/§87 invoice numbers are written at the
-- draft→issued UPDATE (OLD.status='draft' → the trigger's early-return permits
-- it, then locks). The RC is written LATER, at the issued→paid UPDATE
-- (`applyPayment`), when OLD.status='issued' (non-draft) — so an unconditional
-- lock would REJECT the legitimate NULL→RC write. The freeze therefore fires
-- ONLY when the field was already set (`OLD.receipt_document_number_raw IS NOT
-- NULL`): the first NULL→RC write at payment is permitted, every subsequent
-- change is a check_violation. Added to BOTH the PII-redaction GUC path and the
-- normal path (an RC is a §87 tax number, never redactable). Migration 0235 —
-- 0232/0233/0234 are reserved for US3/US5/US8 (unbuilt); next free = 0236.
--
-- Re-apply note (repo gotcha): CREATE OR REPLACE FUNCTION resets proconfig, so
-- `SET search_path = pg_catalog, public` is re-declared inline (0231 verbatim +
-- the two freeze legs). Body is byte-identical to 0231 except the additions.
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
       OR (NEW."receipt_document_number_raw" IS DISTINCT FROM OLD."receipt_document_number_raw"
           AND OLD."receipt_document_number_raw" IS NOT NULL)
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
     OR (NEW."receipt_document_number_raw" IS DISTINCT FROM OLD."receipt_document_number_raw"
         AND OLD."receipt_document_number_raw" IS NOT NULL)
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
