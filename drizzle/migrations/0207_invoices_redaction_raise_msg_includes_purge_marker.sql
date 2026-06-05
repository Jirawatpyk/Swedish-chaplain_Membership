-- 054-event-fee-invoices (round-2 code review, FIX 3) — correct the GUC-exempt
-- RAISE message in the `invoices_enforce_immutability` trigger function.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--   Migration 0206 made BOTH `member_identity_snapshot` AND `pii_blob_purged_at`
--   exempt under the redaction GUC (`app.allow_pii_redaction = 'true'`) — the
--   redaction flow stamps the purge marker alongside the buyer-PII tombstone.
--   But its GUC-path RAISE message still reads
--     'invoices: only member_identity_snapshot may change under PII redaction …'
--   naming only ONE of the two exempt columns. That is misleading to an operator
--   reading a failed-redaction error: it implies `pii_blob_purged_at` is locked
--   under the GUC when it is in fact exempt. This migration corrects the message
--   to name BOTH exempt columns. No BEHAVIOUR changes — only the text of the
--   exception raised when a NON-exempt column is touched under the GUC.
--
-- ── DIFF vs 0206 (verifiable) ────────────────────────────────────────────────
--   This function body is migration 0206's body COPIED VERBATIM, with EXACTLY
--   ONE change: the GUC-path RAISE EXCEPTION message string now reads
--     'invoices: only member_identity_snapshot and pii_blob_purged_at may change
--      under PII redaction (row id=%)'
--   Every lock (both the GUC-path and normal-path IS DISTINCT FROM lists,
--   including the 4 event columns + `pii_blob_purged_at`), the `OLD.status =
--   'draft'` early-return, the inline `SET search_path = pg_catalog, public`
--   hardening, the `current_setting(..., true)` NULL-safe GUC read, the
--   normal-path RAISE message ('snapshot columns are immutable …'), and the
--   trigger binding are UNCHANGED.
--
-- ── SEARCH-PATH HARDENING ───────────────────────────────────────────────────
--   `CREATE OR REPLACE FUNCTION` RESETS any per-function config previously set
--   via `ALTER FUNCTION` (migration 0124 set `search_path = pg_catalog, public`).
--   We therefore re-declare `SET search_path = pg_catalog, public` INLINE on the
--   function so the hardening survives this replace (mirrors migrations 0205/0206).

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
  -- discriminator column stays immutable even during redaction. The `, true`
  -- arg to current_setting makes it return NULL (not error) when the GUC was
  -- never set in this session.
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
    THEN
      RAISE EXCEPTION 'invoices: only member_identity_snapshot and pii_blob_purged_at may change under PII redaction (row id=%)', OLD."invoice_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — every snapshot/numbering/financial/identity/event
  -- discriminator column is locked, INCLUDING `member_identity_snapshot` and the
  -- redaction marker `pii_blob_purged_at` (no normal write path may set it). The
  -- original message is preserved so the existing behavioural immutability tests
  -- keep matching it.
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
  THEN
    RAISE EXCEPTION 'invoices: snapshot columns are immutable once status != draft (row id=%)', OLD."invoice_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
