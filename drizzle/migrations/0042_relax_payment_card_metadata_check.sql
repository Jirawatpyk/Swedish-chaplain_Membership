-- Relax payments_card_metadata_iff_card so method='card' rows with
-- status='pending' may carry NULL card metadata. Card metadata arrives
-- post-webhook when Stripe returns the charge details. Aligns DB with
-- the Domain invariant assertCardMetadataComplete (Group C T047).
--
-- Rationale: Group E E2 integration tests discovered the original CHECK
-- (migration 0033 line 95) blocks card-rail initiate. Before this
-- migration, only promptpay inserts pass; after, both card+pending
-- (NULL metadata) and card+succeeded (NOT NULL metadata) pass.

-- Drizzle-reviewer follow-up #3 (2026-04-24): use IF EXISTS on the DROP so
-- a branch reset that re-runs this migration does not fail with
-- "constraint does not exist". Drizzle's _journal.json normally prevents
-- re-apply but this guard is cheap belt-and-braces for local dev + CI
-- environments that wipe + replay migrations.
ALTER TABLE "payments"
  DROP CONSTRAINT IF EXISTS "payments_card_metadata_iff_card";

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_metadata_iff_card"
  CHECK (
    (
      "method" = 'card'
      AND "status" = 'pending'
      AND "card_brand" IS NULL
      AND "card_last4" IS NULL
      AND "card_exp_month" IS NULL
      AND "card_exp_year" IS NULL
    )
    OR (
      "method" = 'card'
      AND "status" <> 'pending'
      AND "card_brand" IS NOT NULL
      AND "card_last4" IS NOT NULL
      AND "card_exp_month" IS NOT NULL
      AND "card_exp_year" IS NOT NULL
    )
    OR (
      "method" = 'promptpay'
      AND "card_brand" IS NULL
      AND "card_last4" IS NULL
      AND "card_exp_month" IS NULL
      AND "card_exp_year" IS NULL
    )
  );
