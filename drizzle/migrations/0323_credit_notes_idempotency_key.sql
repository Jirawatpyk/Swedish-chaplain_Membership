-- ---------------------------------------------------------------------------
-- Migration 0323 — `credit_notes.idempotency_key`: an admin credit note is
-- issued once per issue attempt (task #66, follow-up from #727).
--
-- Only a refund-origin credit note was idempotent (`source_refund_id` +
-- `credit_notes_source_refund_id_uniq`, 0242). An admin note had no key: after
-- an unknown outcome (a dropped response, a 504) a retry passed the remainder
-- check and minted a SECOND §86/10 note with a new §87 number. The admin form
-- now sends one uuid per issue attempt; the use case answers a repeat with the
-- note it already issued.
--
-- 1. `idempotency_key uuid NULL` — NULL for refund-origin and legacy rows.
-- 2. Partial UNIQUE (tenant_id, idempotency_key) WHERE NOT NULL — the DB
--    backstop for two concurrent attempts with one key (the loser's 23505
--    reconciles to the winner).
-- 3. `credit_notes_enforce_immutability` += `idempotency_key` in BOTH branches.
--    Reproduces 0307's body EXACTLY plus the new column; search_path is
--    re-declared inline because CREATE OR REPLACE resets per-function config
--    (0205/0206/0227/0273 gotcha). Same OID — no trigger re-binding.
--
-- Safe before the code that uses it deploys: the column is nullable, the old
-- code never writes or reads it, and every existing row is NULL (the index
-- skips them). Rollback: a forward-fix migration (drop the index + column after
-- the code stops sending the key).
-- ---------------------------------------------------------------------------

ALTER TABLE "credit_notes" ADD COLUMN IF NOT EXISTS "idempotency_key" uuid;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "credit_notes_tenant_idempotency_key_uniq"
  ON "credit_notes" ("tenant_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
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
       -- `idempotency_key` (0323): the admin issue attempt this note answers;
       -- a replay looks it up, so it must never move.
       OR NEW."idempotency_key"         IS DISTINCT FROM OLD."idempotency_key"
    THEN
      RAISE EXCEPTION 'credit_notes: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."credit_note_id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Normal path (GUC unset) — UNCHANGED lock set from migration 0027, PLUS the
  -- pii_blob_purged_at marker (0227), retains_coverage (0272),
  -- membership_effect (0306) and idempotency_key (0323). The original
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
     OR NEW."idempotency_key"        IS DISTINCT FROM OLD."idempotency_key"
  THEN
    RAISE EXCEPTION 'credit_notes: snapshot + money + pdf columns are immutable from INSERT (row id=%)', OLD."credit_note_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
