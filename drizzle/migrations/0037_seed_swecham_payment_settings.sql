-- ---------------------------------------------------------------------------
-- F5 — seed SweCham tenant_payment_settings row (T023 per tasks.md).
--
-- Single-tenant deployment: one row per tenant, SweCham = 'swecham'
-- (matches TENANT_SLUG env). Processor values baked from dev .env.local:
--   - processor_account_id    = acct_1SDjN42HOqs9a0JA (Stripe dashboard)
--   - processor_publishable_key = pk_test_… (client-safe per Stripe docs)
--
-- If the Stripe dev account or publishable key rotates, run an app-layer
-- UPDATE via the admin settings UI (F5 US6) rather than editing this
-- migration. Production (live-mode) values are set via Vercel env → app
-- layer at first deploy.
--
-- Idempotent: ON CONFLICT DO NOTHING so re-running is a no-op.
--
-- Notes on secrets: Stripe publishable keys (pk_test_/pk_live_) are
-- deliberately client-safe per Stripe docs — not secret. Storing them
-- here is fine. Secret keys (sk_*) + webhook secrets (whsec_*) are NEVER
-- stored in the DB; env vars only (Constitution Principle IV).
-- ---------------------------------------------------------------------------

-- RLS note: migrations apply as the DB owner role (`neondb_owner` on Neon),
-- which is the TABLE OWNER for tenant_payment_settings. PostgreSQL table
-- owners bypass RLS by default (FORCE RLS applies only to non-owner
-- roles like `chamber_app`). No SET LOCAL app.current_tenant is required
-- here. Drizzle-migration-reviewer Issue 3 — confirmed against pg docs
-- "Row Security Policies are bypassed by superusers and roles with the
-- BYPASSRLS attribute, and by the owner of the table unless FORCE ROW
-- LEVEL SECURITY is enabled for the table" — note: FORCE RLS IS enabled
-- on our table, which SUBJECTS the owner to RLS too. To handle this
-- safely across ownership models we explicitly SET LOCAL in the SAME
-- statement block as the INSERT (NO statement-breakpoint between them)
-- so both execute in the same implicit transaction.
SET LOCAL app.current_tenant = 'swecham';
INSERT INTO "tenant_payment_settings" (
  "tenant_id",
  "processor",
  "processor_environment",
  "processor_account_id",
  "processor_publishable_key",
  "enabled_methods",
  "online_payment_enabled",
  "auto_email_on_payment",
  "promptpay_qr_expiry_seconds",
  "allow_anonymous_paylink"
) VALUES (
  'swecham',
  'stripe',
  'test',
  'acct_1SDjN42HOqs9a0JA',
  'pk_test_51TPGJDQ4m6l8PdqxQvWCVHg61SYZ5Ay2pCp21NeHittfrnRBg3mcrsbd4O2vqMqs2WyyKTs9Yb17BDlDjzCCJYal00G3wxTyy6',
  ARRAY['card','promptpay']::text[],
  true,
  true,
  900,
  false
)
ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint
