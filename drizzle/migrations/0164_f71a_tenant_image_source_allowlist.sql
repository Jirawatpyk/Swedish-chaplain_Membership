-- ---------------------------------------------------------------------------
-- F7.1a US2 (T014 + T016) — tenant_image_source_allowlist table.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 2.3.
--
-- Per-tenant `<img src>` hostname allowlist. Body-HTML sanitiser
-- (Phase 4 T070 `validateImageSourceAllowlist`) checks every `<img>`
-- source hostname against this table; non-matching submissions are
-- rejected at submit boundary with `broadcast_body_image_source_unsafe`
-- (audit).
--
-- Defaults seeded per tenant by this migration:
--   1. The tenant's own asset domain
--   2. The email provider's CDN (Resend)
-- Both with `is_default=TRUE`. The remove() port (Phase 2 T022 +
-- Phase 4 T072) rejects removal of `is_default=TRUE` rows so the
-- platform invariant "every tenant can render its own assets + provider
-- CDN" never breaks via admin error.
--
-- Hostname format CHECK enforces RFC-1035 lowercase ASCII with at
-- least one dot (explicit hosts only — wildcards forbidden per FR-010).
-- Pattern matches the Drizzle schema CHECK.
--
-- Default seed values: for the current single-tenant deployment
-- (SweCham), the placeholder hostnames are:
--   - swecham.zyncdata.app (chamber asset domain — production frontend)
--   - resend.com           (Resend CDN root — TODO refine to a specific
--                            subdomain when Resend documents one)
-- Future tenant onboarding (F10) will seed equivalents per tenant.
-- ---------------------------------------------------------------------------

CREATE TABLE "tenant_image_source_allowlist" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           text NOT NULL,
  "hostname"            text NOT NULL,
  "is_default"          boolean NOT NULL DEFAULT false,
  "created_by_user_id"  uuid,
  "created_at"          timestamptz NOT NULL DEFAULT now(),

  -- RFC-1035 lowercase hostname format; at least one dot; no wildcards.
  CONSTRAINT "tenant_image_source_allowlist_hostname_format_check"
    CHECK ("hostname" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);--> statement-breakpoint

CREATE UNIQUE INDEX "tenant_image_source_allowlist_tenant_hostname_uniq"
  ON "tenant_image_source_allowlist" ("tenant_id", "hostname");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seed default allowlist entries for every existing tenant.
--
-- ON CONFLICT DO NOTHING — idempotent for re-application; safe if a
-- tenant was already onboarded with custom entries.
--
-- SweCham single-tenant deployment today: looks up the tenant slug
-- from `tenants` table. If `tenants` is empty (fresh dev DB), the
-- INSERT is a no-op — defaults will seed at first-tenant creation
-- via a separate onboarding flow (F10).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t_id text;
BEGIN
  FOR t_id IN SELECT id::text FROM tenants LOOP
    INSERT INTO tenant_image_source_allowlist
      (tenant_id, hostname, is_default)
    VALUES
      (t_id, 'swecham.zyncdata.app', TRUE),
      (t_id, 'resend.com',           TRUE)
    ON CONFLICT ("tenant_id", "hostname") DO NOTHING;
  END LOOP;
END $$;--> statement-breakpoint
