-- 064 — tenant SHORT / brand name for the §86/4 membership line prefix.
--
-- The membership line-item now reads "{brand} {plan} Membership Fee {year}
-- ({period})" (e.g. "SweCham Regular Corporate Membership Fee 2026 (August 2026 -
-- July 2027)"). The brand is the tenant's short name, DISTINCT from the full
-- registered legal_name_* (which prints in the document header). Nullable — when
-- unset the prefix is simply omitted. The admin sets it via the invoicing
-- settings form.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS). RLS: tenant_invoice_settings
-- is per-tenant row-level; the new column inherits the existing policy.
ALTER TABLE "tenant_invoice_settings"
  ADD COLUMN IF NOT EXISTS "brand_name" text;--> statement-breakpoint
