-- M1 (plan-change-ux, Option 1b) — lock `credit_notes.retains_coverage` in the
-- append-only immutability trigger.
--
-- WHY: `credit_notes_enforce_immutability` (last redefined in migration 0227) is
-- an ALLOW-LIST-BY-OMISSION guard: any column NOT named in its lock list is
-- silently MUTABLE. Migration 0272 added `retains_coverage` — a WRITE-ONCE money
-- signal that drives the renewal effective-paid coverage predicate (retract vs
-- RETAIN a fully-credited period) — but it was NOT added to the trigger's lock
-- list, so a stray UPDATE could flip a member's coverage frontier after issue.
-- Its column comment already claims "WRITE-ONCE at INSERT"; this migration makes
-- the DB enforce that claim (precedent: 0227 locked `source_refund_id` +
-- `pii_blob_purged_at` the same way).
--
-- WHAT: CREATE OR REPLACE the trigger function reproducing 0227's body EXACTLY,
-- adding to BOTH branches (the GUC-exempt redaction branch AND the normal branch):
--   OR NEW."retains_coverage" IS DISTINCT FROM OLD."retains_coverage"
-- The redaction cron only SETs `member_identity_snapshot` + `pii_blob_purged_at`,
-- so for its UPDATE OLD.retains_coverage = NEW.retains_coverage → the new clause
-- is FALSE → no RAISE → the cron is unaffected. Locking it under the GUC too is
-- defence-in-depth (parity with `source_refund_id`).
--
-- SEARCH-PATH HARDENING: CREATE OR REPLACE FUNCTION RESETS the per-function
-- config set via ALTER FUNCTION (migration 0124 set search_path). Re-declare it
-- INLINE so the hardening survives (mirrors 0205/0206/0227; the documented
-- gotcha). No trigger re-binding needed — CREATE OR REPLACE keeps the same OID.
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
    THEN
      RAISE EXCEPTION 'credit_notes: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."credit_note_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — UNCHANGED lock set from migration 0027, PLUS the
  -- pii_blob_purged_at marker (0227) and retains_coverage (0272). The original
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
  THEN
    RAISE EXCEPTION 'credit_notes: snapshot + money + pdf columns are immutable from INSERT (row id=%)', OLD."credit_note_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
