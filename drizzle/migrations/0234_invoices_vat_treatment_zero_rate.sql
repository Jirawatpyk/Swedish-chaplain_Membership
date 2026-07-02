-- 088-invoice-tax-flow-redesign (T055 / US8 / FR-023..025 / data-model § F.8)
-- — per-invoice §80/1(5) embassy / int'l-org VAT zero-rate.
--
-- Adds the per-invoice VAT-treatment discriminator + the MFA (Protocol Dept)
-- certificate particulars to `invoices`, plus the two fail-closed CHECKs
-- (accepted-value gate + cert-required-when-zero-rated), and freezes the four
-- new columns in `invoices_enforce_immutability` (pinned at issue, immutable —
-- data-model § F.8.3 / FR-023).
--
--   - `vat_treatment`        — 'standard' (VAT 7%, membership + all defaults) or
--                              'zero_rated_80_1_5' (VAT 0% §80/1(5) embassy /
--                              int'l-org). NOT NULL DEFAULT 'standard' → every
--                              existing row backfills to 'standard' with no data
--                              change. DRIVES the VAT rate (FR-025 / G3).
--   - `zero_rate_cert_no`    — MFA note number (e.g. กต 0404/…). REQUIRED when
--                              zero-rated (fail-closed CHECK, FR-024).
--   - `zero_rate_cert_date`  — MFA note date (Gregorian ISO-8601 `date`; BE is
--                              display-only, CHK034).
--   - `zero_rate_cert_blob_key` — optional Vercel-Blob key of the cert scan
--                              (tax-document class, 10y, admin-only — G2).
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS +
-- re-ADD (pattern from 0203/0208/0211/0212/0231/0233). The `vat_treatment`
-- default makes both CHECKs pass for every existing row → NO backfill needed.
-- RLS: the four columns sit on the existing `invoices` table (RLS + FORCE) →
-- inherit tenant isolation with NO new policy (CHK033).
--
-- Migration ordering: filename number is the RESERVED 0234 (data-model § B.6),
-- but this migration APPLIES LAST (journal `when` = 1798536500000, after
-- 0236=…400000). The immutability function below is 0235's body VERBATIM (the
-- current live definition, which already froze bill_document_number_raw +
-- conditionally receipt_document_number_raw) plus FOUR added freeze legs in
-- BOTH the GUC-path and the normal-path lock lists. Re-apply note (repo
-- gotcha): CREATE OR REPLACE FUNCTION resets proconfig, so
-- `SET search_path = pg_catalog, public` is re-declared inline.

-- 1. Per-invoice VAT treatment (NOT NULL DEFAULT 'standard' → backfills every row).
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "vat_treatment" text NOT NULL DEFAULT 'standard';--> statement-breakpoint

-- 2. MFA certificate particulars (all nullable — populated only on a zero-rated bill).
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "zero_rate_cert_no" text;--> statement-breakpoint
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "zero_rate_cert_date" date;--> statement-breakpoint
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "zero_rate_cert_blob_key" text;--> statement-breakpoint

-- 3. Accepted-value gate (data-model § F.8.2).
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_vat_treatment_valid";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vat_treatment_valid" CHECK (
  vat_treatment IN ('standard', 'zero_rated_80_1_5')
);--> statement-breakpoint

-- 4. Fail-closed (FR-024): a zero-rated invoice MUST carry an MFA certificate number.
--    Every existing row has vat_treatment='standard' → left side true → satisfied.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_zero_rate_cert_required";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_zero_rate_cert_required" CHECK (
  vat_treatment <> 'zero_rated_80_1_5' OR zero_rate_cert_no IS NOT NULL
);--> statement-breakpoint

-- 4b. 088 US8 review fix (FR-023 layer 3 / data-model § F.8.2) — membership can
--     NEVER be zero-rated. The app-layer 422 `membership_cannot_be_zero_rated`
--     (issue-invoice.ts) is layer 2; this DB CHECK is the third defense-in-depth
--     layer FR-023 mandates, catching any writer that bypasses issueInvoice
--     (direct SQL / a future use-case). Additive: every existing row is
--     vat_treatment='standard' (NOT NULL DEFAULT), so a membership row satisfies
--     the right leg and a non-membership row the left → zero backfill.
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_membership_is_standard";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_membership_is_standard" CHECK (
  invoice_subject <> 'membership' OR vat_treatment = 'standard'
);--> statement-breakpoint

-- 5. Freeze vat_treatment + the three cert columns in invoices_enforce_immutability.
--    0235's function body VERBATIM + FOUR added legs in BOTH lock lists (the four
--    columns are pinned at draft→issued, then immutable — data-model § F.8.3). They
--    are numbering-class tax particulars, so they are ALSO frozen under the PII
--    redaction GUC path (never redactable — the cert is embassy/MFA evidence, not
--    member PII). Written at draft→issued (OLD.status='draft' → early-return
--    permits), locked after — same posture as document_number / bill_document_number_raw.
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
       OR NEW."vat_treatment"            IS DISTINCT FROM OLD."vat_treatment"
       OR NEW."zero_rate_cert_no"        IS DISTINCT FROM OLD."zero_rate_cert_no"
       OR NEW."zero_rate_cert_date"      IS DISTINCT FROM OLD."zero_rate_cert_date"
       OR NEW."zero_rate_cert_blob_key"  IS DISTINCT FROM OLD."zero_rate_cert_blob_key"
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
     OR NEW."vat_treatment"           IS DISTINCT FROM OLD."vat_treatment"
     OR NEW."zero_rate_cert_no"       IS DISTINCT FROM OLD."zero_rate_cert_no"
     OR NEW."zero_rate_cert_date"     IS DISTINCT FROM OLD."zero_rate_cert_date"
     OR NEW."zero_rate_cert_blob_key" IS DISTINCT FROM OLD."zero_rate_cert_blob_key"
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
