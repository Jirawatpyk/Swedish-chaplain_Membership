-- T120 — add `tenant_invoice_settings_cross_tenant_probe` audit event type.
-- Emitted when the PATCH /api/tenant-invoice-settings handler detects a
-- host-header / session-bound-tenant mismatch. In STD deployment today
-- the resolver hard-codes to `env.tenant.slug` so a mismatch is
-- impossible in practice — the probe exists as MTA-readiness defense:
-- when F10 multi-tenant rolls out with subdomain / session-claim
-- resolution, a tenant-slug mismatch (e.g. a SweCham admin session
-- posting to a TSCC-host-header request) lands here for forensic.

DO $$ BEGIN
  ALTER TYPE "audit_event_type" ADD VALUE 'tenant_invoice_settings_cross_tenant_probe';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
