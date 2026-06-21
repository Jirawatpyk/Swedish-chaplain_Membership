-- COMP-1 US3-B — GUC-gated PII-redaction exemption on the credit_notes
-- immutability trigger + a retryable PDF-blob purge marker.
--
-- WHY: the 10-year member-invoice retention sweeper
-- (`/api/cron/invoicing/redact-expired-member-invoices`) must tombstone the
-- buyer PII held in `credit_notes.member_identity_snapshot` once the §87/3
-- statutory retention window has elapsed. That column is locked from INSERT by
-- `credit_notes_enforce_immutability` (migration 0027), so a redaction UPDATE is
-- BLOCKED. This adds the SAME GUC arm the invoices trigger gained in 0205/0206:
-- under `app.allow_pii_redaction='true'` ONLY `member_identity_snapshot` +
-- `pii_blob_purged_at` may change; EVERY other column still RAISEs; the normal
-- path (GUC unset) locks everything INCLUDING the new marker.
--
-- SEARCH-PATH HARDENING: CREATE OR REPLACE FUNCTION RESETS the per-function
-- config set via ALTER FUNCTION (migration 0124 set search_path). Re-declare it
-- INLINE so the hardening survives (mirrors 0205/0206; the documented gotcha).

-- 1. The retryable purge marker. Nullable; set ONLY by the redaction cron after
--    a fully successful PDF-blob purge.
ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "pii_blob_purged_at" timestamptz;--> statement-breakpoint

-- 2. CREATE OR REPLACE the immutability trigger function with the GUC arm.
--    Body = migration 0027's lock list, split into a GUC-exempt branch (locks
--    all EXCEPT member_identity_snapshot + pii_blob_purged_at) + the normal
--    branch (locks all incl. member_identity_snapshot + pii_blob_purged_at).
--    The trigger binding (credit_notes_enforce_immutability_trg) is unchanged —
--    CREATE OR REPLACE keeps the same OID.
CREATE OR REPLACE FUNCTION "credit_notes_enforce_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- PII-redaction exemption: authorised ONLY when the sweeper has set
  -- `SET LOCAL app.allow_pii_redaction = 'true'`. Allows ONLY the two
  -- redaction-owned columns to change — member_identity_snapshot (buyer-PII
  -- tombstone) + pii_blob_purged_at (purge-completed marker) — while every
  -- other snapshot / numbering / money / pdf column stays immutable. `, true`
  -- makes current_setting return NULL (not error) when the GUC was never set.
  IF current_setting('app.allow_pii_redaction', true) = 'true' THEN
    IF NEW."original_invoice_id"        IS DISTINCT FROM OLD."original_invoice_id"
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
       OR NEW."pdf_blob_key"            IS DISTINCT FROM OLD."pdf_blob_key"
       OR NEW."pdf_sha256"              IS DISTINCT FROM OLD."pdf_sha256"
       OR NEW."pdf_template_version"    IS DISTINCT FROM OLD."pdf_template_version"
       -- `source_refund_id` (F5 migration 0038, added AFTER the 0027 trigger so
       -- it is NOT in 0027's lock list) is a §86/10 money-linkage FK on an issued
       -- tax doc. The allow-list-by-omission trigger would otherwise leave it
       -- MUTABLE under the GUC — LOCK it (thai-tax + security plan review). NOTE:
       -- created_at/updated_at are intentionally NOT locked (parity with the
       -- invoices trigger; updated_at legitimately bumps on the redaction UPDATE).
       OR NEW."source_refund_id"        IS DISTINCT FROM OLD."source_refund_id"
    THEN
      RAISE EXCEPTION 'credit_notes: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."credit_note_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — UNCHANGED lock set from migration 0027, PLUS the
  -- new pii_blob_purged_at marker (no normal write path may touch it). The
  -- original message is preserved so existing credit-note immutability tests match.
  IF NEW."original_invoice_id"       IS DISTINCT FROM OLD."original_invoice_id"
     OR NEW."fiscal_year"            IS DISTINCT FROM OLD."fiscal_year"
     OR NEW."sequence_number"        IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_number"        IS DISTINCT FROM OLD."document_number"
     OR NEW."issue_date"             IS DISTINCT FROM OLD."issue_date"
     OR NEW."issued_by_user_id"      IS DISTINCT FROM OLD."issued_by_user_id"
     OR NEW."reason"                 IS DISTINCT FROM OLD."reason"
     OR NEW."credit_amount_satang"   IS DISTINCT FROM OLD."credit_amount_satang"
     OR NEW."vat_satang"             IS DISTINCT FROM OLD."vat_satang"
     OR NEW."total_satang"           IS DISTINCT FROM OLD."total_satang"
     OR NEW."tenant_identity_snapshot" IS DISTINCT FROM OLD."tenant_identity_snapshot"
     OR NEW."member_identity_snapshot" IS DISTINCT FROM OLD."member_identity_snapshot"
     OR NEW."pdf_blob_key"           IS DISTINCT FROM OLD."pdf_blob_key"
     OR NEW."pdf_sha256"             IS DISTINCT FROM OLD."pdf_sha256"
     OR NEW."pdf_template_version"   IS DISTINCT FROM OLD."pdf_template_version"
     OR NEW."source_refund_id"       IS DISTINCT FROM OLD."source_refund_id"
     OR NEW."pii_blob_purged_at"     IS DISTINCT FROM OLD."pii_blob_purged_at"
  THEN
    RAISE EXCEPTION 'credit_notes: snapshot + money + pdf columns are immutable from INSERT (row id=%)', OLD."credit_note_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
