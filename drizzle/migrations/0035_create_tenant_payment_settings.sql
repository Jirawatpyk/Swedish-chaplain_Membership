-- ---------------------------------------------------------------------------
-- F5 — tenant_payment_settings table (T021 per specs/009-online-payment/tasks.md).
--
-- Per-tenant F5 configuration: processor env, account id, publishable key,
-- enabled methods, kill switch. PK = tenant_id (one row per tenant).
--
-- Source of truth: specs/009-online-payment/data-model.md § 4.
-- Secrets (stripe_secret_key, webhook_secret) are NOT stored here — env
-- vars only (Constitution Principle IV).
-- ---------------------------------------------------------------------------

CREATE TABLE "tenant_payment_settings" (
  "tenant_id"                       text NOT NULL,
  "processor"                       text NOT NULL,
  "processor_environment"           text NOT NULL,
  "processor_account_id"            text NOT NULL,
  "processor_publishable_key"       text NOT NULL,
  "enabled_methods"                 text[] NOT NULL,
  "online_payment_enabled"          boolean NOT NULL DEFAULT true,
  "auto_email_on_payment"           boolean NOT NULL DEFAULT true,
  "promptpay_qr_expiry_seconds"     integer NOT NULL DEFAULT 900,
  "allow_anonymous_paylink"         boolean NOT NULL DEFAULT false,
  "created_at"                      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"                      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_payment_settings_pkey" PRIMARY KEY ("tenant_id")
);--> statement-breakpoint

-- --- Foreign keys -----------------------------------------------------------
--
-- No FK to `tenants(id)` — there is no physical `tenants` table until F10;
-- tenant identity lives in env (`TENANT_SLUG`) per F2+F3+F4 precedent
-- (see drizzle/migrations/0019_invoicing_tables.sql header comment).
-- RLS is the isolation primitive; FK would fail to apply.

-- --- CHECK constraints (data-model.md § 4.3) --------------------------------

ALTER TABLE "tenant_payment_settings"
  ADD CONSTRAINT "tenant_payment_settings_processor_enum"
  CHECK ("processor" IN ('stripe'));--> statement-breakpoint

ALTER TABLE "tenant_payment_settings"
  ADD CONSTRAINT "tenant_payment_settings_env_enum"
  CHECK ("processor_environment" IN ('test','live'));--> statement-breakpoint

-- enabled_methods must contain at least one entry and be a subset of
-- {'card','promptpay'}. array_length returns NULL for empty arrays, so
-- COALESCE to 0 to reject them via the `>= 1` check.
ALTER TABLE "tenant_payment_settings"
  ADD CONSTRAINT "tenant_payment_settings_enabled_methods_nonempty"
  CHECK (COALESCE(array_length("enabled_methods", 1), 0) >= 1);--> statement-breakpoint

ALTER TABLE "tenant_payment_settings"
  ADD CONSTRAINT "tenant_payment_settings_enabled_methods_subset"
  CHECK ("enabled_methods" <@ ARRAY['card','promptpay']::text[]);--> statement-breakpoint

ALTER TABLE "tenant_payment_settings"
  ADD CONSTRAINT "tenant_payment_settings_promptpay_qr_range"
  CHECK ("promptpay_qr_expiry_seconds" BETWEEN 60 AND 1800);--> statement-breakpoint

-- --- Indexes (data-model.md § 4.2) ------------------------------------------

-- UNIQUE on processor_account_id — webhook tenant-resolution lookup.
-- processor is NOT NULL so the partial WHERE is effectively unconditional,
-- but we keep the shape matching data-model.md § 4.2 (forward-compat
-- should processor become nullable in a future optional-processor tenant).
CREATE UNIQUE INDEX "tenant_payment_settings_processor_account_id_uniq"
  ON "tenant_payment_settings" USING btree ("processor_account_id")
  WHERE "processor" IS NOT NULL;--> statement-breakpoint

-- --- chamber_app grants -----------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_payment_settings" TO chamber_app;--> statement-breakpoint

-- --- RLS --------------------------------------------------------------------

ALTER TABLE "tenant_payment_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_payment_settings" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_on_tenant_payment_settings"
  ON "tenant_payment_settings"
  FOR ALL
  TO chamber_app
  USING      ("tenant_id" = current_setting('app.current_tenant', TRUE))
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', TRUE));--> statement-breakpoint
