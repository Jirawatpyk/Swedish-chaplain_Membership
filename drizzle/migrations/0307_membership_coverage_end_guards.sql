-- ---------------------------------------------------------------------------
-- Migration 0307 — guards for the 0306 end-membership-coverage columns.
--
-- A follow-up rather than an edit to 0306: 0306 is already applied on
-- migrated branches (preview deploys run migrations), and the migrator never
-- re-runs an applied file.
--
-- 1. `renewal_cycles.end_coverage_*` shape CHECKs. The refund id and invoice
--    id come as a pair — a half-set pair would read as a PLAIN request and
--    end coverage before the refund settles — and neither exists without
--    `end_coverage_requested_at`. Every writer (the coverage-end repo) already
--    writes them this way; these make the DB enforce it.
--
-- 2. `credit_notes_enforce_immutability` += `membership_effect`. It is a
--    WRITE-ONCE durable Keep / End decision the renewals reconcile backstop
--    acts on; the trigger is an allow-list-by-omission guard, so an unlisted
--    column is silently MUTABLE (the hazard 0273 closed for
--    `retains_coverage`). Reproduces 0273's body EXACTLY plus the new column
--    in BOTH branches; search_path is re-declared inline because CREATE OR
--    REPLACE resets per-function config (0205/0206/0227/0273 gotcha). Same
--    OID — no trigger re-binding.
--
-- The CHECKs validate existing rows (renewal_cycles is small; every row
-- satisfies both). Roll-forward-only note for 0306 applies here too — see
-- docs/runbooks/cron-jobs.md "Rolling back 0306".
-- ---------------------------------------------------------------------------

ALTER TABLE "renewal_cycles"
  ADD CONSTRAINT "renewal_cycles_end_coverage_refund_pair_check"
    CHECK (("end_coverage_refund_id" IS NULL) = ("end_coverage_invoice_id" IS NULL));
--> statement-breakpoint

ALTER TABLE "renewal_cycles"
  ADD CONSTRAINT "renewal_cycles_end_coverage_requested_check"
    CHECK ("end_coverage_requested_at" IS NOT NULL OR "end_coverage_refund_id" IS NULL);
--> statement-breakpoint

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
       -- `retains_coverage` (migration 0272) is a WRITE-ONCE money signal driving
       -- the renewal effective-paid coverage predicate. Same allow-list-by-omission
       -- hazard as source_refund_id — LOCK it under the GUC too. The redaction cron
       -- never touches it (OLD = NEW → no RAISE), so this does not affect redaction.
       OR NEW."retains_coverage"        IS DISTINCT FROM OLD."retains_coverage"
       -- `membership_effect` (0306): write-once durable End decision.
       OR NEW."membership_effect"       IS DISTINCT FROM OLD."membership_effect"
    THEN
      RAISE EXCEPTION 'credit_notes: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."credit_note_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — UNCHANGED lock set from migration 0027, PLUS the
  -- pii_blob_purged_at marker (0227), retains_coverage (0272) and
  -- membership_effect (0306). The original
  -- message is preserved so existing credit-note immutability tests match.
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
     OR NEW."retains_coverage"       IS DISTINCT FROM OLD."retains_coverage"
     OR NEW."membership_effect"      IS DISTINCT FROM OLD."membership_effect"
  THEN
    RAISE EXCEPTION 'credit_notes: snapshot + money + pdf columns are immutable from INSERT (row id=%)', OLD."credit_note_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
