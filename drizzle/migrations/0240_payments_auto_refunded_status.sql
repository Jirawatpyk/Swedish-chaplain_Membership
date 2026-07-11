-- 0240 — F5 auto_refunded terminal payment status + durable auto-refund marker.
-- Widens payments_status_enum + card-metadata CHECK; adds the auto-refund
-- processor-refund-id column (durable A4b lookup key) + partial unique index.

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_status_enum";--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_enum"
  CHECK ("status" IN ('pending','succeeded','failed','canceled','partially_refunded','refunded','auto_refunded'));--> statement-breakpoint

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_card_metadata_iff_card";--> statement-breakpoint
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_metadata_iff_card"
  CHECK (
    ("method" = 'promptpay' AND "card_brand" IS NULL AND "card_last4" IS NULL
      AND "card_exp_month" IS NULL AND "card_exp_year" IS NULL)
    OR
    ("method" = 'card' AND (
      ("card_brand" IS NOT NULL AND "card_last4" IS NOT NULL
        AND "card_exp_month" IS NOT NULL AND "card_exp_year" IS NOT NULL)
      OR
      ("status" IN ('pending','failed','canceled','auto_refunded')
        AND "card_brand" IS NULL AND "card_last4" IS NULL
        AND "card_exp_month" IS NULL AND "card_exp_year" IS NULL)
    ))
  );--> statement-breakpoint

ALTER TABLE "payments" ADD COLUMN "auto_refund_processor_refund_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_auto_refund_processor_refund_id_uniq"
  ON "payments" ("tenant_id","auto_refund_processor_refund_id")
  WHERE "auto_refund_processor_refund_id" IS NOT NULL;--> statement-breakpoint
