-- 054-event-fee-invoices (Task 7, Step 0) — relax `invoices_non_draft_has_snapshots`
-- so an ISSUED event-fee invoice can satisfy the non-draft snapshot CHECK.
--
-- WHY:
--   The live CHECK (migration 0024) requires the FULL 16-field snapshot/numbering
--   set on EVERY non-draft row. That set includes `pro_rate_policy_snapshot`,
--   which is a MEMBERSHIP-only concept — pro-rating a membership cycle. An event-
--   fee invoice has no membership cycle to pro-rate, so it CANNOT (and must not)
--   populate that field. Without this relaxation the FIRST event invoice ISSUE
--   throws Postgres 23514 on `invoices_non_draft_has_snapshots`.
--
-- WHAT CHANGES (single field relaxed; all others stay required for BOTH subjects):
--   - `pro_rate_policy_snapshot IS NOT NULL`  →  conditional:
--         (pro_rate_policy_snapshot IS NOT NULL OR invoice_subject = 'event')
--     i.e. still required for `'membership'`, exempt for `'event'`.
--
-- WHAT STAYS REQUIRED FOR EVENT TOO (populated by issue-invoice, Task 7 Step 3):
--   subtotal_satang, vat_rate_snapshot, vat_satang, total_satang  (computed at issue),
--   fiscal_year, sequence_number, document_number                 (event invoices ARE §87-numbered),
--   issue_date, due_date, net_days_snapshot                       (from tenant settings, same as membership),
--   tenant_identity_snapshot                                      (seller identity, universal),
--   member_identity_snapshot                                      (BUYER snapshot — pinned at draft for
--                                                                   non-members, at issue for matched members; REQUIRED),
--   pdf_blob_key, pdf_sha256, pdf_template_version                (event invoices ARE PDF'd).
--
-- A NULL `member_identity_snapshot` on a non-draft event row STILL FAILS — the
-- buyer snapshot is mandatory for the §86/4 tax document regardless of subject.
--
-- Idempotent DO-block style (mirrors migration 0201). DROP IF EXISTS + re-ADD so
-- a re-run lands the same final predicate.

DO $$
BEGIN
  ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_non_draft_has_snapshots";

  ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_non_draft_has_snapshots"
    CHECK (
      status = 'draft'
      OR (
        subtotal_satang IS NOT NULL
        AND vat_rate_snapshot IS NOT NULL
        AND vat_satang IS NOT NULL
        AND total_satang IS NOT NULL
        AND fiscal_year IS NOT NULL
        AND sequence_number IS NOT NULL
        AND document_number IS NOT NULL
        AND issue_date IS NOT NULL
        AND due_date IS NOT NULL
        -- Membership-only: pro-rating has no meaning for an event ticket fee.
        AND (pro_rate_policy_snapshot IS NOT NULL OR invoice_subject = 'event')
        AND net_days_snapshot IS NOT NULL
        AND tenant_identity_snapshot IS NOT NULL
        AND member_identity_snapshot IS NOT NULL
        AND pdf_blob_key IS NOT NULL
        AND pdf_sha256 IS NOT NULL
        AND pdf_template_version IS NOT NULL
      )
    );
END $$;
