-- R7-S6 (R8-T2) — credit_notes immutability trigger.
--
-- Background:
--   `invoices` has a BEFORE UPDATE trigger
--   (`invoices_enforce_immutability_trg`, migration 0019) that
--   rejects UPDATEs on snapshot + money + identity columns once the
--   row leaves draft state. `credit_notes` is a single-state
--   aggregate — it's born issued, no draft phase — so its snapshot
--   fields should be immutable from the INSERT onward.
--
--   The R7 staff review flagged the asymmetry (S6). A DB-owner error
--   or a future code path that accidentally UPDATEs `credit_notes`
--   would silently mutate §87 tax-side data without this trigger.
--
-- Scope: every column whose value is the legal record for this tax
-- document — if any of these change after INSERT, the document chain
-- (invoice → receipt → credit note) loses integrity.

CREATE OR REPLACE FUNCTION "credit_notes_enforce_immutability"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."original_invoice_id"       IS DISTINCT FROM OLD."original_invoice_id"
     OR NEW."fiscal_year"             IS DISTINCT FROM OLD."fiscal_year"
     OR NEW."sequence_number"         IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_number"         IS DISTINCT FROM OLD."document_number"
     OR NEW."issue_date"              IS DISTINCT FROM OLD."issue_date"
     OR NEW."issued_by_user_id"       IS DISTINCT FROM OLD."issued_by_user_id"
     OR NEW."reason"                  IS DISTINCT FROM OLD."reason"
     OR NEW."credit_amount_satang"    IS DISTINCT FROM OLD."credit_amount_satang"
     OR NEW."vat_satang"              IS DISTINCT FROM OLD."vat_satang"
     OR NEW."total_satang"            IS DISTINCT FROM OLD."total_satang"
     OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
     OR NEW."member_identity_snapshot" IS DISTINCT FROM OLD."member_identity_snapshot"
     OR NEW."pdf_blob_key"            IS DISTINCT FROM OLD."pdf_blob_key"
     OR NEW."pdf_sha256"              IS DISTINCT FROM OLD."pdf_sha256"
     OR NEW."pdf_template_version"    IS DISTINCT FROM OLD."pdf_template_version"
  THEN
    RAISE EXCEPTION 'credit_notes: snapshot + money + pdf columns are immutable from INSERT (row id=%)', OLD."credit_note_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "credit_notes_enforce_immutability_trg"
  BEFORE UPDATE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION "credit_notes_enforce_immutability"();
