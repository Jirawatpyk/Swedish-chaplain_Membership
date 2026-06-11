-- 064-event-invoice-paid-flow (wave-3 remediation, S11) — lock `pdf_doc_kind`
-- in the `invoices_enforce_immutability` trigger function.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--   `pdf_doc_kind` (migration 0211) persists WHAT the rendered main PDF is —
--   the §86/4 document class ('invoice' ใบกำกับภาษี / 'receipt_combined'
--   ใบกำกับภาษี/ใบเสร็จรับเงิน / 'receipt_separate' §105 ใบเสร็จรับเงิน).
--   Every read surface (admin + portal download labels, void re-render title
--   via `voidUnderlyingKind`, credit-note annotatability gate) derives from
--   this column. It is written EXACTLY ONCE, in the draft→issued/paid
--   transition, and no legitimate writer ever updates it afterwards — yet the
--   trigger did not lock it, so a stray UPDATE could silently re-title a
--   live legal document into a different RD document class.
--
-- ── WRITER AUDIT (verified 2026-06-11 against drizzle-invoice-repo.ts) ──────
--   applyIssue / applyIssueAsPaid  — set pdf_doc_kind, but ONLY with a
--     `WHERE status='draft'` guard → the trigger's OLD.status='draft'
--     early-return exempts them. Unaffected.
--   applyPayment / applyReceiptPdf / applyReceiptPdfFailure — receipt_*
--     columns only. applyVoid — void_* + status only.
--   applyInvoicePdfRegeneration (J2 / void re-render) — pdf_sha256 only.
--   applyCreditNoteRollup — credited_total + status only.
--   redact-expired-event-buyers cron (GUC path) — tombstones
--     member_identity_snapshot + stamps pii_blob_purged_at only; the
--     document class must survive redaction → locked under the GUC too.
--
-- ── DIFF vs 0207 (verifiable) ────────────────────────────────────────────────
--   This function body is migration 0207's body COPIED VERBATIM, with EXACTLY
--   TWO added lines: `OR NEW."pdf_doc_kind" IS DISTINCT FROM
--   OLD."pdf_doc_kind"` appended to BOTH the GUC-path and the normal-path
--   IS DISTINCT FROM lists. Every other lock, the `OLD.status = 'draft'`
--   early-return, both RAISE messages, the inline `SET search_path`
--   hardening, the `current_setting(..., true)` NULL-safe GUC read, and the
--   trigger binding are UNCHANGED.
--
-- ── SEARCH-PATH HARDENING ───────────────────────────────────────────────────
--   `CREATE OR REPLACE FUNCTION` RESETS any per-function config previously set
--   via `ALTER FUNCTION` (migration 0124 set `search_path = pg_catalog, public`).
--   We therefore re-declare `SET search_path = pg_catalog, public` INLINE on the
--   function so the hardening survives this replace (mirrors 0205/0206/0207).

CREATE OR REPLACE FUNCTION "invoices_enforce_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;

  -- PII-redaction exemption: authorised ONLY when the retention sweeper has set
  -- `SET LOCAL app.allow_pii_redaction = 'true'` in its tx. Allows ONLY the two
  -- redaction-owned columns to change — `member_identity_snapshot` (buyer-PII
  -- tombstone) and `pii_blob_purged_at` (purge-completed marker, HIGH-3) —
  -- while EVERY other snapshot / numbering / financial / identity / event
  -- discriminator / document-class column stays immutable even during
  -- redaction. The `, true` arg to current_setting makes it return NULL (not
  -- error) when the GUC was never set in this session.
  IF current_setting('app.allow_pii_redaction', true) = 'true' THEN
    IF NEW."subtotal_satang"             IS DISTINCT FROM OLD."subtotal_satang"
       OR NEW."vat_rate_snapshot"        IS DISTINCT FROM OLD."vat_rate_snapshot"
       OR NEW."vat_satang"               IS DISTINCT FROM OLD."vat_satang"
       OR NEW."total_satang"             IS DISTINCT FROM OLD."total_satang"
       OR NEW."fiscal_year"              IS DISTINCT FROM OLD."fiscal_year"
       OR NEW."sequence_number"          IS DISTINCT FROM OLD."sequence_number"
       OR NEW."document_number"          IS DISTINCT FROM OLD."document_number"
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

  -- Normal path (GUC unset) — every snapshot/numbering/financial/identity/event
  -- discriminator column is locked, INCLUDING `member_identity_snapshot`, the
  -- redaction marker `pii_blob_purged_at` (no normal write path may set it),
  -- and the §86/4 document class `pdf_doc_kind` (written once at draft→X;
  -- never legitimately updated afterwards). The original message is preserved
  -- so the existing behavioural immutability tests keep matching it.
  IF NEW."subtotal_satang"            IS DISTINCT FROM OLD."subtotal_satang"
     OR NEW."vat_rate_snapshot"       IS DISTINCT FROM OLD."vat_rate_snapshot"
     OR NEW."vat_satang"              IS DISTINCT FROM OLD."vat_satang"
     OR NEW."total_satang"            IS DISTINCT FROM OLD."total_satang"
     OR NEW."fiscal_year"             IS DISTINCT FROM OLD."fiscal_year"
     OR NEW."sequence_number"         IS DISTINCT FROM OLD."sequence_number"
     OR NEW."document_number"         IS DISTINCT FROM OLD."document_number"
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
