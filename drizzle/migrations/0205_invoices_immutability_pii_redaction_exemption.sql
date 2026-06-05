-- 054-event-fee-invoices (Task 15) — GUC-gated PII-redaction exemption on the
-- `invoices_enforce_immutability` trigger function.
--
-- WHY:
--   The retention sweeper (`/api/cron/invoicing/redact-expired-event-buyers`)
--   must tombstone the buyer PII held in `member_identity_snapshot` on a
--   NON-MEMBER event invoice once its §86/10 + §87/3 statutory retention window
--   (10 years) has elapsed (GDPR Art. 5(1)(e) / Art. 17 minimisation). But that
--   column is locked by `invoices_enforce_immutability` the moment the invoice
--   leaves `draft` — so a naive redaction UPDATE on an issued row is BLOCKED.
--
-- WHAT CHANGES (narrow, GUC-gated, member_identity_snapshot ONLY):
--   A new exemption branch runs AFTER the existing `OLD.status='draft'`
--   early-return and BEFORE the normal immutability check. It fires ONLY when
--   the session GUC `app.allow_pii_redaction` is exactly the string 'true'
--   (the cron sets `SET LOCAL app.allow_pii_redaction = 'true'` inside its tx;
--   `SET LOCAL` auto-resets at tx end, mirroring the `app.current_tenant`
--   pattern in `runInTenant`). Inside that branch EVERY snapshot / numbering /
--   financial / identity column EXCEPT `member_identity_snapshot` is still
--   checked for IS DISTINCT FROM and a change to any of them RAISES — so the
--   exemption can ONLY ever change the buyer PII tombstone, never the money,
--   the §87 document number, the dates, or the tenant identity snapshot.
--
--   When the GUC is unset / not 'true' (the production default for every normal
--   write path), the function falls through to the UNCHANGED normal-path check
--   that still locks `member_identity_snapshot` along with all the other
--   columns and RAISES the original 'snapshot columns are immutable …' message.
--   The existing membership-immutability behavioural tests
--   (settings-form.test.ts) therefore stay green.
--
-- WHO SETS THE GUC: ONLY the redaction cron, via `SET LOCAL
--   app.allow_pii_redaction = 'true'`. No other code path sets it (verified by
--   repo grep). A hostile or buggy caller cannot reach it without first issuing
--   that SET LOCAL inside an open tx running as `chamber_app`; even then it can
--   only mutate the single buyer-PII column.
--
-- SEARCH-PATH HARDENING: `CREATE OR REPLACE FUNCTION` RESETS any per-function
--   config previously applied via `ALTER FUNCTION` (migration 0124 set
--   `search_path = pg_catalog, public`). We therefore re-declare the
--   `SET search_path = pg_catalog, public` clause INLINE on the function so the
--   hardening survives this replace (otherwise the function would silently
--   regress to the session search_path — the exact regression 0124 prevents).
--
-- The function body below is the canonical immutability check from migration
-- 0019 § invoices (the full 16-column list), with the GUC-gated exemption
-- branch inserted. The trigger binding (`invoices_enforce_immutability_trg`)
-- is unchanged — CREATE OR REPLACE keeps the same function OID so the existing
-- BEFORE UPDATE trigger continues to fire it.

CREATE OR REPLACE FUNCTION "invoices_enforce_immutability"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;

  -- PII-redaction exemption (Task 15): authorised ONLY when the retention
  -- sweeper has set `SET LOCAL app.allow_pii_redaction = 'true'` in its tx.
  -- Allows ONLY `member_identity_snapshot` to change (the buyer-PII tombstone);
  -- EVERY other snapshot / numbering / financial / identity column stays
  -- immutable even during redaction. The `, true` arg to current_setting makes
  -- it return NULL (not error) when the GUC was never set in this session.
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
    THEN
      RAISE EXCEPTION 'invoices: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."invoice_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — UNCHANGED from migration 0019. member_identity_snapshot
  -- is locked here exactly as before; the original message is preserved so the
  -- existing behavioural immutability tests keep matching it.
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
  THEN
    RAISE EXCEPTION 'invoices: snapshot columns are immutable once status != draft (row id=%)', OLD."invoice_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
