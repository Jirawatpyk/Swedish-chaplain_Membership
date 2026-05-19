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
-- Defaults (chamber asset domain + Resend CDN) ARE NOT seeded by this
-- migration — the project has no central `tenants` table to iterate
-- (verified 2026-05-19 — tenant_id is a TEXT slug stored on each
-- tenant-scoped row, no parent table). Defaults are seeded lazily by
-- the runtime use case `manage-image-allowlist.ts` (Phase 4 T072) on
-- first admin visit to the allowlist editor — that use case INSERTs
-- the default rows if `is_default=TRUE` doesn't already exist for the
-- tenant. Idempotency by `(tenant_id, hostname)` unique index.
--
-- Hostname format CHECK enforces RFC-1035 lowercase ASCII with at
-- least one dot (explicit hosts only — wildcards forbidden per FR-010).
--
-- Phase 3F.8 (F-11 note, attribution corrected in Phase 3F.11.3) — the
-- CHECK rejects uppercase letters which means application-layer MUST
-- normalise to lowercase before insert. Phase 4 T072 `manage-image-
-- allowlist.ts` use case (NOT YET IMPLEMENTED) will be responsible for
-- `host.trim().toLowerCase()` at the boundary. Until T072 lands, admin
-- paste of mixed-case hostnames (e.g., `cdn.SweCham.com` from browser
-- bar) WILL 500 with a constraint violation — there is no app-layer
-- normalisation yet. The hostname-format CHECK is the only backstop.
-- IDN/punycode is out of scope (FR-010 requires explicit exact-match
-- hosts; international domains expressed as ASCII punycode).
--
-- Idempotency: IF NOT EXISTS on CREATE TABLE + CREATE UNIQUE INDEX —
-- 2026-05-19 first-apply attempt left the table created but the seed
-- DO-block crashed on `FROM tenants` (table doesn't exist), so this
-- migration must be safe to re-apply over the partial state.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "tenant_image_source_allowlist" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_image_source_allowlist_tenant_hostname_uniq"
  ON "tenant_image_source_allowlist" ("tenant_id", "hostname");--> statement-breakpoint
