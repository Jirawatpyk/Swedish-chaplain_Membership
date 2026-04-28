-- ---------------------------------------------------------------------------
-- F5 — payments table (T019 per specs/009-online-payment/tasks.md).
--
-- Stores one row per Stripe PaymentIntent attempt. An invoice may have
-- multiple rows over time (retries after failure); a partial UNIQUE index
-- enforces "at most one non-terminal payment per invoice".
--
-- Source of truth: specs/009-online-payment/data-model.md § 2.
-- FK types follow F4 precedent (invoice_id/member_id = uuid matching
-- invoices/members composite PKs, actor_user_id = uuid matching users.id).
-- Main-agent Gate Decision #4: TEXT ULID single-col PK for F5 own tables;
-- composite FKs TO F4 tables.
--
-- NOTE: data-model.md § 2.1 lists `invoice_id TEXT` / `member_id TEXT` —
-- those are typos. F4/F3 columns are uuid; matching types is required
-- for the composite FK to link. We use uuid and record the deviation
-- in plan.md § Complexity Tracking (pending).
-- ---------------------------------------------------------------------------

-- --- 1. payments table ------------------------------------------------------

CREATE TABLE "payments" (
  "id"                            text NOT NULL,
  "tenant_id"                     text NOT NULL,
  "invoice_id"                    uuid NOT NULL,
  "member_id"                     uuid NOT NULL,
  "method"                        text NOT NULL,
  "status"                        text NOT NULL,
  "amount_satang"                 bigint NOT NULL,
  "currency"                      text NOT NULL DEFAULT 'THB',
  "processor_payment_intent_id"   text NOT NULL,
  "processor_charge_id"           text,
  "processor_environment"         text NOT NULL,
  "attempt_seq"                   integer NOT NULL DEFAULT 1,
  "card_brand"                    text,
  "card_last4"                    text,
  "card_exp_month"                smallint,
  "card_exp_year"                 smallint,
  "failure_reason_code"           text,
  "initiated_at"                  timestamp with time zone NOT NULL,
  "completed_at"                  timestamp with time zone,
  "actor_user_id"                 uuid NOT NULL,
  "correlation_id"                text NOT NULL,
  "created_at"                    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                    timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint

-- --- 2. Foreign keys (composite to F4, single-col to F3/F1) -----------------

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_invoice_tenant_fk"
  FOREIGN KEY ("tenant_id","invoice_id")
  REFERENCES "invoices" ("tenant_id","invoice_id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_member_tenant_fk"
  FOREIGN KEY ("tenant_id","member_id")
  REFERENCES "members" ("tenant_id","member_id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_actor_user_fk"
  FOREIGN KEY ("actor_user_id")
  REFERENCES "users" ("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- --- 3. CHECK constraints (data-model.md § 2.3) -----------------------------

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive"
  CHECK ("amount_satang" > 0);--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_currency_thb"
  CHECK ("currency" = 'THB');--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_method_enum"
  CHECK ("method" IN ('card','promptpay'));--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_status_enum"
  CHECK ("status" IN ('pending','succeeded','failed','canceled','partially_refunded','refunded'));--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_processor_env_enum"
  CHECK ("processor_environment" IN ('test','live'));--> statement-breakpoint

-- Card metadata required on card rows, forbidden on promptpay rows.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_metadata_iff_card"
  CHECK (
    (
      "method" = 'card' AND
      "card_brand" IS NOT NULL AND
      "card_last4" IS NOT NULL AND
      "card_exp_month" IS NOT NULL AND
      "card_exp_year" IS NOT NULL
    )
    OR
    (
      "method" = 'promptpay' AND
      "card_brand" IS NULL AND
      "card_last4" IS NULL AND
      "card_exp_month" IS NULL AND
      "card_exp_year" IS NULL
    )
  );--> statement-breakpoint

-- Failed rows must carry a reason code.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_failed_has_reason"
  CHECK ("status" <> 'failed' OR "failure_reason_code" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_attempt_seq_positive"
  CHECK ("attempt_seq" >= 1);--> statement-breakpoint

-- pending ⇔ completed_at IS NULL; any terminal status has completed_at.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_completed_at_iff_not_pending"
  CHECK (
    ("status" = 'pending' AND "completed_at" IS NULL)
    OR
    ("status" <> 'pending' AND "completed_at" IS NOT NULL)
  );--> statement-breakpoint

-- card_last4 = 4-digit string when present.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_last4_length"
  CHECK ("card_last4" IS NULL OR "card_last4" ~ '^[0-9]{4}$');--> statement-breakpoint

-- card_exp_month 1-12 when present.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_exp_month_range"
  CHECK ("card_exp_month" IS NULL OR ("card_exp_month" BETWEEN 1 AND 12));--> statement-breakpoint

-- card_exp_year 4-digit (2000-2099 is generous; Stripe returns YYYY).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_card_exp_year_range"
  CHECK ("card_exp_year" IS NULL OR ("card_exp_year" BETWEEN 2000 AND 2099));--> statement-breakpoint

-- --- 4. Indexes (data-model.md § 2.2) ---------------------------------------

CREATE UNIQUE INDEX "payments_processor_payment_intent_id_uniq"
  ON "payments" USING btree ("processor_payment_intent_id");--> statement-breakpoint

CREATE INDEX "payments_tenant_invoice_status_idx"
  ON "payments" USING btree ("tenant_id","invoice_id","status");--> statement-breakpoint

CREATE INDEX "payments_tenant_created_at_desc_idx"
  ON "payments" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint

CREATE INDEX "payments_processor_charge_id_idx"
  ON "payments" USING btree ("processor_charge_id")
  WHERE "processor_charge_id" IS NOT NULL;--> statement-breakpoint

-- Partial UNIQUE — at most one non-terminal Payment per invoice.
-- Failed/canceled/refunded rows are OUTSIDE this index so a new attempt
-- after failure is permitted.
CREATE UNIQUE INDEX "payments_one_active_per_invoice"
  ON "payments" USING btree ("tenant_id","invoice_id","status")
  WHERE "status" IN ('pending','succeeded','partially_refunded');--> statement-breakpoint

-- --- 5. chamber_app grants --------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payments" TO chamber_app;--> statement-breakpoint

-- --- 6. Row-Level Security (Constitution v1.4.0 Principle I clause 2) -------

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_payments"
  ON "payments"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint
