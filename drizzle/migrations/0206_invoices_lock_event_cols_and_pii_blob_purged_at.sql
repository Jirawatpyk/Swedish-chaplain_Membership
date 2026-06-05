-- 054-event-fee-invoices (code-review HIGH-2 + HIGH-3) — lock the four event
-- discriminator/identity columns in the immutability trigger AND add a
-- retryable PDF-blob purge marker (`pii_blob_purged_at`) so the GDPR Art.17
-- erasure of the issued §86/4 PDF bytes survives a crash between commit and
-- purge.
--
-- ── HIGH-2: the immutability trigger never locked the 4 new event columns ────
--   Migration 0201 added `invoice_subject`, `event_id`, `event_registration_id`
--   and `vat_inclusive`, but its "no trigger change needed" note relied on the
--   APPLICATION layer never updating those columns post-draft. The trigger is
--   the DEFENCE-IN-DEPTH layer that must ENFORCE that invariant: without these
--   columns in the `IS DISTINCT FROM` lock list, a direct/regressed UPDATE on an
--   ISSUED invoice could silently flip its subject (`membership`↔`event`), its
--   event linkage, or its VAT-inclusive flag — i.e. change the very identity /
--   tax treatment of a numbered §86/4 document. They are identity/discriminator
--   columns and must be locked exactly like `member_id`/`plan_id`/`plan_year`.
--   For a membership invoice the two event_* columns stay NULL across the
--   lifecycle (`NULL IS DISTINCT FROM NULL` = FALSE → no false trip); for an
--   event invoice member_id/plan_id/plan_year stay NULL the same way — so adding
--   these locks does not break either subject's normal lifecycle.
--
-- ── HIGH-3: blob purge after commit was not retryable (GDPR Art.17 gap) ──────
--   The redaction cron tombstoned the snapshot + committed, THEN purged the PDF
--   blob bytes best-effort. A crash between commit and purge left PII-bearing
--   PDF bytes on Blob FOREVER, because the row was now tombstoned
--   (`legal_name='[REDACTED]'`) so the old predicate excluded it from the next
--   sweep — there was no second chance to retry the purge.
--   FIX: a new nullable marker column `pii_blob_purged_at`. The cron now selects
--   rows that are EITHER un-redacted OR redacted-but-purge-incomplete
--   (`pii_blob_purged_at IS NULL` with a blob key still present), purges the
--   bytes best-effort, and ONLY on a fully successful purge stamps
--   `pii_blob_purged_at = now()` via a separate UPDATE under the GUC. A crash
--   before that stamp leaves the marker NULL → the next sweep re-selects the row
--   and retries the purge (the snapshot is already tombstoned, so no PII is
--   re-exposed, and the audit is not re-emitted).
--
-- ── Trigger treatment of pii_blob_purged_at ─────────────────────────────────
--   NORMAL path: LOCKED (it is set only during redaction; no normal write path
--     may touch it).
--   GUC-exempt path (`app.allow_pii_redaction = 'true'`): EXEMPT — the marker is
--     stamped DURING redaction, under the GUC, alongside `member_identity_snapshot`.
--     So under the GUC exactly TWO columns may change — the buyer-PII tombstone
--     and this purge marker — and EVERY other snapshot / numbering / financial /
--     identity column (including the 4 event columns added by HIGH-2) still
--     RAISES.
--
-- ── SEARCH-PATH HARDENING ───────────────────────────────────────────────────
--   `CREATE OR REPLACE FUNCTION` RESETS any per-function config previously set
--   via `ALTER FUNCTION` (migration 0124 set `search_path = pg_catalog, public`).
--   We therefore re-declare `SET search_path = pg_catalog, public` INLINE on the
--   function so the hardening survives this replace (mirrors migration 0205).
--
-- ── DIFF vs 0205 (verifiable) ───────────────────────────────────────────────
--   This function body is migration 0205's body with ONLY additive changes:
--     * GUC-exempt branch: +4 locked checks (invoice_subject, event_id,
--       event_registration_id, vat_inclusive). `pii_blob_purged_at` is NOT
--       checked there → it is exempt under the GUC (alongside
--       member_identity_snapshot).
--     * Normal branch: +5 locked checks (the 4 event columns + pii_blob_purged_at).
--   No existing lock, the `member_identity_snapshot` GUC exemption, the
--   `OLD.status='draft'` early-return, the inline search_path, or either RAISE
--   message is removed or altered.

-- 1. The retryable purge marker. Nullable; set ONLY by the redaction cron after
--    a fully successful PDF-blob purge. NULL = purge not yet completed (the
--    natural state for every row pre-redaction and for a crashed mid-redaction).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "pii_blob_purged_at" timestamptz;--> statement-breakpoint

-- 2. CREATE OR REPLACE the immutability trigger function with the additive locks.
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
      RAISE EXCEPTION 'invoices: only member_identity_snapshot may change under PII redaction (row id=%)', OLD."invoice_id"
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
