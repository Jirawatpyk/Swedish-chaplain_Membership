-- Fix `payments_card_metadata_iff_card` CHECK to accept the legitimate
-- canceled/failed lineage state where card metadata is NULL.
--
-- Background: Drizzle-reviewer follow-up #1 (Group E, 2026-04-24)
-- predicted this gap. Integration test
-- `tests/integration/payments/drizzle-payments-repo.test.ts`
-- ("migration 0042: card transitions pending → canceled with NULL card
-- metadata") reproduces the failure: under 0042's CHECK the row
-- violates the constraint because status='canceled' AND card_* IS NULL
-- matches none of 0042's three branches.
--
-- Legitimate flow:
--   1. Member clicks Pay-now → payments INSERT as card+pending+NULL
--      metadata (allowed by 0042).
--   2. Before Stripe webhook returns with card details, member cancels
--      (closes drawer / explicit cancel).
--   3. cancel-payment use-case UPDATEs status='canceled'. card_* is
--      still NULL because Stripe never returned charge details.
--   4. 0042 CHECK rejects: status<>'pending' + card_* NULL matches
--      neither "card + non-pending + NOT NULL" nor "card + pending +
--      NULL" branches.
--
-- Revised invariant (aligned with Domain `assertCardMetadataComplete`):
--   - promptpay: card_* always NULL.
--   - card rows are INTERNALLY CONSISTENT — either all 4 card_*
--     fields are NULL, or all 4 are NOT NULL.
--   - card + status IN succeeded-lineage (succeeded / partially_refunded
--     / refunded) MUST have card_* NOT NULL (the settled payment was
--     captured — card metadata is always available by this point).
--   - All other card states (pending / canceled / failed) may have
--     card_* NULL (Stripe hadn't returned yet OR the attempt never
--     reached capture).

ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "payments_card_metadata_iff_card";

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_metadata_iff_card"
  CHECK (
    -- promptpay: metadata strictly NULL (unchanged)
    (
      "method" = 'promptpay'
      AND "card_brand" IS NULL
      AND "card_last4" IS NULL
      AND "card_exp_month" IS NULL
      AND "card_exp_year" IS NULL
    )
    OR
    -- card rows: enforce internal consistency (all 4 NULL or all 4 NOT NULL)
    -- AND succeeded-lineage MUST be NOT NULL
    (
      "method" = 'card'
      AND (
        -- card + all metadata populated — valid for ANY status
        (
          "card_brand" IS NOT NULL
          AND "card_last4" IS NOT NULL
          AND "card_exp_month" IS NOT NULL
          AND "card_exp_year" IS NOT NULL
        )
        OR
        -- card + all metadata NULL — valid ONLY for non-succeeded-
        -- lineage (pending / failed / canceled). Succeeded, partially_
        -- refunded, and refunded MUST carry card metadata because they
        -- represent settled captures.
        (
          "status" IN ('pending', 'failed', 'canceled')
          AND "card_brand" IS NULL
          AND "card_last4" IS NULL
          AND "card_exp_month" IS NULL
          AND "card_exp_year" IS NULL
        )
      )
    )
  );
