-- ---------------------------------------------------------------------------
-- F5 — refunds table (T020 per specs/009-online-payment/tasks.md).
--
-- One row per refund attempt against a succeeded Payment. Multiple
-- succeeded refunds per Payment accumulate toward payment.amount_satang
-- (FR-011b invariant enforced in use-case, not SQL — requires row-level
-- lock on payments).
--
-- Source of truth: specs/009-online-payment/data-model.md § 3.
-- invoice_id + credit_note_id typed to match F4 (uuid); refund owns a
-- TEXT ULID PK; payment_id references payments.id (TEXT).
-- ---------------------------------------------------------------------------

CREATE TABLE "refunds" (
  "id"                    text NOT NULL,
  "tenant_id"             text NOT NULL,
  "payment_id"            text NOT NULL,
  "invoice_id"            uuid NOT NULL,
  "amount_satang"         bigint NOT NULL,
  "reason"                text NOT NULL,
  "status"                text NOT NULL,
  "processor_refund_id"   text,
  "failure_reason_code"   text,
  "credit_note_id"        uuid,
  "initiated_at"          timestamp with time zone NOT NULL,
  "completed_at"          timestamp with time zone,
  "initiator_user_id"     uuid NOT NULL,
  "correlation_id"        text NOT NULL,
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"            timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint

-- --- Foreign keys -----------------------------------------------------------

-- payment_id references payments.id (single-column; payments PK is id TEXT).
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_payment_fk"
  FOREIGN KEY ("payment_id")
  REFERENCES "payments" ("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- invoice_id is denormalised from payment for admin query efficiency;
-- composite FK ensures cross-tenant invoice mismatch is rejected by DB.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_invoice_tenant_fk"
  FOREIGN KEY ("tenant_id","invoice_id")
  REFERENCES "invoices" ("tenant_id","invoice_id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- credit_note_id FK — nullable until the refund succeeds + the F5 → F4
-- bridge creates the CN. Composite because credit_notes uses (tenant_id, id).
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_credit_note_tenant_fk"
  FOREIGN KEY ("tenant_id","credit_note_id")
  REFERENCES "credit_notes" ("tenant_id","credit_note_id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_initiator_user_fk"
  FOREIGN KEY ("initiator_user_id")
  REFERENCES "users" ("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;--> statement-breakpoint

-- --- CHECK constraints (data-model.md § 3.3) --------------------------------

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive"
  CHECK ("amount_satang" > 0);--> statement-breakpoint

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_status_enum"
  CHECK ("status" IN ('pending','succeeded','failed'));--> statement-breakpoint

-- succeeded ⇔ processor_refund_id IS NOT NULL AND credit_note_id IS NOT NULL.
-- This is a true biconditional: if status='succeeded' BOTH ids MUST be set,
-- and if status != 'succeeded' at LEAST ONE id must be NULL. Without the
-- reverse direction, a 'pending' or 'failed' row could sneak in with both
-- ids populated, violating the invariant that credit_note_id is only
-- written on the success transition.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_succeeded_iff_complete"
  CHECK (
    ("status" = 'succeeded') =
    ("processor_refund_id" IS NOT NULL AND "credit_note_id" IS NOT NULL)
  );--> statement-breakpoint

-- failed ⇔ failure_reason_code IS NOT NULL.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_failed_iff_reason"
  CHECK (
    ("status" = 'failed' AND "failure_reason_code" IS NOT NULL)
    OR
    ("status" <> 'failed' AND "failure_reason_code" IS NULL)
  );--> statement-breakpoint

-- pending ⇔ completed_at IS NULL.
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_completed_at_iff_not_pending"
  CHECK (
    ("status" = 'pending' AND "completed_at" IS NULL)
    OR
    ("status" <> 'pending' AND "completed_at" IS NOT NULL)
  );--> statement-breakpoint

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_reason_length"
  CHECK (char_length("reason") BETWEEN 1 AND 500);--> statement-breakpoint

-- --- Indexes (data-model.md § 3.2) ------------------------------------------

-- Partial UNIQUE on processor_refund_id — pending rows share NULL.
CREATE UNIQUE INDEX "refunds_processor_refund_id_uniq"
  ON "refunds" USING btree ("processor_refund_id")
  WHERE "processor_refund_id" IS NOT NULL;--> statement-breakpoint

-- Remaining-refundable calculation accelerator.
CREATE INDEX "refunds_tenant_payment_status_idx"
  ON "refunds" USING btree ("tenant_id","payment_id","status");--> statement-breakpoint

-- Admin invoice → refund history view.
CREATE INDEX "refunds_tenant_invoice_status_idx"
  ON "refunds" USING btree ("tenant_id","invoice_id","status");--> statement-breakpoint

-- Credit-note reverse lookup (partial — only rows that materialised a CN).
CREATE INDEX "refunds_credit_note_id_idx"
  ON "refunds" USING btree ("credit_note_id")
  WHERE "credit_note_id" IS NOT NULL;--> statement-breakpoint

-- --- chamber_app grants -----------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "refunds" TO chamber_app;--> statement-breakpoint

-- --- RLS --------------------------------------------------------------------

ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refunds" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_refunds"
  ON "refunds"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint
