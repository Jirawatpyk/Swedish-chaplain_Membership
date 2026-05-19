-- ---------------------------------------------------------------------------
-- F7.1a US1 (T015 + T016) — tenant_broadcast_settings table.
--
-- Source of truth: specs/014-email-broadcast-advance/data-model.md § 2.5
-- + plan.md Risk R2 (the data-model phrases this as "EXTEND F7 MVP table"
-- but the table did NOT exist in F7 MVP — grep across src/modules/
-- broadcasts/** + drizzle/migrations/** confirms zero occurrences).
-- F7.1a CREATES the table here; future F7.1b enhancements (per-tenant
-- complaint thresholds, throttle overrides, etc.) add columns.
--
-- Currently houses only `dispatch_concurrency_cap` per FR-002:
--   - tenant-configurable in 1-8 range
--   - default 4 (safe for shared Resend account-level rate limit pool)
--   - read by Phase 3 T046 BatchDispatcher
--
-- One row per tenant — `tenant_id` is the primary key. Seeded
-- per-tenant by future onboarding (F10) OR lazily by the
-- BatchDispatcher's defaults fallback (Phase 3 T046).
-- ---------------------------------------------------------------------------

CREATE TABLE "tenant_broadcast_settings" (
  "tenant_id"                  text PRIMARY KEY,
  "dispatch_concurrency_cap"   integer NOT NULL DEFAULT 4,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "tenant_broadcast_settings_dispatch_concurrency_cap_check"
    CHECK ("dispatch_concurrency_cap" BETWEEN 1 AND 8)
);--> statement-breakpoint
